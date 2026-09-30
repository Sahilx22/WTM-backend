// "#report <name>" — the tag on its own first line (or the whole message,
// for a report with no extra text, e.g. a PDF whose caption is just the
// tag+name), with the report's own content, if any, on the lines after it.
//   #report Weekly Sales Report
//   Total sales: 45000
//   New leads: 12
// or, as a document's caption:
//   #report Weekly Sales Report
const REPORT_TAG_RE = /^#report[ \t]+(.+)$/is

export interface ParsedReportSubmission {
  // The report's name, as typed — matched against report_definitions.name
  // case-insensitively (see reportSubmissionEngine.ts), not parsed further.
  name: string
  // Anything after the first line — null when the tag+name is the whole
  // message (typical when a document/PDF is attached and this is just its
  // caption).
  body: string | null
}

export function parseReportSubmission(text: string): ParsedReportSubmission | null {
  const trimmed = text.trim()
  const match = trimmed.match(REPORT_TAG_RE)
  if (!match?.[1]) return null

  const rest = match[1]
  const newlineIndex = rest.indexOf('\n')
  if (newlineIndex === -1) {
    const name = rest.trim()
    return name ? { name, body: null } : null
  }

  const name = rest.slice(0, newlineIndex).trim()
  const body = rest.slice(newlineIndex + 1).trim()
  if (!name) return null
  return { name, body: body || null }
}
