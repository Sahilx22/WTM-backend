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

  // Sent/failed attempt counts per reminder, from the send log.
  const counts = new Map<number, { sent: number; failed: number }>()
  if (rows.length > 0) {
    const grouped = await db
      .selectFrom('recurring_reminder_sends')
      .select(['reminder_id', 'status'])
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('reminder_id', 'in', rows.map((r) => r.id))
      .groupBy(['reminder_id', 'status'])
      .execute()
    for (const g of grouped) {
      const entry = counts.get(g.reminder_id) ?? { sent: 0, failed: 0 }
      entry[g.status] = Number(g.count)
      counts.set(g.reminder_id, entry)
    }
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const reminders = rows.map((r) => {
    const ended = r.end_date !== null && new Date(new Date(r.end_date).setHours(0, 0, 0, 0)).getTime() < today.getTime()
    return {
      ...r,
      recipientName: recipientDisplayName(r.recipient_jid, r.contactName, r.groupSubject),
      createdByLabel: r.createdBySessionLabel ?? r.createdBySessionPhone ?? null,
      sentCount: counts.get(r.id)?.sent ?? 0,
      failedCount: counts.get(r.id)?.failed ?? 0,
      // 'completed' = ran through its "till" date; 'off' = turned off by hand.
      status: ended ? 'completed' : r.enabled ? 'active' : 'off'
    }
  })

  res.json({ reminders })
})

// The send log for one reminder, newest first — what the portal shows in a
// reminder's history view.
recurringRemindersRouter.get('/recurring-reminders/:id/history', async (req, res) => {
  const id = Number(req.params.id)
  let owned = db.selectFrom('recurring_reminders').select('id').where('id', '=', id)
  if (req.user?.organizationId) owned = owned.where('organization_id', '=', req.user.organizationId)
  if (!(await owned.executeTakeFirst())) {
    res.status(404).json({ error: 'Recurring reminder not found.' })
    return
  }

  const sends = await db
    .selectFrom('recurring_reminder_sends')
    .select(['id', 'status', 'error_message', 'sent_at'])
    .where('reminder_id', '=', id)
    .orderBy('sent_at', 'desc')
    .limit(100)
    .execute()

  res.json({ sends })
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
