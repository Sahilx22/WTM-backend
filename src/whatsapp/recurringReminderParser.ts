import { SHORT_DATE_RE, parseShortDate } from '../lib/dateFormat.js'

export interface ParsedRecurringReminder {
  text: string
  endDate: Date | null
}

// "#sced" (optionally "#sced till dd-mm-yy") anchored to the very
// end of the message — e.g. "Check inventory levels #sced till 19-09-26"
// or "Good morning team, don't forget standup #sced" (no end date =
// repeats forever until turned off from the portal).
const SCHEDULE_RE = new RegExp(`#sced(?:\\s+till\\s+(${SHORT_DATE_RE.source}))?\\s*$`, 'i')

// A message that also starts with "#task" is a task, not a recurring
// reminder, even if it happens to end with "#sced" too — the two
// commands are deliberately mutually exclusive so a single message never
// creates both.
const TASK_TAG_RE = /^#task\b/i

// Parses a phone-typed message ending in "#sced" into the reminder text
// (everything before the tag) plus an optional end date. Returns null if the
// message doesn't end with the tag, is a #task message, or has no text
// before the tag to actually send.
export function parseRecurringReminder(text: string): ParsedRecurringReminder | null {
  const trimmed = text.trim()
  if (TASK_TAG_RE.test(trimmed)) return null

  const match = trimmed.match(SCHEDULE_RE)
  if (!match) return null

  const body = trimmed.slice(0, match.index).trim()
  if (!body) return null

  const endDate = match[1] ? parseShortDate(match[1]) : null
  return { text: body, endDate }
}
