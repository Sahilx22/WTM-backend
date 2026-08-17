import type { TaskPriority } from '../db/schema.js'

export interface ParsedTask {
  name: string
  priority: TaskPriority
  timesPerDay: number | null
  intervalDays: number | null
  targetDate: string | null // 'YYYY-MM-DD'
}

const TASK_TAG_RE = /^#task\s+(.+)$/is

// Exported for reuse by commandParser.ts's `/remind` command, which applies
// this same shorthand to an existing task instead of a freshly-created one.
export const PRIORITY_RE = /\bP([1-4])\b/i
export const TIMES_PER_DAY_RE = /\b(\d+)\s*TAD\b/i // e.g. "2TAD" = twice a day
export const INTERVAL_DAYS_RE = /\b1\s*IN\s*(\d+)\s*D\b/i // e.g. "1IN3D" = once every 3 days
export const TARGET_DATE_RE = /\buntil\s+(\d{4}-\d{2}-\d{2})\b/i

// Parses a phone-typed message like:
//   "#task Update tensile rate calculator P1 2TAD until 2026-09-01"
//   "#task Follow up with vendor 1IN2D"
// into a task name plus priority (defaults P3), reminder cadence, and an
// optional target date. Keywords can appear in any order — whichever
// matched keyword appears first in the text is where the task name ends.
export function parseTaskMessage(text: string): ParsedTask | null {
  const tagMatch = text.trim().match(TASK_TAG_RE)
  if (!tagMatch) return null

  const body = tagMatch[1]?.trim()
  if (!body) return null

  const priorityMatch = body.match(PRIORITY_RE)
  const tadMatch = body.match(TIMES_PER_DAY_RE)
  const intervalMatch = body.match(INTERVAL_DAYS_RE)
  const untilMatch = body.match(TARGET_DATE_RE)

  const cutPoints = [priorityMatch?.index, tadMatch?.index, intervalMatch?.index, untilMatch?.index].filter(
    (i): i is number => i !== undefined
  )
  const nameEnd = cutPoints.length > 0 ? Math.min(...cutPoints) : body.length
  const name = body.slice(0, nameEnd).trim()

  if (!name) return null

  const priority: TaskPriority = priorityMatch?.[1] ? (`P${priorityMatch[1]}` as TaskPriority) : 'P3'
  const timesPerDay = tadMatch?.[1] ? Number(tadMatch[1]) : null
  const intervalDays = intervalMatch?.[1] ? Number(intervalMatch[1]) : null
  const targetDate = untilMatch?.[1] ?? null

  return { name, priority, timesPerDay, intervalDays, targetDate }
}

const THUMBS_UP_VARIANTS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿'])

export function isThumbsUp(emoji: string | null | undefined): boolean {
  if (!emoji) return false
  return THUMBS_UP_VARIANTS.has(emoji.trim())
}
