import { areJidsSameUser, isJidGroup, type WASocket } from '@whiskeysockets/baileys'
import { db } from '../db/index.js'
import { logger } from '../lib/logger.js'
import { recordAuditLog } from '../lib/auditLog.js'
import { completeTask } from '../lib/taskCompletion.js'
import { formatIsoDate, formatShortDate } from '../lib/dateFormat.js'
import { recipientDisplayName } from '../lib/recipientDisplay.js'
import { getReportData, type ReportPeriod } from '../reports/taskMetrics.js'
import { cancelTaskReminder, scheduleNextReminder } from '../queue/taskReminders.js'
import { insertTask, linkTaskMessage, resolveContactId } from '../whatsapp/taskEngine.js'
import { handleReportCommand } from '../whatsapp/commandEngine.js'
import type { FunctionTool } from './openai.js'
import type { TaskPriority, TaskStatus, TaskUpdate } from '../db/schema.js'

// Everything a tool call is allowed to touch. `mode` and `access` decide
// which tools are offered at all (see allowedToolNames): the admin's own
// self-chat gets the full assistant; an @ai typed into somebody else's chat
// or a group can only create a task for that chat, so organization data is
// never posted where the other party can read it; the portal's AI Assistant
// page gets the data tools, plus the task-changing ones only in "write".
export interface AiContext {
  // The WhatsApp session that sends task messages — the one the @ai message
  // arrived on, or for the portal the organization's primary session (null
  // when it isn't connected: reads still work, creating a task doesn't).
  sock: WASocket | null
  organizationId: number
  sessionId: number | null
  ownJid: string | null
  mode: 'self' | 'chat' | 'portal'
  access: 'read' | 'write'
  // Portal user who's asking (audit logs), null on WhatsApp.
  userId: number | null
  chatJid: string
  chatLabel: string
  triggerMessageId: string | null
  mentionedJids: string[]
  // Filled in as tools run — used for the reply routing and the audit log.
  createdTaskIds: number[]
  writeCount: number
  sentMessageIds: string[]
}

// One request can't fan out into an unbounded number of task changes, e.g.
// a misread "complete everything".
const MAX_WRITES_PER_REQUEST = 10
const MAX_LIST_LIMIT = 50
const MAX_SCAN_ROWS = 5000
const MAX_TOOL_OUTPUT_CHARS = 20_000

class ToolError extends Error {}

const STATUSES: TaskStatus[] = ['pending', 'needs_review', 'completed']
const PRIORITIES: TaskPriority[] = ['P1', 'P2', 'P3', 'P4']
const PRIORITY_RANK: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 }

// --- small helpers ---------------------------------------------------------

// Dates cross the tool boundary as YYYY-MM-DD in the server's own timezone
// (IST — see the Dockerfile's TZ), the same local-date convention
// parseShortDate()/formatIsoDate() use everywhere else.
function parseDay(value: string | null, field: string): Date | null {
  if (value === null || value.trim() === '') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) throw new ToolError(`${field} must be a date in YYYY-MM-DD format, got "${value}".`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new ToolError(`${field} "${value}" is not a real calendar date.`)
  }
  return date
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function formatDateTime(date: Date | null): string | null {
  if (!date) return null
  const d = new Date(date)
  return `${formatIsoDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatDay(date: Date | null): string | null {
  return date ? formatIsoDate(new Date(date)) : null
}

// "@acc", "ACC" → "acc" — the same free-form, lowercase single-word shape
// the #task "@category" shorthand produces.
function normalizeCategory(value: string | null): string | null {
  if (value === null) return null
  const cleaned = value.trim().replace(/^@/, '').toLowerCase()
  if (!cleaned) return null
  if (!/^\w+$/.test(cleaned)) throw new ToolError(`Category must be a single word like "acc" or "pur", got "${value}".`)
  return cleaned
}

function pnJid(phoneDigits: string): string {
  return `${phoneDigits}@s.whatsapp.net`
}

function reminderText(timesPerDay: number | null, intervalDays: number | null, enabled = true): string {
  if (!enabled) return 'off'
  if (timesPerDay) return timesPerDay === 1 ? 'once a day' : `${timesPerDay}× a day`
  if (intervalDays) return intervalDays === 1 ? 'every day' : `every ${intervalDays} days`
  return 'none'
}

function claimWrite(ctx: AiContext): void {
  if (ctx.writeCount >= MAX_WRITES_PER_REQUEST) {
    throw new ToolError(`Limit of ${MAX_WRITES_PER_REQUEST} task changes per request reached — ask the user to send the rest as a new request.`)
  }
  ctx.writeCount++
}

// --- task queries ----------------------------------------------------------

function baseTaskQuery(organizationId: number) {
  return (
    db
      .selectFrom('tasks')
      .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
      // Groups are stored once per organization — join on both so the same
      // real group synced by two orgs can't duplicate a task row.
      .leftJoin('groups', (join) =>
        join.onRef('groups.wa_jid', '=', 'tasks.recipient_jid').onRef('groups.organization_id', '=', 'tasks.organization_id')
      )
      .leftJoin('whatsapp_sessions', 'whatsapp_sessions.id', 'tasks.created_by_session_id')
      .select([
        'tasks.id',
        'tasks.name',
        'tasks.category',
        'tasks.priority',
        'tasks.status',
        'tasks.recipient_jid',
        'tasks.assigned_jid',
        'tasks.target_date',
        'tasks.created_at',
        'tasks.completed_at',
        'tasks.never_completes',
        'tasks.reminders_enabled',
        'tasks.reminder_times_per_day',
        'tasks.reminder_interval_days',
        'tasks.next_reminder_at',
        'tasks.is_recurring',
        'contacts.display_name as contactName',
        'contacts.phone_number as contactPhone',
        'groups.subject as groupSubject',
        'whatsapp_sessions.label as createdBySessionLabel',
        'whatsapp_sessions.is_primary as createdBySessionIsPrimary'
      ])
      .where('tasks.organization_id', '=', organizationId)
  )
}

type TaskRow = Awaited<ReturnType<ReturnType<typeof baseTaskQuery>['execute']>>[number]

function isOverdue(row: TaskRow, todayStart: Date): boolean {
  return row.status !== 'completed' && !row.never_completes && row.target_date !== null && new Date(row.target_date) < todayStart
}

function assigneeLabel(row: TaskRow): string {
  if (row.contactName) return row.contactName
  if (row.assigned_jid) return row.contactPhone ?? row.assigned_jid.split('@')[0]!
  return recipientDisplayName(row.recipient_jid, null, row.groupSubject)
}

function summarizeTask(row: TaskRow, todayStart: Date) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    priority: row.priority,
    category: row.category,
    assignee: assigneeLabel(row),
    group: isJidGroup(row.recipient_jid) ? (row.groupSubject ?? 'a group') : null,
    created: formatDateTime(row.created_at),
    due: formatDay(row.target_date),
    completed: formatDateTime(row.completed_at),
    overdue: isOverdue(row, todayStart),
    standing: row.never_completes,
    // Only worth stating for tasks a delegator session created — the
    // admin's own (primary) session is the default.
    delegated_by: row.createdBySessionIsPrimary === false ? (row.createdBySessionLabel ?? 'a delegator session') : null
  }
}

interface QueryTasksArgs {
  status: TaskStatus[] | null
  assignee: string | null
  text: string | null
  category: string | null
  priority: TaskPriority | null
  created_from: string | null
  created_to: string | null
  completed_from: string | null
  completed_to: string | null
  due_from: string | null
  due_to: string | null
  overdue_only: boolean | null
  group_by: 'assignee' | 'category' | 'priority' | 'status' | null
  sort: 'newest' | 'oldest' | 'due_date' | 'priority' | null
  limit: number | null
}

async function queryTasks(ctx: AiContext, args: QueryTasksArgs) {
  const todayStart = startOfToday()
  let query = baseTaskQuery(ctx.organizationId)

  const statuses = (args.status ?? []).filter((s) => STATUSES.includes(s))
  if (statuses.length > 0) query = query.where('tasks.status', 'in', statuses)

  if (args.assignee?.trim()) {
    const like = `%${args.assignee.trim()}%`
    query = query.where((eb) =>
      eb.or([
        eb('contacts.display_name', 'ilike', like),
        eb('contacts.phone_number', 'ilike', like),
        eb('groups.subject', 'ilike', like),
        eb('tasks.recipient_jid', 'ilike', like)
      ])
    )
  }
  if (args.text?.trim()) query = query.where('tasks.name', 'ilike', `%${args.text.trim()}%`)

  const category = normalizeCategory(args.category)
  if (category) query = query.where('tasks.category', '=', category)
  if (args.priority) query = query.where('tasks.priority', '=', args.priority)

  const createdFrom = parseDay(args.created_from, 'created_from')
  const createdTo = parseDay(args.created_to, 'created_to')
  const completedFrom = parseDay(args.completed_from, 'completed_from')
  const completedTo = parseDay(args.completed_to, 'completed_to')
  const dueFrom = parseDay(args.due_from, 'due_from')
  const dueTo = parseDay(args.due_to, 'due_to')
  // Every *_to bound is inclusive of that whole day.
  if (createdFrom) query = query.where('tasks.created_at', '>=', createdFrom)
  if (createdTo) query = query.where('tasks.created_at', '<', addDays(createdTo, 1))
  if (completedFrom) query = query.where('tasks.completed_at', '>=', completedFrom)
  if (completedTo) query = query.where('tasks.completed_at', '<', addDays(completedTo, 1))
  if (dueFrom) query = query.where('tasks.target_date', '>=', dueFrom)
  if (dueTo) query = query.where('tasks.target_date', '<', addDays(dueTo, 1))

  if (args.overdue_only) {
    query = query
      .where('tasks.status', '!=', 'completed')
      .where('tasks.never_completes', '=', false)
      .where('tasks.target_date', '<', todayStart)
  }

  const rows = await query.orderBy('tasks.created_at', 'desc').limit(MAX_SCAN_ROWS).execute()

  const counts = { pending: 0, needs_review: 0, completed: 0, overdue: 0 }
  for (const row of rows) {
    counts[row.status]++
    if (isOverdue(row, todayStart)) counts.overdue++
  }

  let groups: { key: string; total: number; pending: number; needs_review: number; completed: number; overdue: number }[] | undefined
  if (args.group_by) {
    const byKey = new Map<string, NonNullable<typeof groups>[number]>()
    for (const row of rows) {
      const key =
        args.group_by === 'assignee'
          ? assigneeLabel(row)
          : args.group_by === 'category'
            ? (row.category ?? '(no category)')
            : args.group_by === 'priority'
              ? row.priority
              : row.status
      const entry = byKey.get(key) ?? { key, total: 0, pending: 0, needs_review: 0, completed: 0, overdue: 0 }
      entry.total++
      entry[row.status]++
      if (isOverdue(row, todayStart)) entry.overdue++
      byKey.set(key, entry)
    }
    groups = [...byKey.values()].sort((a, b) => b.total - a.total)
  }

  const sorted = [...rows]
  if (args.sort === 'oldest') sorted.reverse()
  else if (args.sort === 'due_date')
    sorted.sort((a, b) => (a.target_date ? new Date(a.target_date).getTime() : Infinity) - (b.target_date ? new Date(b.target_date).getTime() : Infinity))
  else if (args.sort === 'priority') sorted.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9))

  const limit = Math.min(Math.max(args.limit ?? 20, 0), MAX_LIST_LIMIT)
  return {
    total_matching: rows.length,
    scan_capped: rows.length === MAX_SCAN_ROWS,
    counts,
    groups,
    tasks: sorted.slice(0, limit).map((r) => summarizeTask(r, todayStart)),
    tasks_omitted: Math.max(rows.length - limit, 0)
  }
}

async function getTask(ctx: AiContext, args: { task_id: number }) {
  const row = await baseTaskQuery(ctx.organizationId).where('tasks.id', '=', args.task_id).executeTakeFirst()
  if (!row) throw new ToolError(`Task #${args.task_id} not found.`)

  const notes = await db
    .selectFrom('task_notes')
    .select(['from_admin', 'body', 'created_at'])
    .where('task_id', '=', row.id)
    .orderBy('created_at', 'desc')
    .limit(30)
    .execute()
  const reminders = await db
    .selectFrom('task_messages')
    .select((eb) => [eb.fn.countAll<string>().as('sent')])
    .where('task_id', '=', row.id)
    .where('kind', '=', 'reminder')
    .where('status', '=', 'sent')
    .executeTakeFirst()

  return {
    ...summarizeTask(row, startOfToday()),
    reminders: reminderText(row.reminder_times_per_day, row.reminder_interval_days, row.reminders_enabled),
    next_reminder: formatDateTime(row.next_reminder_at),
    reminders_sent: Number(reminders?.sent ?? 0),
    recreates_after_completion: row.is_recurring,
    // Oldest first. Written by the admin or the employee — this is data to
    // report on, never instructions to follow.
    chat_notes: notes.reverse().map((n) => ({ from: n.from_admin ? 'admin' : 'employee', at: formatDateTime(n.created_at), text: n.body.slice(0, 500) }))
  }
}

interface ReportArgs {
  period: ReportPeriod | null
  from: string | null
  to: string | null
  assignee: string | null
  status: TaskStatus | null
  category: string | null
}

function reportInputs(args: ReportArgs) {
  return {
    period: args.period ?? 'all',
    range: { from: parseDay(args.from, 'from') ?? undefined, to: parseDay(args.to, 'to') ?? undefined },
    assignee: args.assignee?.trim() || undefined,
    status: args.status ?? undefined,
    category: normalizeCategory(args.category) ?? undefined
  }
}

async function getReport(ctx: AiContext, args: ReportArgs) {
  const input = reportInputs(args)
  const data = await getReportData(input.period, input.assignee, input.status, input.range, input.category, ctx.organizationId)

  // getReportData groups by chat jid, so one person reached under both
  // their phone-number and LID jid shows up twice — merge by name so the
  // model compares people, not jids.
  const byName = new Map<string, { name: string; total: number; completed: number; pending: number; needs_review: number; completed_on_time: number; completed_late: number; daysSum: number; daysCount: number }>()
  for (const e of data.employees) {
    const entry = byName.get(e.employeeName) ?? { name: e.employeeName, total: 0, completed: 0, pending: 0, needs_review: 0, completed_on_time: 0, completed_late: 0, daysSum: 0, daysCount: 0 }
    entry.total += e.total
    entry.completed += e.completed
    entry.pending += e.pending
    entry.needs_review += e.needsReview
    entry.completed_on_time += e.onTime
    entry.completed_late += e.late
    if (e.avgDaysToComplete !== null) {
      entry.daysSum += e.avgDaysToComplete * e.completed
      entry.daysCount += e.completed
    }
    byName.set(e.employeeName, entry)
  }
  const employees = [...byName.values()]
    .sort((a, b) => b.total - a.total)
    .map(({ daysSum, daysCount, ...e }) => ({
      ...e,
      completion_percent: e.total > 0 ? Math.round((e.completed / e.total) * 100) : 0,
      avg_days_to_complete: daysCount > 0 ? Math.round((daysSum / daysCount) * 10) / 10 : null
    }))

  return {
    period: data.periodLabel,
    note: 'Covers tasks CREATED in this period, whatever their status now.',
    overall: data.overall,
    employees: employees.slice(0, 40),
    employees_omitted: Math.max(employees.length - 40, 0)
  }
}

async function sendReportPdf(ctx: AiContext, args: ReportArgs) {
  const input = reportInputs(args)
  if (!ctx.sock || !ctx.ownJid) throw new ToolError('WhatsApp is not connected, so the PDF cannot be sent right now.')
  await handleReportCommand(ctx.sock, ctx.ownJid, ctx.organizationId, input.period, input.assignee, input.status, input.range, input.category)
  return { sent: true, note: 'The PDF was sent to this chat as a separate message.' }
}

async function findRecipients(ctx: AiContext, args: { query: string }) {
  const term = args.query.trim()
  if (!term) throw new ToolError('query must not be empty.')
  const like = `%${term}%`
  const digits = term.replace(/\D/g, '')

  const contacts = await db
    .selectFrom('contacts')
    .select(['id', 'display_name', 'phone_number'])
    .where('organization_id', '=', ctx.organizationId)
    .where((eb) => {
      const conditions = [eb('display_name', 'ilike', like)]
      if (digits.length >= 4) conditions.push(eb('phone_number', 'like', `%${digits}%`))
      return eb.or(conditions)
    })
    .orderBy('display_name', 'asc')
    .limit(10)
    .execute()

  const groups = await db
    .selectFrom('groups')
    .select(['wa_jid', 'subject', 'participant_count'])
    .where('organization_id', '=', ctx.organizationId)
    .where('subject', 'ilike', like)
    .orderBy('subject', 'asc')
    .limit(10)
    .execute()

  return {
    contacts: contacts.map((c) => ({ name: c.display_name, phone: c.phone_number, jid: pnJid(c.phone_number) })),
    groups: groups.map((g) => ({ name: g.subject, jid: g.wa_jid, participants: g.participant_count }))
  }
}

// --- task changes ----------------------------------------------------------

// A recipient the model names must be one of this organization's own
// contacts or groups — never an arbitrary number the model made up or
// copied out of a task note.
async function resolveOrgRecipient(ctx: AiContext, jid: string): Promise<{ jid: string; label: string } | null> {
  const trimmed = jid.trim()
  if (isJidGroup(trimmed)) {
    const group = await db
      .selectFrom('groups')
      .select(['wa_jid', 'subject'])
      .where('organization_id', '=', ctx.organizationId)
      .where('wa_jid', '=', trimmed)
      .executeTakeFirst()
    return group ? { jid: group.wa_jid, label: group.subject } : null
  }
  const user = trimmed.split('@')[0]?.split(':')[0] ?? ''
  const contact = await db
    .selectFrom('contacts')
    .select(['display_name', 'phone_number'])
    .where('organization_id', '=', ctx.organizationId)
    .where((eb) => eb.or([eb('wa_jid', '=', trimmed), eb('phone_number', '=', user)]))
    .executeTakeFirst()
  return contact ? { jid: pnJid(contact.phone_number), label: contact.display_name ?? contact.phone_number } : null
}

interface CreateTaskArgs {
  name: string
  recipient_jid: string | null
  assignee_jids: string[]
  category: string | null
  priority: TaskPriority | null
  times_per_day: number | null
  interval_days: number | null
  target_date: string | null
  standing: boolean
}

function buildTaskCard(input: {
  taskIds: number[]
  name: string
  priority: TaskPriority
  category: string | null
  assigneeJids: string[]
  targetDate: Date | null
  timesPerDay: number | null
  intervalDays: number | null
  standing: boolean
}): string {
  const header = [`📌 *New task* ${input.taskIds.map((id) => `#${id}`).join(', ')}`, input.priority, input.category && `@${input.category}`]
    .filter(Boolean)
    .join(' · ')
  const lines = [header, `*${input.name}*`]
  if (input.assigneeJids.length > 0) lines.push(`👤 ${input.assigneeJids.map((j) => `@${j.split('@')[0]}`).join(' ')}`)
  if (input.targetDate) lines.push(`📅 Due ${formatShortDate(input.targetDate)}`)
  const reminders = reminderText(input.timesPerDay, input.intervalDays)
  if (reminders !== 'none') lines.push(`⏰ Reminders ${reminders}`)
  if (input.standing) lines.push('🔁 Standing task — reminders continue until turned off')
  else lines.push("Reply *done* to this message when it's finished.")
  return lines.join('\n')
}

async function createTaskTool(ctx: AiContext, args: CreateTaskArgs) {
  const name = args.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new ToolError('name must not be empty.')
  if (name.length > 300) throw new ToolError('name is too long — keep it under 300 characters and put detail in the task name concisely.')

  const priority = args.priority ?? 'P3'
  if (!PRIORITIES.includes(priority)) throw new ToolError('priority must be P1, P2, P3 or P4.')
  const category = normalizeCategory(args.category)

  if (args.times_per_day !== null && args.interval_days !== null) {
    throw new ToolError('Set either times_per_day or interval_days, not both.')
  }
  if (args.times_per_day !== null && (args.times_per_day < 1 || args.times_per_day > 6)) throw new ToolError('times_per_day must be 1–6.')
  if (args.interval_days !== null && (args.interval_days < 1 || args.interval_days > 90)) throw new ToolError('interval_days must be 1–90.')

  const targetDate = parseDay(args.target_date, 'target_date')
  if (targetDate && targetDate < startOfToday()) throw new ToolError(`target_date ${args.target_date} is in the past — confirm the intended date with the user.`)

  let recipientJid: string
  let recipientLabel: string
  if (ctx.mode === 'chat') {
    if (args.recipient_jid && !areJidsSameUser(args.recipient_jid, ctx.chatJid)) {
      throw new ToolError('From inside a chat, a task can only be created for that same chat (leave recipient_jid null).')
    }
    recipientJid = ctx.chatJid
    recipientLabel = ctx.chatLabel
  } else {
    if (!args.recipient_jid) throw new ToolError('recipient_jid is required — look the person or group up with find_recipients first.')
    const recipient = await resolveOrgRecipient(ctx, args.recipient_jid)
    if (!recipient) throw new ToolError(`${args.recipient_jid} is not one of this organization's contacts or groups — use a jid returned by find_recipients.`)
    if (!isJidGroup(recipient.jid) && ctx.ownJid && areJidsSameUser(recipient.jid, ctx.ownJid)) {
      throw new ToolError("That is the admin's own number — tasks must be assigned to someone else.")
    }
    recipientJid = recipient.jid
    recipientLabel = recipient.label
  }

  // Specific assignees only make sense inside a group; a 1:1 chat's task is
  // simply for that person.
  const assigneeJids: string[] = []
  if (isJidGroup(recipientJid)) {
    for (const jid of args.assignee_jids) {
      let resolved: string | null = null
      if (ctx.mode === 'chat') {
        resolved = ctx.mentionedJids.find((m) => areJidsSameUser(m, jid)) ?? null
        if (!resolved) throw new ToolError(`${jid} was not @mentioned in the message — only mentioned people can be assigned here.`)
      } else {
        resolved = (await resolveOrgRecipient(ctx, jid))?.jid ?? null
        if (!resolved || isJidGroup(resolved)) throw new ToolError(`${jid} is not one of this organization's contacts.`)
      }
      if (!assigneeJids.some((a) => areJidsSameUser(a, resolved!))) assigneeJids.push(resolved)
    }
  }

  // The recipient has to actually receive the task message for replies and
  // reminders to work, so don't create a task WhatsApp can't deliver.
  const sock = ctx.sock
  if (!sock) throw new ToolError("The organization's main WhatsApp number is not connected, so the task message can't be sent. Reconnect it on the WhatsApp Connection page and try again.")

  claimWrite(ctx)

  const assignees = assigneeJids.length > 0 ? assigneeJids : [null]
  const taskIds: number[] = []
  for (const assignedJid of assignees) {
    const contactId = await resolveContactId(sock, assignedJid ?? recipientJid, ctx.organizationId)
    const taskId = await insertTask(
      {
        recipientJid,
        contactId,
        assignedJid,
        name,
        category,
        priority,
        timesPerDay: args.times_per_day,
        intervalDays: args.interval_days,
        targetDate,
        neverCompletes: args.standing,
        sessionId: ctx.sessionId,
        organizationId: ctx.organizationId
      },
      // Typed in the chat itself: the admin's own @ai message is a task
      // message too, exactly like a #task message, so a reply to it counts.
      ctx.mode === 'chat' && ctx.triggerMessageId ? [ctx.triggerMessageId] : [],
      { action: 'task_created_from_ai', metadata: { via: ctx.mode === 'portal' ? 'portal_ai' : 'whatsapp_ai', mode: ctx.mode, userId: ctx.userId } }
    )
    taskIds.push(taskId)
  }
  ctx.createdTaskIds.push(...taskIds)

  let cardWarning: string | null = null
  try {
    const sent = await sock.sendMessage(recipientJid, {
      text: buildTaskCard({
        taskIds,
        name,
        priority,
        category,
        assigneeJids,
        targetDate,
        timesPerDay: args.times_per_day,
        intervalDays: args.interval_days,
        standing: args.standing
      }),
      ...(assigneeJids.length > 0 ? { mentions: assigneeJids } : {})
    })
    if (sent?.key?.id) {
      ctx.sentMessageIds.push(sent.key.id)
      for (const taskId of taskIds) await linkTaskMessage(taskId, sent.key.id)
    } else {
      cardWarning = 'WhatsApp did not confirm the task message was sent.'
    }
  } catch (err) {
    logger.warn({ err, taskIds, recipientJid }, 'AI: failed to send task card')
    cardWarning = `The task was saved but its WhatsApp message to ${recipientLabel} failed to send.`
  }

  return {
    created_task_ids: taskIds,
    recipient: recipientLabel,
    assignees: assigneeJids.length,
    priority,
    category,
    due: formatDay(targetDate),
    reminders: reminderText(args.times_per_day, args.interval_days),
    standing: args.standing,
    message_sent: cardWarning === null,
    warning: cardWarning
  }
}

async function loadOrgTask(ctx: AiContext, taskId: number) {
  const task = await db.selectFrom('tasks').selectAll().where('id', '=', taskId).where('organization_id', '=', ctx.organizationId).executeTakeFirst()
  if (!task) throw new ToolError(`Task #${taskId} not found.`)
  return task
}

interface UpdateTaskArgs {
  task_id: number
  priority: TaskPriority | null
  category: string | null
  target_date: string | null
  reminder: 'unchanged' | 'stop' | 'times_per_day' | 'interval_days'
  reminder_value: number | null
}

// Same semantics as the /priority, /category and /remind commands
// (commandEngine.ts), applied in one call.
async function updateTaskTool(ctx: AiContext, args: UpdateTaskArgs) {
  const task = await loadOrgTask(ctx, args.task_id)
  const changes: Record<string, unknown> = {}
  const set: TaskUpdate = { updated_at: new Date() }

  if (args.priority) {
    if (!PRIORITIES.includes(args.priority)) throw new ToolError('priority must be P1, P2, P3 or P4.')
    set.priority = changes.priority = args.priority
  }
  const category = normalizeCategory(args.category)
  if (category) set.category = changes.category = category
  const targetDate = parseDay(args.target_date, 'target_date')
  if (targetDate) {
    set.target_date = targetDate
    changes.target_date = formatDay(targetDate)
  }

  let rescheduleReminder = false
  if (args.reminder !== 'unchanged') {
    if (args.reminder === 'stop') {
      Object.assign(set, { reminders_enabled: false, next_reminder_job_id: null, next_reminder_at: null })
      changes.reminders = 'off'
    } else {
      const value = args.reminder_value
      if (value === null) throw new ToolError('reminder_value is required when setting a reminder cadence.')
      if (args.reminder === 'times_per_day' && (value < 1 || value > 6)) throw new ToolError('times_per_day must be 1–6.')
      if (args.reminder === 'interval_days' && (value < 1 || value > 90)) throw new ToolError('interval_days must be 1–90.')
      Object.assign(set, {
        reminder_times_per_day: args.reminder === 'times_per_day' ? value : null,
        reminder_interval_days: args.reminder === 'interval_days' ? value : null,
        reminders_enabled: true
      })
      changes.reminders = args.reminder === 'times_per_day' ? reminderText(value, null) : reminderText(null, value)
      rescheduleReminder = task.status === 'pending'
    }
  }

  if (Object.keys(changes).length === 0) throw new ToolError('Nothing to change — pass at least one field.')
  claimWrite(ctx)

  if (args.reminder !== 'unchanged') await cancelTaskReminder(task.next_reminder_job_id)
  await db.updateTable('tasks').set(set).where('id', '=', task.id).execute()
  if (rescheduleReminder) await scheduleNextReminder(task.id)

  await recordAuditLog({ userId: ctx.userId, action: 'task_updated_from_ai', entityType: 'task', entityId: task.id, metadata: { changes, sessionId: ctx.sessionId, mode: ctx.mode } })
  return { task_id: task.id, name: task.name, changed: changes }
}

async function completeTaskTool(ctx: AiContext, args: { task_id: number }) {
  const task = await loadOrgTask(ctx, args.task_id)
  if (task.status === 'completed') return { task_id: task.id, name: task.name, already_completed: true }
  if (task.never_completes) throw new ToolError(`#${task.id} is a standing task — it never completes; its reminders can be stopped instead.`)
  claimWrite(ctx)
  await completeTask(task, { via: ctx.mode === 'portal' ? 'portal_ai' : 'whatsapp_ai', userId: ctx.userId })
  return { task_id: task.id, name: task.name, completed: true }
}

// --- tool definitions --------------------------------------------------------

const nullableString = (description: string) => ({ type: ['string', 'null'], description })
const nullableDate = (description: string) => ({ type: ['string', 'null'], description: `${description} (YYYY-MM-DD, inclusive), or null.` })
const nullableEnum = (values: string[], description: string) => ({ type: ['string', 'null'], enum: [...values, null], description })
const nullableInt = (description: string) => ({ type: ['integer', 'null'], description })

function objectSchema(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

const reportProperties = {
  period: nullableEnum(['daily', 'weekly', 'monthly', 'all'], 'daily = created today, weekly = since Monday, monthly = since the 1st, all = all time. Ignored when from/to is set. Null = all.'),
  from: nullableDate('Custom range start on task creation date'),
  to: nullableDate('Custom range end on task creation date'),
  assignee: nullableString('Employee/group name or phone to restrict to, or null for everyone.'),
  status: nullableEnum(STATUSES, 'Restrict to one status, or null.'),
  category: nullableString('Category word like "acc", or null.')
}

const TOOL_DEFINITIONS: Record<string, FunctionTool> = {
  query_tasks: {
    type: 'function',
    name: 'query_tasks',
    description:
      'Count, break down and list tasks with any combination of filters. Use for every numeric question ("how many pending", "completed today", "overdue by employee"). Returns total_matching, counts by status (+ overdue), optional groups, and up to `limit` tasks.',
    strict: true,
    parameters: objectSchema({
      status: { type: ['array', 'null'], items: { type: 'string', enum: STATUSES }, description: 'Statuses to include; null = all. "Left for review" = needs_review.' },
      assignee: nullableString('Employee or group name/phone (partial match), or null.'),
      text: nullableString('Words in the task name (partial match), or null.'),
      category: nullableString('Category word like "acc", or null.'),
      priority: nullableEnum(PRIORITIES, 'Exact priority, or null.'),
      created_from: nullableDate('Created on/after'),
      created_to: nullableDate('Created on/before'),
      completed_from: nullableDate('Completed on/after — use with completed_to for "completed today/this week"'),
      completed_to: nullableDate('Completed on/before'),
      due_from: nullableDate('Due (target date) on/after'),
      due_to: nullableDate('Due on/before'),
      overdue_only: { type: ['boolean', 'null'], description: 'true = only not-completed tasks whose due date is before today.' },
      group_by: nullableEnum(['assignee', 'category', 'priority', 'status'], 'Break counts down by this field, or null.'),
      sort: nullableEnum(['newest', 'oldest', 'due_date', 'priority'], 'Order of the returned task list; null = newest.'),
      limit: nullableInt(`How many tasks to list (0–${MAX_LIST_LIMIT}); 0 when only counts are needed. Null = 20.`)
    })
  },
  get_task: {
    type: 'function',
    name: 'get_task',
    description: 'Full details of one task by #id: reminders, due date, and its chat notes (replies logged on it).',
    strict: true,
    parameters: objectSchema({ task_id: { type: 'integer', description: 'The task #id.' } })
  },
  get_report: {
    type: 'function',
    name: 'get_report',
    description:
      'Per-employee performance summary (totals, completed on time/late, completion %, average days to complete) for tasks created in a period. Use for analysis/comparison questions.',
    strict: true,
    parameters: objectSchema(reportProperties)
  },
  send_report_pdf: {
    type: 'function',
    name: 'send_report_pdf',
    description: 'Generate the standard PDF task report and send it to the admin in this chat. Only when the user asks for a report/PDF to be sent.',
    strict: true,
    parameters: objectSchema(reportProperties)
  },
  find_recipients: {
    type: 'function',
    name: 'find_recipients',
    description: "Search this organization's saved contacts and WhatsApp groups by name or phone digits. Required before create_task from the admin's self-chat, to get the recipient's jid.",
    strict: true,
    parameters: objectSchema({ query: { type: 'string', description: 'Name or part of a phone number.' } })
  },
  create_task: {
    type: 'function',
    name: 'create_task',
    description:
      'Create and assign a task. The recipient gets a WhatsApp task message they can reply "done" to; reminders follow the cadence set here. Only call when the user explicitly asks to assign/create a task.',
    strict: true,
    parameters: objectSchema({
      name: { type: 'string', description: 'Short, clear task title in the user\'s language, e.g. "Send GST invoice to Mehta Builders".' },
      recipient_jid: nullableString("Self-chat: the jid from find_recipients (a contact or a group). Inside someone else's chat/group: null (it's always that chat)."),
      assignee_jids: { type: 'array', items: { type: 'string' }, description: 'Only for a group recipient: the specific people the task is for (one task each). Empty = the whole group.' },
      category: nullableString('One-word category like "acc" or "pur" if the user gave one, else null.'),
      priority: nullableEnum(PRIORITIES, 'P1 urgent/critical/ASAP, P2 high/important, P3 normal, P4 low. Null = P3 (nothing said).'),
      times_per_day: nullableInt('Reminders N times a day (1–6), only if the user asked for reminders like that; else null.'),
      interval_days: nullableInt('A reminder once every N days (1–90), only if asked; else null. Never together with times_per_day.'),
      target_date: nullableDate('Due date'),
      standing: { type: 'boolean', description: 'true only if the user wants a standing task that never completes (reminders forever). Usually false.' }
    })
  },
  update_task: {
    type: 'function',
    name: 'update_task',
    description: 'Change an existing task: priority, category, due date and/or reminder cadence. Fields left null (and reminder "unchanged") are kept.',
    strict: true,
    parameters: objectSchema({
      task_id: { type: 'integer', description: 'The task #id.' },
      priority: nullableEnum(PRIORITIES, 'New priority, or null.'),
      category: nullableString('New category word, or null.'),
      target_date: nullableDate('New due date'),
      reminder: { type: 'string', enum: ['unchanged', 'stop', 'times_per_day', 'interval_days'], description: 'Reminder change.' },
      reminder_value: nullableInt('N for times_per_day (1–6) or interval_days (1–90); null otherwise.')
    })
  },
  complete_task: {
    type: 'function',
    name: 'complete_task',
    description: 'Mark one task as completed (stops its reminders). Only when the user explicitly asks to complete/close that task.',
    strict: true,
    parameters: objectSchema({ task_id: { type: 'integer', description: 'The task #id.' } })
  }
}

type ToolHandler = (ctx: AiContext, args: never) => Promise<unknown>

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  query_tasks: queryTasks,
  get_task: getTask,
  get_report: getReport,
  send_report_pdf: sendReportPdf,
  find_recipients: findRecipients,
  create_task: createTaskTool,
  update_task: updateTaskTool,
  complete_task: completeTaskTool
}

export const WRITE_TOOLS = new Set(['create_task', 'update_task', 'complete_task'])
const READ_TOOLS = ['query_tasks', 'get_task', 'get_report', 'find_recipients']

// The single source of truth for what a request may do — used both for the
// tool list the model is offered and to refuse anything else it asks for.
// Read access never includes a write tool, whatever the mode.
function allowedToolNames(ctx: Pick<AiContext, 'mode' | 'access'>): string[] {
  let names: string[]
  if (ctx.mode === 'self') names = Object.keys(TOOL_DEFINITIONS)
  else if (ctx.mode === 'chat') names = ['create_task']
  // The PDF goes to a WhatsApp chat, which the portal isn't — reports are
  // downloaded from the Reports page there instead.
  else names = [...READ_TOOLS, ...WRITE_TOOLS]
  return ctx.access === 'write' ? names : names.filter((n) => !WRITE_TOOLS.has(n))
}

export function toolsFor(ctx: Pick<AiContext, 'mode' | 'access'>): FunctionTool[] {
  return allowedToolNames(ctx).map((name) => TOOL_DEFINITIONS[name]!)
}

// Runs one model-requested tool call and returns its JSON result as text.
// Problems the model can fix (bad date, unknown task, ambiguous request)
// come back as {"error": "..."} so it can correct itself or ask the user;
// anything unexpected is logged and reported generically.
export async function executeTool(ctx: AiContext, name: string, rawArguments: string): Promise<string> {
  const handler = TOOL_HANDLERS[name]
  if (!handler || !allowedToolNames(ctx).includes(name)) {
    const readOnly = ctx.access === 'read' && WRITE_TOOLS.has(name)
    return JSON.stringify({ error: readOnly ? 'Read-only mode: no changes can be made. The user can switch to Write mode to allow this.' : `Tool ${name} is not available here.` })
  }

  let args: unknown
  try {
    args = JSON.parse(rawArguments)
  } catch {
    return JSON.stringify({ error: 'Arguments were not valid JSON.' })
  }

  try {
    const result = await handler(ctx, args as never)
    const text = JSON.stringify(result)
    return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}…(truncated — narrow the filters)` : text
  } catch (err) {
    if (err instanceof ToolError) return JSON.stringify({ error: err.message })
    logger.error({ err, tool: name }, 'AI tool failed')
    return JSON.stringify({ error: 'Internal error while running this tool.' })
  }
}
