import { Router } from 'express'
import { db } from '../../db/index.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { cancelTaskReminder, scheduleNextReminder } from '../../queue/taskReminders.js'
import { scheduleRecurrence } from '../../queue/recurringTasks.js'
import { recipientDisplayName } from '../../lib/recipientDisplay.js'
import { resolveContactId } from '../../whatsapp/taskEngine.js'
import { getSocket } from '../../whatsapp/connectionManager.js'

export const tasksRouter = Router()

async function loadTasks(status: string, reminder: string) {
  let query = db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select([
      'tasks.id',
      'tasks.recipient_jid',
      'tasks.name',
      'tasks.priority',
      'tasks.reminder_times_per_day',
      'tasks.reminder_interval_days',
      'tasks.reminders_enabled',
      'tasks.target_date',
      'tasks.status',
      'tasks.last_reminder_sent_at',
      'tasks.next_reminder_at',
      'tasks.created_at',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject'
    ])
    .orderBy('tasks.created_at', 'desc')
    .limit(200)

  if (status) {
    query = query.where('tasks.status', '=', status as never)
  }

  if (reminder === 'on' || reminder === 'off') {
    query = query
      .where('tasks.status', '=', 'pending')
      .where('tasks.reminders_enabled', '=', reminder === 'on')
      .where((eb) => eb.or([eb('tasks.reminder_times_per_day', 'is not', null), eb('tasks.reminder_interval_days', 'is not', null)]))
  } else if (reminder === 'done') {
    query = query.where('tasks.status', 'in', ['needs_review', 'completed'])
  }

  const rows = await query.execute()
  return rows.map((t) => ({ ...t, recipientName: recipientDisplayName(t.recipient_jid, t.contactName, t.groupSubject) }))
}

tasksRouter.get('/tasks', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const reminder = typeof req.query.reminder === 'string' ? req.query.reminder : ''
  const tasks = await loadTasks(status, reminder)
  res.json({ tasks })
})

// Re-attempts contact matching for tasks that came in with no linked
// contact — useful right after a contact gets saved/synced, or if a PN/LID
// mapping wasn't known yet at the time the task was created.
tasksRouter.post('/tasks/relink-contacts', async (req, res) => {
  const sock = getSocket()
  let relinked = 0

  if (sock) {
    const orphaned = await db
      .selectFrom('tasks')
      .select(['id', 'recipient_jid'])
      .where('contact_id', 'is', null)
      .execute()

    for (const task of orphaned) {
      const contactId = await resolveContactId(sock, task.recipient_jid)
      if (contactId) {
        await db.updateTable('tasks').set({ contact_id: contactId, updated_at: new Date() }).where('id', '=', task.id).execute()
        relinked++
      }
    }

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'tasks_relinked_contacts',
      entityType: 'task',
      metadata: { checked: orphaned.length, relinked },
      ipAddress: req.ip
    })
  }

  res.json({ relinked })
})

tasksRouter.post('/tasks/:id/complete', async (req, res) => {
  const id = Number(req.params.id)
  const task = await db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst()

  if (task) {
    await cancelTaskReminder(task.next_reminder_job_id)
    const completedAt = new Date()
    await db
      .updateTable('tasks')
      .set({
        status: 'completed',
        next_reminder_job_id: null,
        next_reminder_at: null,
        completed_at: completedAt,
        updated_at: completedAt
      })
      .where('id', '=', id)
      .execute()

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'task_completed',
      entityType: 'task',
      entityId: id,
      ipAddress: req.ip
    })

    if (task.is_recurring) {
      await scheduleRecurrence({ ...task, status: 'completed', completed_at: completedAt })
    }
  }

  res.status(204).end()
})

tasksRouter.post('/tasks/:id/needs-review', async (req, res) => {
  const id = Number(req.params.id)
  const task = await db.selectFrom('tasks').select(['next_reminder_job_id']).where('id', '=', id).executeTakeFirst()

  if (task) {
    await cancelTaskReminder(task.next_reminder_job_id)
    await db
      .updateTable('tasks')
      .set({ status: 'needs_review', next_reminder_job_id: null, next_reminder_at: null, updated_at: new Date() })
      .where('id', '=', id)
      .execute()

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'task_marked_needs_review',
      entityType: 'task',
      entityId: id,
      metadata: { via: 'manual' },
      ipAddress: req.ip
    })
  }

  res.status(204).end()
})

tasksRouter.post('/tasks/:id/toggle-reminders', async (req, res) => {
  const id = Number(req.params.id)
  const task = await db
    .selectFrom('tasks')
    .select(['status', 'reminder_times_per_day', 'reminder_interval_days', 'reminders_enabled', 'next_reminder_job_id'])
    .where('id', '=', id)
    .executeTakeFirst()

  if (task && task.status === 'pending' && (task.reminder_times_per_day || task.reminder_interval_days)) {
    if (task.reminders_enabled) {
      await cancelTaskReminder(task.next_reminder_job_id)
      await db
        .updateTable('tasks')
        .set({ reminders_enabled: false, next_reminder_job_id: null, next_reminder_at: null, updated_at: new Date() })
        .where('id', '=', id)
        .execute()
    } else {
      await db
        .updateTable('tasks')
        .set({ reminders_enabled: true, updated_at: new Date() })
        .where('id', '=', id)
        .execute()
      await scheduleNextReminder(id)
    }

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: task.reminders_enabled ? 'task_reminders_disabled' : 'task_reminders_enabled',
      entityType: 'task',
      entityId: id,
      ipAddress: req.ip
    })
  }

  res.status(204).end()
})

tasksRouter.delete('/tasks/:id', async (req, res) => {
  const id = Number(req.params.id)
  const task = await db.selectFrom('tasks').select(['next_reminder_job_id']).where('id', '=', id).executeTakeFirst()

  if (task) {
    await cancelTaskReminder(task.next_reminder_job_id)
    await db.deleteFrom('tasks').where('id', '=', id).execute()

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'task_deleted',
      entityType: 'task',
      entityId: id,
      ipAddress: req.ip
    })
  }

  res.status(204).end()
})
