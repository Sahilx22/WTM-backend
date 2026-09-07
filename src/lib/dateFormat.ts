// Short dd-mm-yy format used throughout task commands/messages (until/from/to
// clauses, due-date display) — shorter to type on a phone than YYYY-MM-DD.
// Years are always interpreted as 20YY; not meant for dates outside this
// century, which is fine for task due dates.
export const SHORT_DATE_RE = /(\d{1,2})-(\d{1,2})-(\d{2})/

export function parseShortDate(text: string): Date | null {
  const match = text.match(SHORT_DATE_RE)
  if (!match) return null
  const day = Number(match[1])
  const month = Number(match[2])
  const year = 2000 + Number(match[3])
  const date = new Date(year, month - 1, day)
  // Reject e.g. "31-02-26" silently rolling over into March.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

export function formatShortDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const year = String(date.getFullYear()).slice(-2)
  return `${day}-${month}-${year}`
}
