import { Router } from 'express'
import { db } from '../../db/index.js'
import { scheduleMessageSchema } from '../messages/schemas.js'
import { mediaUpload, getMediaSignedUrl } from '../../lib/mediaUpload.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import {
  getConnectedSessionsForOrganization,
  getConnectedSocketForSession,
  maskPhoneNumber
} from '../../whatsapp/connectionManager.js'
import { enqueueSendJob, cancelSendJob } from '../../queue/boss.js'
import { resolveRecipients, resolveMedia } from '../messages/shared.js'
import { scheduleNextRecurringReminder } from '../../queue/recurringReminders.js'
import { recipientDisplayName } from '../../lib/recipientDisplay.js'
import { stripScheduleTag } from '../../whatsapp/recurringReminderParser.js'

export const scheduleRouter = Router()

const MAX_RECIPIENTS_PER_SCHEDULE = 50

async function loadFormData(templateId: number | null | undefined, organizationId: number | undefined) {
  let contactsQuery = db.selectFrom('contacts').selectAll().orderBy('display_name', 'asc').orderBy('phone_number', 'asc').limit(500)
  let groupsQuery = db.selectFrom('groups').selectAll().orderBy('subject', 'asc')
  let templatesQuery = db.selectFrom('message_templates').selectAll().orderBy('name', 'asc')
  let scheduledQuery = db
    .selectFrom('messages')
    .leftJoin('contacts', 'contacts.id', 'messages.recipient_contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'messages.recipient_jid')
    .leftJoin('whatsapp_sessions', 'whatsapp_sessions.id', 'messages.whatsapp_session_id')
    .select([
      'messages.id',
      'messages.recipient_jid',
      'messages.message_type',
      'messages.message_text',
      'messages.scheduled_at',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject',
      'whatsapp_sessions.label as senderLabel',
      'whatsapp_sessions.phone_number as senderPhone'
    ])
    .where('messages.status', '=', 'scheduled')
    .orderBy('messages.scheduled_at', 'asc')

  if (organizationId !== undefined) {
    contactsQuery = contactsQuery.where('organization_id', '=', organizationId)
    groupsQuery = groupsQuery.where('organization_id', '=', organizationId)
    templatesQuery = templatesQuery.where('organization_id', '=', organizationId)
    scheduledQuery = scheduledQuery.where('messages.organization_id', '=', organizationId)
  }

  const [contacts, groups, templateRows, scheduledRows] = await Promise.all([
    contactsQuery.execute(),
    groupsQuery.execute(),
    templatesQuery.execute(),
    scheduledQuery.execute()
  ])

  const templates = await Promise.all(
    templateRows.map(async (t) => ({ ...t, mediaUrl: t.media_path ? await getMediaSignedUrl(t.media_path) : null }))
  )

  const selectedTemplate = templateId ? (templates.find((t) => t.id === templateId) ?? null) : null

  const scheduled = scheduledRows.map((r) => ({
    ...r,
    recipientName: recipientDisplayName(r.recipient_jid, r.contactName, r.groupSubject),
    senderName: r.senderLabel ?? maskPhoneNumber(r.senderPhone) ?? null
  }))

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

  return { contacts, groups, templates, selectedTemplate, scheduled, sessions }
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
    scheduled_time,
    whatsapp_session_id,
    is_recurring,
    recurring_end_date,
    recurring_interval_days
  } = parsed.data

  // Never trust whatsapp_session_id from the request body at face value —
  // it must be one of this organization's own sessions, connected right
  // now. With one connected session there's nothing to choose; with several
  // and no explicit choice, the primary (listed first) is used.
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

  if (is_recurring && message_type !== 'text') {
    fail('Recurring messages support text only for now — choose "Text" as the message type.')
    return
  }

  let scheduledAt: Date | null = null
  if (!is_recurring) {
    scheduledAt = new Date(`${scheduled_date}T${scheduled_time}`)
    if (Number.isNaN(scheduledAt.getTime())) {
      fail('Enter a valid date and time.')
      return
    }
    if (scheduledAt.getTime() <= Date.now() + 30_000) {
      fail('Pick a time at least a minute from now.')
      return
    }
  } else if (!/^\d{2}:\d{2}$/.test(scheduled_time)) {
    fail('Enter a valid time.')
    return
  }

  let recurringEndDate: Date | null = null
  if (is_recurring && recurring_end_date) {
    recurringEndDate = new Date(recurring_end_date)
    if (Number.isNaN(recurringEndDate.getTime())) {
      fail('Enter a valid end date, or leave it blank to repeat until turned off.')
      return
    }
  }

  if (is_recurring && (!Number.isInteger(recurring_interval_days) || recurring_interval_days < 1)) {
    fail('Enter how many days between sends (1 or more).')
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

  if (is_recurring) {
    // One recurring_reminders row per recipient — it repeats every
    // recurring_interval_days (1 = daily, the default) at scheduled_time's
    // time-of-day, starting from its next occurrence, same mechanics as a
    // "#sced" reminder typed on the phone. It shows up on the Recurring
    // Reminders page, not in this page's own "Upcoming" list below.
    //
    // stripScheduleTag guards against someone pasting a WhatsApp-style
    // "... #sced till 30-11-26" draft straight into this box out of habit —
    // this form already has its own end-date/interval fields for that, so
    // a leftover tag would otherwise get sent verbatim as part of the
    // message. Ordinary text is returned unchanged.
    const cleanedMessageText = stripScheduleTag(message_text!)

    const inserted = await db
      .insertInto('recurring_reminders')
      .values(
        recipients.map((r) => ({
          organization_id: organizationId,
          recipient_jid: r.jid,
          contact_id: r.contactId,
          message_text: cleanedMessageText,
          scheduled_time,
          end_date: recurringEndDate,
          interval_days: recurring_interval_days,
          whatsapp_session_id: sender.sessionId,
          created_by_session_id: sender.sessionId
        }))
      )
      .returning('id')
      .execute()

    for (const row of inserted) {
      await scheduleNextRecurringReminder(row.id)
    }

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'recurring_reminder_created',
      entityType: 'recurring_reminder',
      metadata: {
        count: inserted.length,
        skippedCount: skipped.length,
        scheduledTime: scheduled_time,
        intervalDays: recurring_interval_days,
        whatsappSessionId: sender.sessionId
      },
      ipAddress: req.ip
    })

    res.status(201).json({ scheduled: 0, recurring: inserted.length, skipped })
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
        scheduled_at: scheduledAt!,
        created_by: req.user?.id ?? null,
        organization_id: organizationId,
        whatsapp_session_id: sender.sessionId
      }))
    )
    .returning('id')
    .execute()

  for (const row of inserted) {
    const jobId = await enqueueSendJob(row.id, { startAfter: scheduledAt! })
    await db.updateTable('messages').set({ pg_boss_job_id: jobId }).where('id', '=', row.id).execute()
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'message_scheduled',
    entityType: 'message',
    metadata: { count: inserted.length, skippedCount: skipped.length, scheduledAt: scheduledAt!.toISOString(), whatsappSessionId: sender.sessionId },
    ipAddress: req.ip
  })

  res.status(201).json({ scheduled: inserted.length, recurring: 0, skipped })
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
