import type { ReportPeriod } from '../reports/taskMetrics.js'
import type { TaskStatus, TaskPriority, RecurrenceUnit } from '../db/schema.js'
import { TIMES_PER_DAY_RE, INTERVAL_DAYS_RE, TARGET_DATE_RE, PRIORITY_RE, CATEGORY_RE } from './taskParser.js'
import { SHORT_DATE_RE, parseShortDate } from '../lib/dateFormat.js'

export type ParsedCommand =
  | { type: 'help' }
  | { type: 'status'; query: string; statusFilter?: TaskStatus; category?: string; dateFrom?: Date; dateTo?: Date }
  | {
      type: 'report'
      period: ReportPeriod
      recipient?: string
      statusFilter?: TaskStatus
      category?: string
      dateFrom?: Date
      dateTo?: Date
    }
  | { type: 'complete'; taskId: number }
  | { type: 'remind'; taskId: number; stop: true }
  | {
      type: 'remind'
      taskId: number
      stop: false
      timesPerDay: number | null
      intervalDays: number | null
      targetDate?: Date
    }
  | { type: 'recur'; taskId: number; off: true }
  | { type: 'recur'; taskId: number; off: false; intervalValue: number; intervalUnit: RecurrenceUnit; time?: string }
  | { type: 'priority'; taskId: number; priority: TaskPriority }
  | { type: 'category'; taskId: number; category: string }
  | { type: 'chat'; taskId: number }
  | { type: 'summary'; identifier: string; date?: Date }

const PERIOD_KEYWORDS = new Set(['daily', 'weekly', 'monthly'])

const STATUS_KEYWORDS: Record<string, TaskStatus> = {
  pending: 'pending',
  completed: 'completed',
  done: 'completed',
  review: 'needs_review',
  reviewing: 'needs_review'
}

const FROM_RE = new RegExp(`\\bfrom\\s+(${SHORT_DATE_RE.source})\\b`, 'i')
const TO_RE = new RegExp(`\\bto\\s+(${SHORT_DATE_RE.source})\\b`, 'i')
const RECUR_RE = /\bevery\s+(\d+)\s+(day|days|week|weeks)\b/i
const AT_TIME_RE = /\bat\s+([01]\d|2[0-3]):([0-5]\d)\b/i
const EXACT_SHORT_DATE_RE = new RegExp(`^${SHORT_DATE_RE.source}$`)

// Shared by /status and /report — pulls out "from dd-mm-yy" / "to dd-mm-yy"
// (either, both, in any order) and returns the remaining text with those
// tokens removed so the rest of the grammar doesn't have to know about them.
function extractDateRange(text: string): { from?: Date; to?: Date; rest: string } {
  let rest = text
  let from: Date | undefined
  let to: Date | undefined

  const fromMatch = rest.match(FROM_RE)
  if (fromMatch?.[1] && fromMatch.index !== undefined) {
    from = parseShortDate(fromMatch[1]) ?? undefined
    rest = rest.slice(0, fromMatch.index) + rest.slice(fromMatch.index + fromMatch[0].length)
  }

  const toMatch = rest.match(TO_RE)
  if (toMatch?.[1] && toMatch.index !== undefined) {
    to = parseShortDate(toMatch[1]) ?? undefined
    rest = rest.slice(0, toMatch.index) + rest.slice(toMatch.index + toMatch[0].length)
  }

  return { from, to, rest: rest.replace(/\s+/g, ' ').trim() }
}

// Shared by /status and /report — pulls out "@category" and returns the
// remaining text with it removed.
function extractCategory(text: string): { category?: string; rest: string } {
  const match = text.match(CATEGORY_RE)
  if (!match?.[1] || match.index === undefined) return { rest: text }
  const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s+/g, ' ').trim()
  return { category: match[1].toLowerCase(), rest }
}

function parseTaskRef(token: string | undefined): number | null {
  if (!token) return null
  const id = Number(token.replace(/^#/, ''))
  return Number.isInteger(id) && id > 0 ? id : null
}

// Slash commands typed into your own self-chat:
//   /help
//   /status <task or employee name> [pending|completed|review] [@category] [from dd-mm-yy] [to dd-mm-yy]
//   /report [daily|weekly|monthly] [pending|completed|review] [@category] [<name or number>] [from dd-mm-yy] [to dd-mm-yy]
//   /complete <id>
//   /chat <id>
//   /summary <id or task name> [dd-mm-yy] — also works as a direct message
//     from a task's own recipient to the admin's number (not just self-chat),
//     scoped to that person's own tasks only
//   /remind <id> <N>TAD|1IN<N>D [until dd-mm-yy]
//   /remind <id> stop
//   /recur <id> every <N> days|weeks [at HH:MM]
//   /recur <id> off
//   /priority <id> P1|P2|P3|P4
//   /category <id> @tag
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null

  const firstSpace = trimmed.indexOf(' ')
  const cmd = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase()
  const argsText = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  if (!cmd) return null

  if (cmd === 'help') return { type: 'help' }

  if (cmd === 'status') {
    const { from, to, rest: afterDates } = extractDateRange(argsText)
    const { category, rest } = extractCategory(afterDates)
    let queryParts = rest.split(/\s+/).filter((p) => p.length > 0)
    let statusFilter: TaskStatus | undefined

    const lastToken = queryParts[queryParts.length - 1]?.toLowerCase()
    if (lastToken && lastToken in STATUS_KEYWORDS) {
      statusFilter = STATUS_KEYWORDS[lastToken]
      queryParts = queryParts.slice(0, -1)
    }

    const query = queryParts.join(' ').trim()
    // Bare "/status pending" (or a bare date range/@category) is valid —
    // only reject when there's nothing at all to search or filter by.
    if (!query && !statusFilter && !category && !from && !to) return null
    return { type: 'status', query, statusFilter, category, dateFrom: from, dateTo: to }
  }

  if (cmd === 'report') {
    const { from, to, rest: afterDates } = extractDateRange(argsText)
    const { category, rest: afterCategory } = extractCategory(afterDates)
    let parts = afterCategory.split(/\s+/).filter((p) => p.length > 0)
    let period: ReportPeriod = 'all'
    let statusFilter: TaskStatus | undefined

    // Period and status keywords can each appear anywhere among the
    // remaining words (not just trailing) — pull both out, whatever's left
    // is the recipient filter text.
    const remaining: string[] = []
    for (const part of parts) {
      const lower = part.toLowerCase()
      if (!statusFilter && lower in STATUS_KEYWORDS) {
        statusFilter = STATUS_KEYWORDS[lower]
      } else if (period === 'all' && PERIOD_KEYWORDS.has(lower)) {
        period = lower as ReportPeriod
      } else {
        remaining.push(part)
      }
    }
    parts = remaining

    // An explicit date range replaces the coarse period bucket entirely.
    if (from || to) period = 'all'

    const recipient = parts.join(' ').trim()
    return { type: 'report', period, recipient: recipient || undefined, statusFilter, category, dateFrom: from, dateTo: to }
  }

  if (cmd === 'complete') {
    const taskId = parseTaskRef(argsText.split(/\s+/)[0])
    if (!taskId) return null
    return { type: 'complete', taskId }
  }

  if (cmd === 'chat') {
    const taskId = parseTaskRef(argsText.split(/\s+/)[0])
    if (!taskId) return null
    return { type: 'chat', taskId }
  }

  if (cmd === 'summary') {
    const parts = argsText.split(/\s+/).filter((p) => p.length > 0)
    if (parts.length === 0) return null

    let date: Date | undefined
    const lastToken = parts[parts.length - 1]
    if (lastToken && EXACT_SHORT_DATE_RE.test(lastToken)) {
      date = parseShortDate(lastToken) ?? undefined
      parts.pop()
    }

    const identifier = parts.join(' ').trim()
    if (!identifier) return null

    return { type: 'summary', identifier, date }
  }

  if (cmd === 'remind') {
    const parts = argsText.split(/\s+/).filter((p) => p.length > 0)
    const taskId = parseTaskRef(parts[0])
    if (!taskId) return null
    const rest = parts.slice(1).join(' ')

    if (/^stop$/i.test(rest.trim())) {
      return { type: 'remind', taskId, stop: true }
    }

    const tadMatch = rest.match(TIMES_PER_DAY_RE)
    const intervalMatch = rest.match(INTERVAL_DAYS_RE)
    if (!tadMatch?.[1] && !intervalMatch?.[1]) return null

    const timesPerDay = tadMatch?.[1] ? Number(tadMatch[1]) : null
    const intervalDays = intervalMatch?.[1] ? Number(intervalMatch[1]) : null

    const dateMatch = rest.match(TARGET_DATE_RE)
    const targetDate = dateMatch?.[1] ? (parseShortDate(dateMatch[1]) ?? undefined) : undefined

    return { type: 'remind', taskId, stop: false, timesPerDay, intervalDays, targetDate }
  }

  if (cmd === 'recur') {
    const parts = argsText.split(/\s+/).filter((p) => p.length > 0)
    const taskId = parseTaskRef(parts[0])
    if (!taskId) return null
    const rest = parts.slice(1).join(' ')

    if (/^off$/i.test(rest.trim())) {
      return { type: 'recur', taskId, off: true }
    }

    const recurMatch = rest.match(RECUR_RE)
    if (!recurMatch?.[1] || !recurMatch[2]) return null
    const intervalValue = Number(recurMatch[1])
    if (!Number.isInteger(intervalValue) || intervalValue < 1) return null
    const intervalUnit: RecurrenceUnit = recurMatch[2].toLowerCase().startsWith('day') ? 'days' : 'weeks'

    const timeMatch = rest.match(AT_TIME_RE)
    const time = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : undefined

    return { type: 'recur', taskId, off: false, intervalValue, intervalUnit, time }
  }

  if (cmd === 'priority') {
    const parts = argsText.split(/\s+/).filter((p) => p.length > 0)
    const taskId = parseTaskRef(parts[0])
    if (!taskId) return null
    const rest = parts.slice(1).join(' ')

    const priorityMatch = rest.match(PRIORITY_RE)
    if (!priorityMatch?.[1]) return null

    return { type: 'priority', taskId, priority: `P${priorityMatch[1]}` as TaskPriority }
  }

  if (cmd === 'category') {
    const parts = argsText.split(/\s+/).filter((p) => p.length > 0)
    const taskId = parseTaskRef(parts[0])
    if (!taskId) return null
    const rest = parts.slice(1).join(' ')

    const categoryMatch = rest.match(CATEGORY_RE)
    if (!categoryMatch?.[1]) return null

    return { type: 'category', taskId, category: categoryMatch[1].toLowerCase() }
  }

  return null
}
