import { Router } from 'express'
import { db } from '../../db/index.js'
import { campaignInputSchema } from './schemas.js'
import { mediaUpload, getMediaSignedUrl } from '../../lib/mediaUpload.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import {
  getConnectedSessionsForOrganization,
  getConnectedSocketForSession,
  maskPhoneNumber
} from '../../whatsapp/connectionManager.js'
import { enqueueSendJob, cancelSendJob } from '../../queue/boss.js'
import { resolveBatchRecipients, resolveMedia } from '../messages/shared.js'
import { campaignEvents } from '../../queue/campaignProgress.js'

export const campaignsRouter = Router()

async function loadFormData(organizationId: number | undefined) {
  let batchesQuery = db.selectFrom('batches').selectAll().orderBy('name', 'asc')
  let templatesQuery = db.selectFrom('message_templates').selectAll().orderBy('name', 'asc')
  if (organizationId !== undefined) {
    batchesQuery = batchesQuery.where('organization_id', '=', organizationId)
    templatesQuery = templatesQuery.where('organization_id', '=', organizationId)
  }
  const [batches, templateRows] = await Promise.all([batchesQuery.execute(), templatesQuery.execute()])
  const templates = await Promise.all(
    templateRows.map(async (t) => ({ ...t, mediaUrl: t.media_path ? await getMediaSignedUrl(t.media_path) : null }))
  )
  // Only sessions that are connected right now can be picked as the sender.
  const sessions =
    organizationId === undefined
      ? []
      : getConnectedSessionsForOrganization(organizationId).map((s) => ({
          id: s.sessionId,
          label: s.label,
          phoneNumber: maskPhoneNumber(s.phoneNumber),
          isPrimary: s.isPrimary
        }))
  return { batches, templates, sessions }
}

campaignsRouter.get('/campaigns', async (req, res) => {
  const organizationId = req.user?.organizationId ?? undefined
  let query = db.selectFrom('campaigns').selectAll().orderBy('created_at', 'desc')
  if (organizationId !== undefined) query = query.where('organization_id', '=', organizationId)
  const campaigns = await query.execute()
  res.json({ campaigns })
})

campaignsRouter.get('/campaigns/new', async (req, res) => {
  const formData = await loadFormData(req.user?.organizationId ?? undefined)
  res.json(formData)
})

campaignsRouter.post('/campaigns', mediaUpload.single('file'), async (req, res) => {
  const parsed = campaignInputSchema.safeParse(req.body)

  const fail = (error: string) => {
    res.status(400).json({ error })
  }

  if (!parsed.success) {
    fail(parsed.error.issues[0]?.message ?? 'Invalid input.')
    return
  }

  const organizationId = req.user?.organizationId
  if (!organizationId) {
    fail('Only an organization account can create campaigns.')
    return
  }

  const {
    name,
    batch_id,
    template_id,
    message_type,
    message_text,
    scheduled_date,
    scheduled_time,
    whatsapp_session_id,
    min_delay_ms,
    max_delay_ms
  } = parsed.data

  // Never trust batch_id from the request body at face value — it must be
  // one of this organization's own batches.
  const batch = await db
    .selectFrom('batches')
    .select(['id', 'contact_count'])
    .where('id', '=', batch_id)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!batch) {
    fail('Choose a valid batch.')
    return
  }
  if (batch.contact_count === 0) {
    fail('That batch has no contacts yet.')
    return
  }

  if (message_type === 'text' && !message_text) {
    fail('Enter a message.')
    return
  }

  const mediaResult = await resolveMedia(message_type, req.file, template_id, organizationId)
  if (!mediaResult.ok) {
    fail(mediaResult.error)
    return
  }

  let scheduledAt: Date | null = null
  if (scheduled_date && scheduled_time) {
    scheduledAt = new Date(`${scheduled_date}T${scheduled_time}`)
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now() + 30_000) {
      fail('Pick a future date and time, or leave both blank to send immediately.')
      return
    }
  }

  // Which linked WhatsApp sends this campaign. Never trust the id from the
  // request body: it must be one of this organization's own sessions that is
  // connected right now. With one connected session there is nothing to
  // choose; with several and no choice made, the primary (listed first) is used.
  const connectedSessions = getConnectedSessionsForOrganization(organizationId)
  if (connectedSessions.length === 0) {
    fail('WhatsApp is not connected. Connect it from the WhatsApp Connection page first.')
    return
  }
  let sender = connectedSessions[0]!
  if (whatsapp_session_id !== null) {
    const chosen = connectedSessions.find((s) => s.sessionId === whatsapp_session_id)
    if (!chosen) {
      fail('The selected WhatsApp is not connected right now. Choose a connected WhatsApp.')
      return
    }
    sender = chosen
  }
  const sock = getConnectedSocketForSession(sender.sessionId, organizationId)
  if (!sock) {
    fail('The selected WhatsApp is not connected right now. Choose a connected WhatsApp.')
    return
  }

  const { recipients, skipped } = await resolveBatchRecipients(sock, batch_id, organizationId)
  if (recipients.length === 0) {
    fail('No valid WhatsApp recipients were found in that batch.')
    return
  }

  const rateOverride =
    min_delay_ms || max_delay_ms
      ? { minDelayMs: min_delay_ms ?? undefined, maxDelayMs: max_delay_ms ?? undefined }
      : null

  const campaign = await db
    .insertInto('campaigns')
    .values({
      name,
      batch_id,
      template_id,
      message_type,
      message_text,
      media_path: mediaResult.media.mediaPath,
      status: scheduledAt ? 'scheduled' : 'sending',
      scheduled_at: scheduledAt,
      rate_limit_override: rateOverride,
      total_recipients: recipients.length,
      created_by: req.user?.id ?? null,
      started_at: scheduledAt ? null : new Date(),
      organization_id: organizationId,
      whatsapp_session_id: sender.sessionId
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  const initialStatus: 'scheduled' | 'queued' = scheduledAt ? 'scheduled' : 'queued'

  const inserted = await db
    .insertInto('messages')
    .values(
      recipients.map((r) => ({
        campaign_id: campaign.id,
        recipient_type: r.recipientType,
        recipient_contact_id: r.contactId,
        recipient_group_id: r.groupId,
        recipient_jid: r.jid,
        message_type,
        message_text,
        media_path: mediaResult.media.mediaPath,
        template_id,
        status: initialStatus,
        scheduled_at: scheduledAt,
        created_by: req.user?.id ?? null,
        organization_id: organizationId
      }))
    )
    .returning('id')
    .execute()

  for (const row of inserted) {
    const jobId = await enqueueSendJob(row.id, scheduledAt ? { startAfter: scheduledAt } : undefined)
    await db.updateTable('messages').set({ pg_boss_job_id: jobId }).where('id', '=', row.id).execute()
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'campaign_created',
    entityType: 'campaign',
    entityId: campaign.id,
    metadata: {
      recipientCount: recipients.length,
      skippedCount: skipped.length,
      scheduled: Boolean(scheduledAt),
      whatsappSessionId: sender.sessionId
    },
    ipAddress: req.ip
  })

  res.status(201).json({ id: campaign.id })
})

function computeProgress(campaign: {
  id: number
  name: string
  status: string
  total_recipients: number
  processed_count: number
  success_count: number
  failed_count: number
  scheduled_at: Date | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
}) {
  const pct = campaign.total_recipients > 0 ? Math.round((campaign.processed_count / campaign.total_recipients) * 100) : 0
  return { campaign, pct }
}

async function findOwnedCampaign(id: number, organizationId: number | undefined) {
  let query = db.selectFrom('campaigns').selectAll().where('id', '=', id)
  if (organizationId !== undefined) query = query.where('organization_id', '=', organizationId)
  return query.executeTakeFirst()
}

campaignsRouter.get('/campaigns/:id', async (req, res) => {
  const id = Number(req.params.id)
  const organizationId = req.user?.organizationId ?? undefined
  const campaign = await findOwnedCampaign(id, organizationId)
  if (!campaign) {
    res.status(404).json({ error: 'Campaign not found.' })
    return
  }

  const recentMessages = await db
    .selectFrom('messages')
    .selectAll()
    .where('campaign_id', '=', id)
    .orderBy('updated_at', 'desc')
    .limit(25)
    .execute()

  const { pct } = computeProgress(campaign)
  const mediaUrl = campaign.media_path ? await getMediaSignedUrl(campaign.media_path) : null

  // The WhatsApp number this campaign sends from (null for campaigns that
  // predate the choice — those use the primary session).
  const senderRow = campaign.whatsapp_session_id
    ? await db
        .selectFrom('whatsapp_sessions')
        .select(['label', 'phone_number'])
        .where('id', '=', campaign.whatsapp_session_id)
        .executeTakeFirst()
    : undefined
  const sender = senderRow ? { label: senderRow.label, phoneNumber: maskPhoneNumber(senderRow.phone_number) } : null

  res.json({ campaign: { ...campaign, mediaUrl }, progress: { pct }, recentMessages, sender })
})

async function loadProgressSnapshot(campaignId: number, organizationId: number | undefined) {
  const campaign = await findOwnedCampaign(campaignId, organizationId)
  if (!campaign) return null
  return computeProgress(campaign)
}

campaignsRouter.get('/campaigns/:id/stream', (req, res) => {
  const id = Number(req.params.id)
  // Captured once at stream setup — every subsequent tick re-checks the
  // campaign still belongs to this same organization before writing
  // anything to the response.
  const organizationId = req.user?.organizationId ?? undefined

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()

  const send = async () => {
    try {
      const snapshot = await loadProgressSnapshot(id, organizationId)
      if (!snapshot) return
      res.write(`event: message\ndata: ${JSON.stringify(snapshot)}\n\n`)
    } catch {
      // skip a tick on load error
    }
  }

  void send()

  const listener = (updatedId: number) => {
    if (updatedId === id) void send()
  }
  campaignEvents.on('update', listener)

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000)

  req.on('close', () => {
    clearInterval(heartbeat)
    campaignEvents.off('update', listener)
  })
})

campaignsRouter.post('/campaigns/:id/cancel', async (req, res) => {
  const id = Number(req.params.id)
  const organizationId = req.user?.organizationId ?? undefined
  const campaign = await findOwnedCampaign(id, organizationId)
  if (!campaign) {
    res.status(404).json({ error: 'Campaign not found.' })
    return
  }

  const pending = await db
    .selectFrom('messages')
    .select(['id', 'pg_boss_job_id'])
    .where('campaign_id', '=', id)
    .where('status', 'in', ['scheduled', 'queued'])
    .execute()

  for (const m of pending) {
    await cancelSendJob(m.pg_boss_job_id)
    await db.updateTable('messages').set({ status: 'cancelled', updated_at: new Date() }).where('id', '=', m.id).execute()
  }

  await db
    .updateTable('campaigns')
    .set({ status: 'cancelled', updated_at: new Date() })
    .where('id', '=', id)
    .where('status', 'in', ['draft', 'scheduled', 'sending'])
    .execute()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'campaign_cancelled',
    entityType: 'campaign',
    entityId: id,
    metadata: { cancelledMessageCount: pending.length },
    ipAddress: req.ip
  })

  res.status(204).end()
})
