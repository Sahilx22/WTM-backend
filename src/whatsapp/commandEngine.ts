import { areJidsSameUser, isJidGroup, type WASocket, type WAMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from '../db/index.js'
import { isProduction } from '../config/env.js'
import { parseCommand } from './commandParser.js'
import { getReportData, STATUS_LABEL, type DateRange } from '../reports/taskMetrics.js'
import { renderTaskReportPdf } from '../reports/taskReportPdf.js'
import { loadReportBranding } from '../reports/branding.js'
import { recipientDisplayName } from '../lib/recipientDisplay.js'
import { recordAuditLog } from '../lib/auditLog.js'
import { scheduleNextReminder, cancelTaskReminder } from '../queue/taskReminders.js'
import { scheduleRecurrence, cancelRecurrence } from '../queue/recurringTasks.js'
import { formatShortDate } from '../lib/dateFormat.js'
import { resolveContactId } from './taskEngine.js'
import type { TaskStatus, TaskPriority, RecurrenceUnit } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

const HELP_TEXT = `*WA Messenger commands*
/help — show this message

*View tasks*
/status <task or employee name> — everything matching, any status
/status <name> pending|completed|review — filtered to that status
/status <name> @category — filtered to a category, e.g. @acc, @pur
/status <name> from dd-mm-yy to dd-mm-yy — filtered to a date range
(any combination of name / status / category / date range works together)

*Reports (PDF)*
/report — all employees, all time
/report daily|weekly|monthly — scoped to a period
/report pending|completed|review — scoped to a status
/report @category — scoped to a category
/report <name or number> — one employee
/report from dd-mm-yy to dd-mm-yy — a custom date range
(mix and match: e.g. "/report Priya completed @acc from 01-08-26 to 15-08-26")

*Act on a task* (get the #id from /status)
/complete <id> — mark a task completed
/remind <id> <N>TAD [until dd-mm-yy] — remind N times a day (spread across working hours; 1TAD uses the daily reminder time)
/remind <id> 1IN<N>D [until dd-mm-yy] — remind once every N days
/remind <id> stop — turn reminders off without deleting it
/recur <id> every <N> days|weeks [at HH:MM] — recreate this task automatically N days/weeks after it's completed
/recur <id> off — stop it from recreating
/priority <id> P1|P2|P3|P4 — change a task's priority (P1 = critical … P4 = low)
/category <id> @tag — change a task's category, e.g. @acc, @pur

*Chat log*
/chat <id> — everything discussed about this task (reply/quote a task or reminder message to log a note on it)
/summary <id or task name> [dd-mm-yy] — same as /chat but also works by task name, and can be scoped to one day. Also works as a direct message from a task's own recipient straight to your number — they'll get their own task's chat log back, scoped to their own tasks only.`

// Sort actionable items first: pending, then needs review, then completed.
const STATUS_SORT_ORDER: Record<string, number> = {
  pending: 0,
  needs_review: 1,
  completed: 2
}

async function handleStatusCommand(
  sock: WASocket,
  ownJid: string,
  organizationId: number,
  query: string,
  statusFilter?: TaskStatus,
  category?: string,
  dateFrom?: Date,
  dateTo?: Date
): Promise<void> {
  let dbQuery = db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .leftJoin('whatsapp_sessions', 'whatsapp_sessions.id', 'tasks.created_by_session_id')
    .select([
      'tasks.id',
      'tasks.name',
      'tasks.category',
      'tasks.priority',
      'tasks.status',
      'tasks.recipient_jid',
      'tasks.target_date',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject',
      'whatsapp_sessions.label as createdBySessionLabel',
      'whatsapp_sessions.phone_number as createdBySessionPhone',
      'whatsapp_sessions.is_primary as createdBySessionIsPrimary'
    ])
    .where('tasks.organization_id', '=', organizationId)
    .orderBy('tasks.created_at', 'desc')
    .limit(30)

  if (query) {
    const like = `%${query}%`
    dbQuery = dbQuery.where((eb) =>
      eb.or([
        eb('tasks.name', 'ilike', like),
        eb('contacts.display_name', 'ilike', like),
        eb('groups.subject', 'ilike', like),
        eb('tasks.recipient_jid', 'ilike', like)
      ])
    )
  }

  if (statusFilter) {
    dbQuery = dbQuery.where('tasks.status', '=', statusFilter)
  }

  if (category) {
    dbQuery = dbQuery.where('tasks.category', '=', category)
  }

  if (dateFrom) dbQuery = dbQuery.where('tasks.created_at', '>=', dateFrom)
  if (dateTo) {
    const exclusiveEnd = new Date(dateTo)
    exclusiveEnd.setDate(exclusiveEnd.getDate() + 1)
    dbQuery = dbQuery.where('tasks.created_at', '<', exclusiveEnd)
  }

  const matches = await dbQuery.execute()

  if (matches.length === 0) {
    const desc = [query && `"${query}"`, statusFilter && STATUS_LABEL[statusFilter], category && `@${category}`]
      .filter(Boolean)
      .join(' — ')
    await sock.sendMessage(ownJid, { text: `No tasks found matching ${desc || 'that'}.` })
    return
  }

  matches.sort((a, b) => (STATUS_SORT_ORDER[a.status] ?? 9) - (STATUS_SORT_ORDER[b.status] ?? 9))

  const counts = { pending: 0, needs_review: 0, completed: 0 } as Record<TaskStatus, number>
  for (const t of matches) counts[t.status] = (counts[t.status] ?? 0) + 1

  const lines = matches.map((t) => {
    const who = recipientDisplayName(t.recipient_jid, t.contactName, t.groupSubject)
    const due = t.target_date ? ` (due ${formatShortDate(new Date(t.target_date))})` : ''
    const cat = t.category ? ` @${t.category}` : ''
    // Only call out the creator for tasks a delegator session created —
    // tasks from the admin's own (primary) session are the default, so
    // stating it every time would just be noise.
    const delegatedBy =
      t.createdBySessionIsPrimary === false ? ` [via ${t.createdBySessionLabel ?? t.createdBySessionPhone ?? 'delegated session'}]` : ''
    return `#${t.id} [${t.priority}]${cat} *${t.name}* — ${who} — ${STATUS_LABEL[t.status] ?? t.status}${due}${delegatedBy}`
  })

  const summary = `${counts.pending} pending, ${counts.needs_review} in review, ${counts.completed} completed`
  await sock.sendMessage(ownJid, {
    text: `Found ${matches.length} task(s) — ${summary}:\n\n${lines.join('\n')}`
  })
}

async function handleReportCommand(
  sock: WASocket,
  ownJid: string,
  organizationId: number,
  period: Parameters<typeof getReportData>[0],
  recipient: string | undefined,
  statusFilter: TaskStatus | undefined,
  dateRange: DateRange,
  category: string | undefined
): Promise<void> {
  try {
    const [data, branding] = await Promise.all([
      getReportData(period, recipient, statusFilter, dateRange, category, organizationId),
      loadReportBranding(organizationId)
    ])
    const pdf = await renderTaskReportPdf(data, branding)
    const filename = `task-report-${period}-${new Date().toISOString().slice(0, 10)}.pdf`
    const statusLabel = statusFilter ? STATUS_LABEL[statusFilter] : undefined
    const categoryLabel = category ? `@${category}` : undefined

    const captionParts = [data.periodLabel, recipient, statusLabel, categoryLabel].filter(Boolean)
    await sock.sendMessage(ownJid, {
      document: pdf,
      mimetype: 'application/pdf',
      fileName: filename,
      caption: `${captionParts.join(' · ')} — ${data.overall.total} task(s), ${data.overall.completionPercent}% completed`
    })
  } catch (err) {
    logger.warn({ err }, 'failed to generate/send report PDF')
    await sock.sendMessage(ownJid, { text: 'Sorry, something went wrong generating that report.' })
  }
}

async function handleCompleteCommand(sock: WASocket, ownJid: string, organizationId: number, taskId: number): Promise<void> {
  const task = await db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', taskId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!task) {
    await sock.sendMessage(ownJid, { text: `Task #${taskId} not found.` })
    return
  }

  await cancelTaskReminder(task.next_reminder_job_id)

  const completedAt = new Date()
  await db
    .updateTable('tasks')
    .set({ status: 'completed', completed_at: completedAt, next_reminder_job_id: null, updated_at: completedAt })
    .where('id', '=', taskId)
    .execute()

  await recordAuditLog({
    userId: null,
    action: 'task_completed',
    entityType: 'task',
    entityId: taskId,
    metadata: { via: 'whatsapp_command' }
  })

  if (task.is_recurring) {
    await scheduleRecurrence({ ...task, status: 'completed', completed_at: completedAt })
  }

  await sock.sendMessage(ownJid, { text: `✅ Marked *${task.name}* (#${taskId}) as completed.` })
}

async function handleRemindCommand(
  sock: WASocket,
  ownJid: string,
  organizationId: number,
  taskId: number,
  update: { stop: true } | { stop: false; timesPerDay: number | null; intervalDays: number | null; targetDate?: Date }
): Promise<void> {
  const task = await db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', taskId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!task) {
    await sock.sendMessage(ownJid, { text: `Task #${taskId} not found.` })
    return
  }

  await cancelTaskReminder(task.next_reminder_job_id)

  if (update.stop) {
    await db
      .updateTable('tasks')
      .set({ reminders_enabled: false, next_reminder_job_id: null, next_reminder_at: null, updated_at: new Date() })
      .where('id', '=', taskId)
      .execute()
    await sock.sendMessage(ownJid, { text: `🔕 Reminders stopped for *${task.name}* (#${taskId}).` })
    return
  }

  await db
    .updateTable('tasks')
    .set({
      reminder_times_per_day: update.timesPerDay,
      reminder_interval_days: update.intervalDays,
      target_date: update.targetDate ?? task.target_date,
      reminders_enabled: true,
      updated_at: new Date()
    })
    .where('id', '=', taskId)
    .execute()

  if (task.status === 'pending') {
    await scheduleNextReminder(taskId)
  }

  const cadenceText = update.timesPerDay ? `${update.timesPerDay}TAD` : `1IN${update.intervalDays}D`
  await sock.sendMessage(ownJid, { text: `⏰ Reminder for *${task.name}* (#${taskId}) set to ${cadenceText}.` })
}

async function handlePriorityCommand(
  sock: WASocket,
  ownJid: string,
  organizationId: number,
  taskId: number,
  priority: TaskPriority
): Promise<void> {
  const task = await db
    .selectFrom('tasks')
    .select(['name'])
    .where('id', '=', taskId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!task) {
    await sock.sendMessage(ownJid, { text: `Task #${taskId} not found.` })
    return
  }

  await db.updateTable('tasks').set({ priority, updated_at: new Date() }).where('id', '=', taskId).execute()

  await sock.sendMessage(ownJid, { text: `🔥 Priority for *${task.name}* (#${taskId}) set to ${priority}.` })
}

async function handleCategoryCommand(
  sock: WASocket,
  ownJid: string,
  organizationId: number,
  taskId: number,
  category: string
): Promise<void> {
  const task = await db
    .selectFrom('tasks')
    .select(['name'])
    .where('id', '=', taskId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!task) {
    await sock.sendMessage(ownJid, { text: `Task #${taskId} not found.` })
    return
  }

  await db.updateTable('tasks').set({ category, updated_at: new Date() }).where('id', '=', taskId).execute()

  await sock.sendMessage(ownJid, { text: `🏷️ Category for *${task.name}* (#${taskId}) set to @${category}.` })
}

async function handleChatCommand(sock: WASocket, ownJid: string, organizationId: number, taskId: number): Promise<void> {
  const task = await db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select(['tasks.name', 'tasks.recipient_jid', 'contacts.display_name as contactName', 'groups.subject as groupSubject'])
    .where('tasks.id', '=', taskId)
    .where('tasks.organization_id', '=', organizationId)
    .executeTakeFirst()

  if (!task) {
    await sock.sendMessage(ownJid, { text: `Task #${taskId} not found.` })
    return
  }

  const notes = await db
    .selectFrom('task_notes')
    .selectAll()
    .where('task_id', '=', taskId)
    .orderBy('created_at', 'asc')
    .limit(100)
    .execute()

  if (notes.length === 0) {
    await sock.sendMessage(ownJid, {
      text: `No chat logged for *${task.name}* (#${taskId}) yet. Reply (quote) to the task or a reminder message to log a note on it.`
    })
    return
  }

  const recipientLabel = recipientDisplayName(task.recipient_jid, task.contactName, task.groupSubject)
  const lines = notes.map((n) => {
    const who = n.from_admin ? 'You' : recipientLabel
    const time = new Date(n.created_at).toLocaleString()
    return `[${time}] ${who}: ${n.body}`
  })

  await sock.sendMessage(ownJid, { text: `💬 Chat log for *${task.name}* (#${taskId}):\n\n${lines.join('\n')}` })
}

// Looks up one task by #id or by a name search, then sends back its logged
// chat (optionally scoped to a single day). `replyToJid` is where the answer
// goes — the admin's own self-chat, or (when a task's own recipient DMs the
// admin directly) that person's chat. `restrictToJid` is null for the admin
// (any task) or a jid to scope the lookup to only tasks assigned to that
// person — never let someone query another person's task chat.
async function handleSummaryCommand(
  sock: WASocket,
  replyToJid: string,
  organizationId: number,
  identifier: string,
  date: Date | undefined,
  restrictToJid: string | null
): Promise<void> {
  let taskQuery = db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select(['tasks.id', 'tasks.name', 'tasks.recipient_jid', 'contacts.display_name as contactName', 'groups.subject as groupSubject'])
    .where('tasks.organization_id', '=', organizationId)

  if (restrictToJid) {
    const contactId = await resolveContactId(sock, restrictToJid, organizationId).catch(() => null)
    taskQuery = taskQuery.where((eb) => {
      const conditions = [eb('tasks.recipient_jid', '=', restrictToJid)]
      if (contactId) conditions.push(eb('tasks.contact_id', '=', contactId))
      return eb.or(conditions)
    })
  }

  taskQuery = /^\d+$/.test(identifier.trim())
    ? taskQuery.where('tasks.id', '=', Number(identifier.trim()))
    : taskQuery.where('tasks.name', 'ilike', `%${identifier.trim()}%`)

  const matches = await taskQuery.orderBy('tasks.created_at', 'desc').limit(6).execute()

  if (matches.length === 0) {
    await sock.sendMessage(replyToJid, { text: `No task found matching "${identifier}".` })
    return
  }

  if (matches.length > 1) {
    const lines = matches.map((t) => `#${t.id} ${t.name}`)
    await sock.sendMessage(replyToJid, {
      text: `Multiple tasks match "${identifier}" — reply with the #id instead:\n\n${lines.join('\n')}`
    })
    return
  }

  const task = matches[0]!
  const dateText = date ? ` on ${formatShortDate(date)}` : ''

  let notesQuery = db.selectFrom('task_notes').selectAll().where('task_id', '=', task.id).orderBy('created_at', 'asc').limit(200)
  if (date) {
    const dayStart = new Date(date)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart)
    dayEnd.setDate(dayEnd.getDate() + 1)
    notesQuery = notesQuery.where('created_at', '>=', dayStart).where('created_at', '<', dayEnd)
  }
  const notes = await notesQuery.execute()

  if (notes.length === 0) {
    await sock.sendMessage(replyToJid, { text: `No chat logged for *${task.name}* (#${task.id})${dateText}.` })
    return
  }

  // Label each note from the viewer's own perspective — "You" for their own
  // messages, the other side's name/"Admin" otherwise.
  const viewerIsAdmin = restrictToJid === null
  const recipientLabel = recipientDisplayName(task.recipient_jid, task.contactName, task.groupSubject)
  const lines = notes.map((n) => {
    const who = n.from_admin ? (viewerIsAdmin ? 'You' : 'Admin') : viewerIsAdmin ? recipientLabel : 'You'
    const time = new Date(n.created_at).toLocaleString()
    return `[${time}] ${who}: ${n.body}`
  })

  await sock.sendMessage(replyToJid, { text: `💬 Summary for *${task.name}* (#${task.id})${dateText}:\n\n${lines.join('\n')}` })
}

async function handleRecurCommand(
  sock: WASocket,
  ownJid: string,
  organizationId: number,
  taskId: number,
  update: { off: true } | { off: false; intervalValue: number; intervalUnit: RecurrenceUnit; time?: string }
): Promise<void> {
  const task = await db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', taskId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  if (!task) {
    await sock.sendMessage(ownJid, { text: `Task #${taskId} not found.` })
    return
  }

  if (update.off) {
    await cancelRecurrence(task.next_recurrence_job_id)
    await db
      .updateTable('tasks')
      .set({ is_recurring: false, next_recurrence_job_id: null, updated_at: new Date() })
      .where('id', '=', taskId)
      .execute()
    await sock.sendMessage(ownJid, { text: `🔁 Recurrence turned off for *${task.name}* (#${taskId}).` })
    return
  }

  await db
    .updateTable('tasks')
    .set({
      is_recurring: true,
      recurrence_interval_value: update.intervalValue,
      recurrence_interval_unit: update.intervalUnit,
      recurrence_time: update.time ?? null,
      updated_at: new Date()
    })
    .where('id', '=', taskId)
    .execute()

  const timeText = update.time ? ` at ${update.time}` : ''
  await sock.sendMessage(ownJid, {
    text: `🔁 *${task.name}* (#${taskId}) will recreate itself every ${update.intervalValue} ${update.intervalUnit}${timeText} after it's completed.`
  })
}

// A self-chat message's remoteJid can arrive in either PN or LID form
// depending on which identity Baileys negotiated for this session — they
// won't string-match even though they're the same chat. Baileys carries the
// other form on `remoteJidAlt` specifically so callers can check both
// (see WhiskeySockets' own getKeyAuthor helper, which does the same thing).
// Never compare JIDs with `===` directly — always go through areJidsSameUser
// so device suffixes don't cause false negatives either.
function isSelfChat(m: WAMessage, ownJid: string): boolean {
  const remote = m.key.remoteJid
  const remoteAlt = m.key.remoteJidAlt
  if (remote && areJidsSameUser(remote, ownJid)) return true
  if (remoteAlt && areJidsSameUser(remoteAlt, ownJid)) return true
  return false
}

// Every command except /summary only ever acts on messages you send
// yourself, in your own self-chat — this keeps report/status/etc commands
// from accidentally firing in a normal conversation with someone else.
// /summary is the one exception: it also fires as a direct message from a
// task's own recipient straight to the admin's number (not self-chat), so
// people can pull up their own task's chat log without needing admin
// access — see handleSummaryCommand for how that gets scoped to their own
// tasks only.
// `organizationId` is the organization that owns the WhatsApp session which
// received this message — every command scopes its task queries to it, so
// two sessions in the *same* organization see and can manage the exact same
// shared task pool (regardless of which of them created a given task),
// while a session in a *different* organization never sees it at all.
export async function handleCommandMessage(
  sock: WASocket,
  ownJid: string | null,
  m: WAMessage,
  organizationId: number
): Promise<void> {
  if (!ownJid || !m.key.remoteJid) return

  const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text
  if (!text) return

  const command = parseCommand(text)
  if (!command) return

  const selfChat = Boolean(m.key.fromMe) && isSelfChat(m, ownJid)

  if (command.type === 'summary') {
    if (selfChat) {
      await handleSummaryCommand(sock, ownJid, organizationId, command.identifier, command.date, null)
    } else if (!m.key.fromMe && !isJidGroup(m.key.remoteJid)) {
      await handleSummaryCommand(sock, m.key.remoteJid, organizationId, command.identifier, command.date, m.key.remoteJid)
    }
    return
  }

  if (!selfChat) return

  if (command.type === 'help') {
    await sock.sendMessage(ownJid, { text: HELP_TEXT })
  } else if (command.type === 'status') {
    await handleStatusCommand(
      sock,
      ownJid,
      organizationId,
      command.query,
      command.statusFilter,
      command.category,
      command.dateFrom,
      command.dateTo
    )
  } else if (command.type === 'report') {
    await handleReportCommand(
      sock,
      ownJid,
      organizationId,
      command.period,
      command.recipient,
      command.statusFilter,
      { from: command.dateFrom, to: command.dateTo },
      command.category
    )
  } else if (command.type === 'complete') {
    await handleCompleteCommand(sock, ownJid, organizationId, command.taskId)
  } else if (command.type === 'chat') {
    await handleChatCommand(sock, ownJid, organizationId, command.taskId)
  } else if (command.type === 'remind') {
    await handleRemindCommand(
      sock,
      ownJid,
      organizationId,
      command.taskId,
      command.stop
        ? { stop: true }
        : { stop: false, timesPerDay: command.timesPerDay, intervalDays: command.intervalDays, targetDate: command.targetDate }
    )
  } else if (command.type === 'recur') {
    await handleRecurCommand(
      sock,
      ownJid,
      organizationId,
      command.taskId,
      command.off
        ? { off: true }
        : { off: false, intervalValue: command.intervalValue, intervalUnit: command.intervalUnit, time: command.time }
    )
  } else if (command.type === 'priority') {
    await handlePriorityCommand(sock, ownJid, organizationId, command.taskId, command.priority)
  } else if (command.type === 'category') {
    await handleCategoryCommand(sock, ownJid, organizationId, command.taskId, command.category)
  }
}
