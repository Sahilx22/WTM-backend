import { Router } from 'express'
import { db } from '../../db/index.js'
import { sendMessageSchema } from './schemas.js'
import { mediaUpload, getMediaSignedUrl } from '../../lib/mediaUpload.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { getPrimarySocket } from '../../whatsapp/connectionManager.js'
import { enqueueSendJob } from '../../queue/boss.js'
import { resolveRecipients, resolveMedia } from './shared.js'

export const messagesRouter = Router()

const MAX_RECIPIENTS_PER_SEND = 50

async function loadFormData(templateId?: number | null) {
  const [contacts, groups, templateRows] = await Promise.all([
    db.selectFrom('contacts').selectAll().orderBy('display_name', 'asc').orderBy('phone_number', 'asc').limit(500).execute(),
    db.selectFrom('groups').selectAll().orderBy('subject', 'asc').execute(),
    db.selectFrom('message_templates').selectAll().orderBy('name', 'asc').execute()
  ])

  const templates = await Promise.all(
    templateRows.map(async (t) => ({ ...t, mediaUrl: t.media_path ? await getMediaSignedUrl(t.media_path) : null }))
  )

  const selectedTemplate = templateId ? (templates.find((t) => t.id === templateId) ?? null) : null

  return { contacts, groups, templates, selectedTemplate }
}

messagesRouter.get('/send', async (req, res) => {
  const templateId = req.query.template_id ? Number(req.query.template_id) : null
  const formData = await loadFormData(templateId)

  res.json(formData)
})

messagesRouter.post('/send', mediaUpload.single('file'), async (req, res) => {
  const parsed = sendMessageSchema.safeParse(req.body)

  const fail = (error: string) => {
    res.status(400).json({ error })
  }

  if (!parsed.success) {
    fail(parsed.error.issues[0]?.message ?? 'Invalid input.')
    return
  }

  const { recipient_type, contact_ids, raw_numbers, group_ids, message_type, message_text, template_id } =
    parsed.data

  const sock = getPrimarySocket()
  if (!sock) {
    fail('WhatsApp is not connected. Connect it from the WhatsApp Connection page first.')
    return
  }

  const { recipients, skipped } = await resolveRecipients(sock, {
    recipientType: recipient_type,
    contactIds: contact_ids,
    rawNumbers: raw_numbers,
    groupIds: group_ids
  })

  if (recipients.length === 0) {
    fail('No valid recipients were resolved. Check the numbers/contacts/groups you selected.')
    return
  }

  if (recipients.length > MAX_RECIPIENTS_PER_SEND) {
    fail(
      `That's ${recipients.length} recipients — this page is capped at ${MAX_RECIPIENTS_PER_SEND} for safety. Use Batches + Campaigns for larger sends.`
    )
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
        status: 'queued' as const,
        created_by: req.user?.id ?? null
      }))
    )
    .returning('id')
    .execute()

  for (const row of inserted) {
    const jobId = await enqueueSendJob(row.id)
    if (jobId) {
      await db.updateTable('messages').set({ pg_boss_job_id: jobId }).where('id', '=', row.id).execute()
    }
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'message_send_requested',
    entityType: 'message',
    metadata: { count: inserted.length, skippedCount: skipped.length, messageType: message_type },
    ipAddress: req.ip
  })

  res.json({ sent: inserted.length, skipped })
})
