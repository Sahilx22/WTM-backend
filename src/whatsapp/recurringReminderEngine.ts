import type { WASocket, WAMessage } from '@whiskeysockets/baileys'
import { db } from '../db/index.js'
import { parseRecurringReminder } from './recurringReminderParser.js'
import { resolveContactId } from './taskEngine.js'
import { scheduleNextRecurringReminder } from '../queue/recurringReminders.js'
import { recordAuditLog } from '../lib/auditLog.js'

// Only messages sent from the linked phone/app (fromMe) can create a
// recurring reminder — same deliberate design as #task: typed directly into
// any WhatsApp chat (1:1 or group), never through this web app's compose UI.
// Called from connectionManager.ts's messages.upsert alongside (not instead
// of) handleMessageForTasks/handleCommandMessage/persistChatMessage.
export async function handleRecurringReminderMessage(
  sock: WASocket,
  m: WAMessage,
  sessionId: number | null,
  organizationId: number | null
): Promise<void> {
  if (!m.key.fromMe || !m.key.remoteJid) return

  const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text
  if (!text) return

  const parsed = parseRecurringReminder(text)
  if (!parsed) return

  const now = new Date()
  const scheduledTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const contactId = await resolveContactId(sock, m.key.remoteJid, organizationId)

  const created = await db
    .insertInto('recurring_reminders')
    .values({
      organization_id: organizationId,
      recipient_jid: m.key.remoteJid,
      contact_id: contactId,
      message_text: parsed.text,
      scheduled_time: scheduledTime,
      end_date: parsed.endDate,
      wa_message_id: m.key.id ?? null,
      created_by_session_id: sessionId,
      // Reply back through the same number it was typed into daily, not
      // always the organization's primary session.
      whatsapp_session_id: sessionId
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await scheduleNextRecurringReminder(created.id)

  await recordAuditLog({
    userId: null,
    action: 'recurring_reminder_created',
    entityType: 'recurring_reminder',
    entityId: created.id,
    metadata: { recipientJid: m.key.remoteJid, endDate: parsed.endDate, sessionId }
  })

  // Deliberately silent — no WhatsApp reply. The reminder still shows up on
  // the portal's Recurring Reminders page immediately; a chat confirmation
  // isn't wanted (e.g. #sced typed into someone else's chat shouldn't show
  // them that a reminder was just scheduled around them).
}
