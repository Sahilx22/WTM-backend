import { Router } from 'express'
import { db } from '../../db/index.js'
import { scheduleMessageSchema } from '../messages/schemas.js'
import { mediaUpload, getMediaSignedUrl } from '../../lib/mediaUpload.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { getPrimarySocketForOrganization } from '../../whatsapp/connectionManager.js'
import { enqueueSendJob, cancelSendJob } from '../../queue/boss.js'
import { resolveRecipients, resolveMedia } from '../messages/shared.js'

export const scheduleRouter = Router()

const MAX_RECIPIENTS_PER_SCHEDULE = 50

async function loadFormData(templateId: number | null | undefined, organizationId: number | undefined) {
  let contactsQuery = db.selectFrom('contacts').selectAll().orderBy('display_name', 'asc').orderBy('phone_number', 'asc').limit(500)
  let groupsQuery = db.selectFrom('groups').selectAll().orderBy('subject', 'asc')
  let templatesQuery = db.selectFrom('message_templates').selectAll().orderBy('name', 'asc')
  let scheduledQuery = db.selectFrom('messages').selectAll().where('status', '=', 'scheduled').orderBy('scheduled_at', 'asc')

  if (organizationId !== undefined) {
    contactsQuery = contactsQuery.where('organization_id', '=', organizationId)
    groupsQuery = groupsQuery.where('organization_id', '=', organizationId)
    templatesQuery = templatesQuery.where('organization_id', '=', organizationId)
    scheduledQuery = scheduledQuery.where('organization_id', '=', organizationId)
  }

  const [contacts, groups, templateRows, scheduled] = await Promise.all([
    contactsQuery.execute(),
    groupsQuery.execute(),
    templatesQuery.execute(),
    scheduledQuery.execute()
  ])

  const templates = await Promise.all(
    templateRows.map(async (t) => ({ ...t, mediaUrl: t.media_path ? await getMediaSignedUrl(t.media_path) : null }))
  )

  const selectedTemplate = templateId ? (templates.find((t) => t.id === templateId) ?? null) : null

  return { contacts, groups, templates, selectedTemplate, scheduled }
}

scheduleRouter.get('/schedule', async (req, res) => {
  const templateId = req.query.template_id ? Number(req.query.template_id) : null
  const formData = await loadFormData(templateId, req.user?.organizationId ?? undefined)

  res.json(formData)
})

scheduleRouter.post('/schedule', mediaUpload.single('file'), async (req, res) => {
  const parsed = scheduleMessageSchema.safeParse(req.body)

  const fail = (error: string) => {
    res.status(400).json({ error })
  }

  if (!parsed.success) {
    fail(parsed.error.issues[0]?.message ?? 'Invalid input.')
    return
  }

  const organizationId = req.user?.organizationId
  if (!organizationId) {
    fail('Only an organization account can schedule messages.')
    return
  }

  const {
    recipient_type,
    contact_ids,
    raw_numbers,
    group_ids,
    message_type,
    message_text,
    template_id,
    scheduled_date,
    scheduled_time
  } = parsed.data

  const scheduledAt = new Date(`${scheduled_date}T${scheduled_time}`)
  if (Number.isNaN(scheduledAt.getTime())) {
    fail('Enter a valid date and time.')
    return
  }
  if (scheduledAt.getTime() <= Date.now() + 30_000) {
    fail('Pick a time at least a minute from now.')
    return
  }

  const sock = getPrimarySocketForOrganization(organizationId)
  if (!sock) {
    fail('WhatsApp is not connected. Connect it from the WhatsApp Connection page first.')
    return
  }

  const { recipients, skipped } = await resolveRecipients(
    sock,
    {
      recipientType: recipient_type,
      contactIds: contact_ids,
      rawNumbers: raw_numbers,
      groupIds: group_ids
    },
    organizationId
  )

  if (recipients.length === 0) {
    fail('No valid recipients were resolved. Check the numbers/contacts/groups you selected.')
    return
  }

  if (recipients.length > MAX_RECIPIENTS_PER_SCHEDULE) {
    fail(
      `That's ${recipients.length} recipients — this page is capped at ${MAX_RECIPIENTS_PER_SCHEDULE} for safety. Use Batches + Campaigns for larger sends.`
    )
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

  const inserted = await db
    .insertInto('messages')
    .values(
      recipients.map((r) => ({
        recipient_type: r.recipientType,
        recipient_contact_id: r.contactId,
        recipient_group_id: r.groupId,
        recipient_jid: r.jid,
        message_type,
        message_text,
        media_path: mediaResult.media.mediaPath,
        template_id,
        status: 'scheduled' as const,
        scheduled_at: scheduledAt,
        created_by: req.user?.id ?? null,
        organization_id: organizationId
      }))
    )
    .returning('id')
    .execute()

  for (const row of inserted) {
    const jobId = await enqueueSendJob(row.id, { startAfter: scheduledAt })
    await db.updateTable('messages').set({ pg_boss_job_id: jobId }).where('id', '=', row.id).execute()
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'message_scheduled',
    entityType: 'message',
    metadata: { count: inserted.length, skippedCount: skipped.length, scheduledAt: scheduledAt.toISOString() },
    ipAddress: req.ip
  })

  res.status(201).json({ scheduled: inserted.length, skipped })
})

scheduleRouter.delete('/schedule/:id', async (req, res) => {
  const id = Number(req.params.id)
  const organizationId = req.user?.organizationId ?? undefined

  let messageQuery = db.selectFrom('messages').select(['id', 'status', 'pg_boss_job_id', 'media_path']).where('id', '=', id)
  if (organizationId !== undefined) messageQuery = messageQuery.where('organization_id', '=', organizationId)
  const message = await messageQuery.executeTakeFirst()

  if (message && (message.status === 'scheduled' || message.status === 'queued')) {
    await cancelSendJob(message.pg_boss_job_id)
    await db
      .updateTable('messages')
      .set({ status: 'cancelled', updated_at: new Date() })
      .where('id', '=', id)
      .execute()

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'message_schedule_cancelled',
      entityType: 'message',
      entityId: id,
      ipAddress: req.ip
    })
  }

  res.status(204).end()
})
