import { Router } from 'express'
import { db } from '../../db/index.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { cancelTaskReminder, scheduleNextReminder } from '../../queue/taskReminders.js'
import { scheduleRecurrence } from '../../queue/recurringTasks.js'
import { recipientDisplayName } from '../../lib/recipientDisplay.js'
import { resolveContactId } from '../../whatsapp/taskEngine.js'
import { getPrimarySocketForOrganization } from '../../whatsapp/connectionManager.js'

export const tasksRouter = Router()

async function loadTasks(status: string, reminder: string, category: string, organizationId?: number) {
  let query = db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .leftJoin('whatsapp_sessions', 'whatsapp_sessions.id', 'tasks.created_by_session_id')
    .select([
      'tasks.id',
      'tasks.recipient_jid',
      'tasks.name',
      'tasks.category',
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
      'groups.subject as groupSubject',
      'whatsapp_sessions.label as createdBySessionLabel',
      'whatsapp_sessions.phone_number as createdBySessionPhone',
      'whatsapp_sessions.is_primary as createdBySessionIsPrimary'
    ])
    .orderBy('tasks.created_at', 'desc')
    .limit(200)

  // Regular org users only ever see their own organization's tasks; the
  // super admin (no organization) gets the unscoped, cross-org view.
  if (organizationId !== undefined) {
    query = query.where('tasks.organization_id', '=', organizationId)
  }

  if (status) {
    query = query.where('tasks.status', '=', status as never)
  }

  if (category) {
    query = query.where('tasks.category', '=', category)
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
  return rows.map((t) => ({
    ...t,
    recipientName: recipientDisplayName(t.recipient_jid, t.contactName, t.groupSubject),
    // Which session/employee delegated this task — null for tasks created
    // before multi-session support, or whose creating session was removed.
    createdByLabel: t.createdBySessionLabel ?? t.createdBySessionPhone ?? null
  }))
}

tasksRouter.get('/tasks', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const reminder = typeof req.query.reminder === 'string' ? req.query.reminder : ''
  const category = typeof req.query.category === 'string' ? req.query.category : ''
  const tasks = await loadTasks(status, reminder, category, req.user?.organizationId ?? undefined)
  res.json({ tasks })
})

// Chat notes logged whenever someone quote-replies to this task's original
// message or a reminder for it (see whatsapp/taskEngine.ts).
tasksRouter.get('/tasks/:id/notes', async (req, res) => {
  const id = Number(req.params.id)

  if (req.user?.organizationId) {
    const owned = await db
      .selectFrom('tasks')
      .select('id')
      .where('id', '=', id)
      .where('organization_id', '=', req.user.organizationId)
      .executeTakeFirst()
    if (!owned) {
      res.status(404).json({ error: 'Task not found.' })
      return
    }
  }

  const notes = await db.selectFrom('task_notes').selectAll().where('task_id', '=', id).orderBy('created_at', 'asc').execute()
  res.json({ notes })
})

// Overview of the reminder pipeline: what's still scheduled to go out, and
// the recent send/failure history (see queue/taskReminders.ts).
tasksRouter.get('/tasks/reminders', async (req, res) => {
  const organizationId = req.user?.organizationId ?? undefined

  let scheduledQuery = db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select([
      'tasks.id',
      'tasks.name',
      'tasks.recipient_jid',
      'tasks.reminder_times_per_day',
      'tasks.reminder_interval_days',
      'tasks.next_reminder_at',
      'tasks.last_reminder_sent_at',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject'
    ])
    .where('tasks.status', '=', 'pending')
    .where('tasks.reminders_enabled', '=', true)
    .where((eb) => eb.or([eb('tasks.reminder_times_per_day', 'is not', null), eb('tasks.reminder_interval_days', 'is not', null)]))
    .orderBy('tasks.next_reminder_at', 'asc')

  if (organizationId !== undefined) {
    scheduledQuery = scheduledQuery.where('tasks.organization_id', '=', organizationId)
  }

  const scheduledRows = await scheduledQuery.execute()

  let historyQuery = db
    .selectFrom('task_messages')
    .innerJoin('tasks', 'tasks.id', 'task_messages.task_id')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select([
      'task_messages.id',
      'task_messages.task_id',
      'task_messages.status',
      'task_messages.error_message',
      'task_messages.sent_at',
      'tasks.name as taskName',
      'tasks.recipient_jid',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject'
    ])
    .where('task_messages.kind', '=', 'reminder')
    .orderBy('task_messages.sent_at', 'desc')
    .limit(100)

  if (organizationId !== undefined) {
    historyQuery = historyQuery.where('tasks.organization_id', '=', organizationId)
  }

  const historyRows = await historyQuery.execute()

  const withRecipientName = <T extends { recipient_jid: string; contactName: string | null; groupSubject: string | null }>(row: T) => ({
    ...row,
    recipientName: recipientDisplayName(row.recipient_jid, row.contactName, row.groupSubject)
  })

  res.json({
    scheduled: scheduledRows.map(withRecipientName),
    sent: historyRows.filter((r) => r.status === 'sent').map(withRecipientName),
    failed: historyRows.filter((r) => r.status === 'failed').map(withRecipientName)
  })
})

// Re-attempts contact matching for tasks that came in with no linked
// contact — useful right after a contact gets saved/synced, or if a PN/LID
// mapping wasn't known yet at the time the task was created.
tasksRouter.post('/tasks/relink-contacts', async (req, res) => {
  const organizationId = req.user?.organizationId ?? undefined
  let relinked = 0

  let orphanedQuery = db.selectFrom('tasks').select(['id', 'recipient_jid', 'organization_id']).where('contact_id', 'is', null)
  if (organizationId !== undefined) {
    orphanedQuery = orphanedQuery.where('organization_id', '=', organizationId)
  }
  const orphaned = await orphanedQuery.execute()

  let checked = 0
  for (const task of orphaned) {
    // Each task keeps its own organization's socket — a super admin's
    // unscoped sweep can touch tasks from several organizations at once, and
    // each one must only ever be resolved through its own org's session.
    if (task.organization_id === null) continue
    const sock = getPrimarySocketForOrganization(task.organization_id)
    if (!sock) continue
    checked++

    const contactId = await resolveContactId(sock, task.recipient_jid, task.organization_id)
    if (contactId) {
      await db.updateTable('tasks').set({ contact_id: contactId, updated_at: new Date() }).where('id', '=', task.id).execute()
      relinked++
    }
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'tasks_relinked_contacts',
    entityType: 'task',
    metadata: { checked, relinked },
    ipAddress: req.ip
  })

  res.json({ relinked })
})

tasksRouter.post('/tasks/:id/complete', async (req, res) => {
  const id = Number(req.params.id)
  let taskQuery = db.selectFrom('tasks').selectAll().where('id', '=', id)
  if (req.user?.organizationId) taskQuery = taskQuery.where('organization_id', '=', req.user.organizationId)
  const task = await taskQuery.executeTakeFirst()

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
  let taskQuery = db.selectFrom('tasks').select(['next_reminder_job_id']).where('id', '=', id)
  if (req.user?.organizationId) taskQuery = taskQuery.where('organization_id', '=', req.user.organizationId)
  const task = await taskQuery.executeTakeFirst()

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
  let taskQuery = db
    .selectFrom('tasks')
    .select(['status', 'reminder_times_per_day', 'reminder_interval_days', 'reminders_enabled', 'next_reminder_job_id'])
    .where('id', '=', id)
  if (req.user?.organizationId) taskQuery = taskQuery.where('organization_id', '=', req.user.organizationId)
  const task = await taskQuery.executeTakeFirst()

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
  let taskQuery = db.selectFrom('tasks').select(['next_reminder_job_id']).where('id', '=', id)
  if (req.user?.organizationId) taskQuery = taskQuery.where('organization_id', '=', req.user.organizationId)
  const task = await taskQuery.executeTakeFirst()

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
