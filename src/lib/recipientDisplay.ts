// Shared fallback chain for showing a task's recipient as something a human
// can actually recognize: saved contact name, then group name, then finally
// the raw phone number/id if neither is known.
export function recipientDisplayName(
  recipientJid: string,
  contactName?: string | null,
  groupSubject?: string | null
): string {
  return contactName || groupSubject || recipientJid.split('@')[0] || recipientJid
}
