import { SHORT_DATE_RE, parseShortDate } from '../lib/dateFormat.js'

export interface ParsedRecurringReminder {
  text: string
  endDate: Date | null
  // 1 = daily (the default when no "1IN<N>D" is given), matching the exact
  // same shorthand #task already uses for "remind once every N days".
  intervalDays: number
}

// "#sced" — optionally "#sced 1IN15D" (every 15 days instead of daily),
// optionally followed by "till dd-mm-yy" — anchored to the very end of the
// message, e.g. "Check inventory levels #sced till 19-09-26" or "Pay rent
// #sced 1IN30D till 31-12-26" or "Good morning team, don't forget standup
// #sced" (no interval = daily, no end date = repeats forever until turned
// off from the portal).
const SCHEDULE_RE = new RegExp(`#sced(?:\\s+1IN(\\d+)D)?(?:\\s+till\\s+(${SHORT_DATE_RE.source}))?\\s*$`, 'i')

// A message that also starts with "#task" is a task, not a recurring
// reminder, even if it happens to end with "#sced" too — the two
// commands are deliberately mutually exclusive so a single message never
// creates both.
const TASK_TAG_RE = /^#task\b/i

// Parses a phone-typed message ending in "#sced" into the reminder text
// (everything before the tag) plus an optional interval and end date.
// Returns null if the message doesn't end with the tag, is a #task
// message, or has no text before the tag to actually send.
export function parseRecurringReminder(text: string): ParsedRecurringReminder | null {
  const trimmed = text.trim()
  if (TASK_TAG_RE.test(trimmed)) return null

  const match = trimmed.match(SCHEDULE_RE)
  if (!match) return null

  const body = trimmed.slice(0, match.index).trim()
  if (!body) return null

  const intervalDays = match[1] ? Number(match[1]) : 1
  const endDate = match[2] ? parseShortDate(match[2]) : null
  return { text: body, endDate, intervalDays: intervalDays >= 1 ? intervalDays : 1 }
}

// Strips a trailing "#sced [1IN<N>D] [till dd-mm-yy]" tag from text that
// wasn't typed on the phone but might still carry it out of habit (e.g.
// pasted from a WhatsApp draft into the portal's Schedule form, which has
// its own separate interval/end-date fields and never needs the tag at
// all). Text with no such tag is returned unchanged — this never touches
// ordinary message content.
export function stripScheduleTag(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(SCHEDULE_RE)
  if (!match) return trimmed
  return trimmed.slice(0, match.index).trim()
}
