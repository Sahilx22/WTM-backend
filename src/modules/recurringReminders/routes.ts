import { Router } from 'express'
import { db } from '../../db/index.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { recipientDisplayName } from '../../lib/recipientDisplay.js'
import { cancelPendingRecurringReminderJobs, scheduleNextRecurringReminder } from '../../queue/recurringReminders.js'

export const recurringRemindersRouter = Router()

recurringRemindersRouter.get('/recurring-reminders', async (req, res) => {
  const organizationId = req.user?.organizationId

  let query = db
    .selectFrom('recurring_reminders')
    .leftJoin('contacts', 'contacts.id', 'recurring_reminders.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'recurring_reminders.recipient_jid')
    .leftJoin('whatsapp_sessions', 'whatsapp_sessions.id', 'recurring_reminders.created_by_session_id')
    .select([
      'recurring_reminders.id',
      'recurring_reminders.recipient_jid',
      'recurring_reminders.message_text',
      'recurring_reminders.scheduled_time',
      'recurring_reminders.end_date',
      'recurring_reminders.enabled',
      'recurring_reminders.last_sent_at',
      'recurring_reminders.next_send_at',
      'recurring_reminders.created_at',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject',
      'whatsapp_sessions.label as createdBySessionLabel',
      'whatsapp_sessions.phone_number as createdBySessionPhone'
    ])
    .orderBy('recurring_reminders.created_at', 'desc')

  if (organizationId !== undefined) {
    query = query.where('recurring_reminders.organization_id', '=', organizationId)
  }

  const rows = await query.execute()
  const reminders = rows.map((r) => ({
    ...r,
    recipientName: recipientDisplayName(r.recipient_jid, r.contactName, r.groupSubject),
    createdByLabel: r.createdBySessionLabel ?? r.createdBySessionPhone ?? null
  }))

  res.json({ reminders })
})

recurringRemindersRouter.post('/recurring-reminders/:id/toggle', async (req, res) => {
  const id = Number(req.params.id)
  let query = db.selectFrom('recurring_reminders').selectAll().where('id', '=', id)
  if (req.user?.organizationId) query = query.where('organization_id', '=', req.user.organizationId)
  const reminder = await query.executeTakeFirst()

  if (!reminder) {
    res.status(404).json({ error: 'Recurring reminder not found.' })
    return
  }

  const nextEnabled = !reminder.enabled

  if (nextEnabled) {
    await db.updateTable('recurring_reminders').set({ enabled: true, updated_at: new Date() }).where('id', '=', id).execute()
    await scheduleNextRecurringReminder(id)
  } else {
    await cancelPendingRecurringReminderJobs(id)
    await db
      .updateTable('recurring_reminders')
      .set({ enabled: false, next_send_job_id: null, next_send_at: null, updated_at: new Date() })
      .where('id', '=', id)
      .execute()
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: nextEnabled ? 'recurring_reminder_enabled' : 'recurring_reminder_disabled',
    entityType: 'recurring_reminder',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})

recurringRemindersRouter.delete('/recurring-reminders/:id', async (req, res) => {
  const id = Number(req.params.id)
  let query = db.selectFrom('recurring_reminders').select('next_send_job_id').where('id', '=', id)
  if (req.user?.organizationId) query = query.where('organization_id', '=', req.user.organizationId)
  const reminder = await query.executeTakeFirst()

  if (reminder) {
    await cancelPendingRecurringReminderJobs(id)

    let deleteQuery = db.deleteFrom('recurring_reminders').where('id', '=', id)
    if (req.user?.organizationId) deleteQuery = deleteQuery.where('organization_id', '=', req.user.organizationId)
    await deleteQuery.execute()

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'recurring_reminder_deleted',
      entityType: 'recurring_reminder',
      entityId: id,
      ipAddress: req.ip
    })
  }

  res.status(204).end()
})
