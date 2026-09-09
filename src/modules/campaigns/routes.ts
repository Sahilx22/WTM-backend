import { Router } from 'express'
import { db } from '../../db/index.js'
import { campaignInputSchema } from './schemas.js'
import { mediaUpload, getMediaSignedUrl } from '../../lib/mediaUpload.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { getPrimarySocket } from '../../whatsapp/connectionManager.js'
import { enqueueSendJob, cancelSendJob } from '../../queue/boss.js'
import { resolveBatchRecipients, resolveMedia } from '../messages/shared.js'
import { campaignEvents } from '../../queue/campaignProgress.js'

export const campaignsRouter = Router()

async function loadFormData() {
  const [batches, templateRows] = await Promise.all([
    db.selectFrom('batches').selectAll().orderBy('name', 'asc').execute(),
    db.selectFrom('message_templates').selectAll().orderBy('name', 'asc').execute()
  ])
  const templates = await Promise.all(
    templateRows.map(async (t) => ({ ...t, mediaUrl: t.media_path ? await getMediaSignedUrl(t.media_path) : null }))
  )
  return { batches, templates }
}

campaignsRouter.get('/campaigns', async (_req, res) => {
  const campaigns = await db.selectFrom('campaigns').selectAll().orderBy('created_at', 'desc').execute()
  res.json({ campaigns })
})

campaignsRouter.get('/campaigns/new', async (_req, res) => {
  const formData = await loadFormData()
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

  const {
    name,
    batch_id,
    template_id,
    message_type,
    message_text,
    scheduled_date,
    scheduled_time,
    min_delay_ms,
    max_delay_ms
  } = parsed.data

  const batch = await db.selectFrom('batches').select(['id', 'contact_count']).where('id', '=', batch_id).executeTakeFirst()
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

  const mediaResult = await resolveMedia(message_type, req.file, template_id)
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

  const sock = getPrimarySocket()
  if (!sock) {
    fail('WhatsApp is not connected. Connect it from the WhatsApp Connection page first.')
    return
  }

  const { recipients, skipped } = await resolveBatchRecipients(sock, batch_id)
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
      started_at: scheduledAt ? null : new Date()
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
        created_by: req.user?.id ?? null
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
    metadata: { recipientCount: recipients.length, skippedCount: skipped.length, scheduled: Boolean(scheduledAt) },
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

campaignsRouter.get('/campaigns/:id', async (req, res) => {
  const id = Number(req.params.id)
  const campaign = await db.selectFrom('campaigns').selectAll().where('id', '=', id).executeTakeFirst()
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

  res.json({ campaign: { ...campaign, mediaUrl }, progress: { pct }, recentMessages })
})

async function loadProgressSnapshot(campaignId: number) {
  const campaign = await db.selectFrom('campaigns').selectAll().where('id', '=', campaignId).executeTakeFirst()
  if (!campaign) return null
  return computeProgress(campaign)
}

campaignsRouter.get('/campaigns/:id/stream', (req, res) => {
  const id = Number(req.params.id)

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.flushHeaders()

  const send = async () => {
    try {
      const snapshot = await loadProgressSnapshot(id)
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
