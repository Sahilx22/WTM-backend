import type { TaskFrequency } from '../db/schema.js'

export interface ParsedTask {
  name: string
  frequency: TaskFrequency | null
  targetDate: string | null // 'YYYY-MM-DD'
}

const TASK_TAG_RE = /^#task\s+(.+)$/is

// Exported for reuse by commandParser.ts's `/remind` command, which applies
// the same "every <frequency>" / "until <date>" mini-language to an existing
// task instead of a freshly-created one.
export const FREQUENCY_RE = /\bevery\s+(hourly|hour|daily|day|weekly|week)\b/i
export const TARGET_DATE_RE = /\buntil\s+(\d{4}-\d{2}-\d{2})\b/i

const EVERY_RE = FREQUENCY_RE
const UNTIL_RE = TARGET_DATE_RE

export function frequencyFromMatch(raw: string): TaskFrequency {
  const lower = raw.toLowerCase()
  return lower.startsWith('hour') ? 'hourly' : lower.startsWith('day') ? 'daily' : 'weekly'
}

// Parses a phone-typed message like:
//   "#task Submit quarterly report every day until 2026-08-20"
// into a task name plus optional reminder frequency and target date. Both
// "every" and "until" clauses are optional and can appear in either order —
// whichever appears first in the text is where the task name ends.
export function parseTaskMessage(text: string): ParsedTask | null {
  const tagMatch = text.trim().match(TASK_TAG_RE)
  if (!tagMatch) return null

  const body = tagMatch[1]?.trim()
  if (!body) return null

  const everyMatch = body.match(EVERY_RE)
  const untilMatch = body.match(UNTIL_RE)

  const cutPoints = [everyMatch?.index, untilMatch?.index].filter((i): i is number => i !== undefined)
  const nameEnd = cutPoints.length > 0 ? Math.min(...cutPoints) : body.length
  const name = body.slice(0, nameEnd).trim()

  if (!name) return null

  const frequency: TaskFrequency | null = everyMatch?.[1] ? frequencyFromMatch(everyMatch[1]) : null

  const targetDate = untilMatch?.[1] ?? null

  return { name, frequency, targetDate }
}

const THUMBS_UP_VARIANTS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿'])

export function isThumbsUp(emoji: string | null | undefined): boolean {
  if (!emoji) return false
  return THUMBS_UP_VARIANTS.has(emoji.trim())
}
