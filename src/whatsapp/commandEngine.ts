import { areJidsSameUser, type WASocket, type WAMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from '../db/index.js'
import { isProduction } from '../config/env.js'
import { parseCommand } from './commandParser.js'
import { getReportData, type DateRange } from '../reports/taskMetrics.js'
import { renderTaskReportPdf } from '../reports/taskReportPdf.js'
import { recipientDisplayName } from '../lib/recipientDisplay.js'
import { recordAuditLog } from '../lib/auditLog.js'
import { scheduleNextReminder, cancelTaskReminder } from '../queue/taskReminders.js'
import { scheduleRecurrence, cancelRecurrence } from '../queue/recurringTasks.js'
import type { TaskStatus, TaskFrequency, RecurrenceUnit } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

const HELP_TEXT = `*WA Messenger commands*
/help — show this message

*View tasks*
/status <task or employee name> — everything matching, any status
/status <name> pending|completed|review — filtered to that status
/status <name> from YYYY-MM-DD to YYYY-MM-DD — filtered to a date range
(any combination of name / status / date range works together)

*Reports (PDF)*
/report — all employees, all time
/report daily|weekly|monthly — scoped to a period
/report pending|completed|review — scoped to a status
/report <name or number> — one employee
/report from YYYY-MM-DD to YYYY-MM-DD — a custom date range
(mix and match: e.g. "/report Priya completed from 2026-08-01 to 2026-08-15")

*Act on a task* (get the #id from /status)
/complete <id> — mark a task completed
/remind <id> every hourly|daily|weekly [until YYYY-MM-DD] — set/change its reminder
/remind <id> stop — turn reminders off without deleting it
/recur <id> every <N> days|weeks [at HH:MM] — recreate this task automatically N days/weeks after it's completed
/recur <id> off — stop it from recreating`

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  needs_review: 'Needs Review',
  completed: 'Completed'
}

// Sort actionable items first: pending, then needs review, then completed.
const STATUS_SORT_ORDER: Record<string, number> = {
  pending: 0,
  needs_review: 1,
  completed: 2
}

async function handleStatusCommand(
  sock: WASocket,
  ownJid: string,
  query: string,
  statusFilter?: TaskStatus,
  dateFrom?: Date,
  dateTo?: Date
): Promise<void> {
  let dbQuery = db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select([
      'tasks.id',
      'tasks.name',
      'tasks.status',
      'tasks.recipient_jid',
      'tasks.target_date',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject'
    ])
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

  if (dateFrom) dbQuery = dbQuery.where('tasks.created_at', '>=', dateFrom)
  if (dateTo) {
    const exclusiveEnd = new Date(dateTo)
    exclusiveEnd.setDate(exclusiveEnd.getDate() + 1)
    dbQuery = dbQuery.where('tasks.created_at', '<', exclusiveEnd)
  }

  const matches = await dbQuery.execute()

  if (matches.length === 0) {
    const desc = [query && `"${query}"`, statusFilter && STATUS_LABEL[statusFilter]].filter(Boolean).join(' — ')
    await sock.sendMessage(ownJid, { text: `No tasks found matching ${desc || 'that'}.` })
    return
  }

  matches.sort((a, b) => (STATUS_SORT_ORDER[a.status] ?? 9) - (STATUS_SORT_ORDER[b.status] ?? 9))

  const counts = { pending: 0, needs_review: 0, completed: 0 } as Record<TaskStatus, number>
  for (const t of matches) counts[t.status] = (counts[t.status] ?? 0) + 1

  const lines = matches.map((t) => {
    const who = recipientDisplayName(t.recipient_jid, t.contactName, t.groupSubject)
    const due = t.target_date ? ` (due ${new Date(t.target_date).toISOString().slice(0, 10)})` : ''
    return `#${t.id} *${t.name}* — ${who} — ${STATUS_LABEL[t.status] ?? t.status}${due}`
  })

  const summary = `${counts.pending} pending, ${counts.needs_review} in review, ${counts.completed} completed`
  await sock.sendMessage(ownJid, {
    text: `Found ${matches.length} task(s) — ${summary}:\n\n${lines.join('\n')}`
  })
}

async function handleReportCommand(
  sock: WASocket,
  ownJid: string,
  period: Parameters<typeof getReportData>[0],
  recipient: string | undefined,
  statusFilter: TaskStatus | undefined,
  dateRange: DateRange
): Promise<void> {
  try {
    const data = await getReportData(period, recipient, statusFilter, dateRange)
    const pdf = await renderTaskReportPdf(data)
    const filename = `task-report-${period}-${new Date().toISOString().slice(0, 10)}.pdf`
    const statusLabel = statusFilter ? STATUS_LABEL[statusFilter] : undefined

    const captionParts = [data.periodLabel, recipient, statusLabel].filter(Boolean)
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

async function handleCompleteCommand(sock: WASocket, ownJid: string, taskId: number): Promise<void> {
  const task = await db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst()
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
  taskId: number,
  update: { stop: true } | { stop: false; frequency: TaskFrequency; targetDate?: Date }
): Promise<void> {
  const task = await db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst()
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
      reminder_frequency: update.frequency,
      target_date: update.targetDate ?? task.target_date,
      reminders_enabled: true,
      updated_at: new Date()
    })
    .where('id', '=', taskId)
    .execute()

  if (task.status === 'pending') {
    await scheduleNextReminder(taskId, update.frequency)
  }

  await sock.sendMessage(ownJid, { text: `⏰ Reminder for *${task.name}* (#${taskId}) set to ${update.frequency}.` })
}

async function handleRecurCommand(
  sock: WASocket,
  ownJid: string,
  taskId: number,
  update: { off: true } | { off: false; intervalValue: number; intervalUnit: RecurrenceUnit; time?: string }
): Promise<void> {
  const task = await db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst()
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

// Only ever acts on messages you send yourself, in your own self-chat — this
// keeps report/status commands from accidentally firing in a normal
// conversation with someone else.
export async function handleCommandMessage(sock: WASocket, ownJid: string | null, m: WAMessage): Promise<void> {
  if (!ownJid || !m.key.fromMe || !isSelfChat(m, ownJid)) return

  const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text
  if (!text) return

  const command = parseCommand(text)
  if (!command) return

  if (command.type === 'help') {
    await sock.sendMessage(ownJid, { text: HELP_TEXT })
  } else if (command.type === 'status') {
    await handleStatusCommand(sock, ownJid, command.query, command.statusFilter, command.dateFrom, command.dateTo)
  } else if (command.type === 'report') {
    await handleReportCommand(sock, ownJid, command.period, command.recipient, command.statusFilter, {
      from: command.dateFrom,
      to: command.dateTo
    })
  } else if (command.type === 'complete') {
    await handleCompleteCommand(sock, ownJid, command.taskId)
  } else if (command.type === 'remind') {
    await handleRemindCommand(
      sock,
      ownJid,
      command.taskId,
      command.stop ? { stop: true } : { stop: false, frequency: command.frequency, targetDate: command.targetDate }
    )
  } else if (command.type === 'recur') {
    await handleRecurCommand(
      sock,
      ownJid,
      command.taskId,
      command.off
        ? { off: true }
        : { off: false, intervalValue: command.intervalValue, intervalUnit: command.intervalUnit, time: command.time }
    )
  }
}
