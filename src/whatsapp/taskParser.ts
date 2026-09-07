import type { TaskPriority } from '../db/schema.js'
import { SHORT_DATE_RE, parseShortDate } from '../lib/dateFormat.js'

export interface ParsedTask {
  name: string
  category: string | null
  priority: TaskPriority
  timesPerDay: number | null
  intervalDays: number | null
  targetDate: Date | null
}

const TASK_TAG_RE = /^#task\s+(.+)$/is

// Exported for reuse by commandParser.ts's `/remind`/`/category` commands,
// which apply this same shorthand to an existing task instead of a
// freshly-created one.
export const CATEGORY_RE = /@(\w+)/ // e.g. "@acc" = accounts, "@pur" = purchase — free-form, no fixed list
export const PRIORITY_RE = /\bP([1-4])\b/i
export const TIMES_PER_DAY_RE = /\b(\d+)\s*TAD\b/i // e.g. "2TAD" = twice a day
export const INTERVAL_DAYS_RE = /\b1\s*IN\s*(\d+)\s*D\b/i // e.g. "1IN3D" = once every 3 days
export const TARGET_DATE_RE = new RegExp(`\\buntil\\s+(${SHORT_DATE_RE.source})\\b`, 'i') // "until dd-mm-yy"

// Parses a phone-typed message like:
//   "#task Update tensile rate calculator @acc P1 2TAD until 01-09-26"
//   "#task Follow up with vendor @pur 1IN2D"
// into a task name plus category, priority (defaults P3), reminder cadence,
// and an optional target date. Keywords can appear in any order — whichever
// matched keyword appears first in the text is where the task name ends.
export function parseTaskMessage(text: string): ParsedTask | null {
  const tagMatch = text.trim().match(TASK_TAG_RE)
  if (!tagMatch) return null

  const body = tagMatch[1]?.trim()
  if (!body) return null

  const categoryMatch = body.match(CATEGORY_RE)
  const priorityMatch = body.match(PRIORITY_RE)
  const tadMatch = body.match(TIMES_PER_DAY_RE)
  const intervalMatch = body.match(INTERVAL_DAYS_RE)
  const untilMatch = body.match(TARGET_DATE_RE)

  const cutPoints = [categoryMatch?.index, priorityMatch?.index, tadMatch?.index, intervalMatch?.index, untilMatch?.index].filter(
    (i): i is number => i !== undefined
  )
  const nameEnd = cutPoints.length > 0 ? Math.min(...cutPoints) : body.length
  const name = body.slice(0, nameEnd).trim()

  if (!name) return null

  const category = categoryMatch?.[1] ? categoryMatch[1].toLowerCase() : null
  const priority: TaskPriority = priorityMatch?.[1] ? (`P${priorityMatch[1]}` as TaskPriority) : 'P3'
  const timesPerDay = tadMatch?.[1] ? Number(tadMatch[1]) : null
  const intervalDays = intervalMatch?.[1] ? Number(intervalMatch[1]) : null
  const targetDate = untilMatch?.[1] ? parseShortDate(untilMatch[1]) : null

  return { name, category, priority, timesPerDay, intervalDays, targetDate }
}

const THUMBS_UP_VARIANTS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿'])

export function isThumbsUp(emoji: string | null | undefined): boolean {
  if (!emoji) return false
  return THUMBS_UP_VARIANTS.has(emoji.trim())
}
