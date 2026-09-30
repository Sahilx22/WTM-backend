import crypto from 'node:crypto'
import type { WASocket, WAMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from '../db/index.js'
import { isProduction } from '../config/env.js'
import { parseReportSubmission } from './reportSubmissionParser.js'
import { mapContent } from './chatMessages.js'
import { uploadObject } from '../lib/s3.js'
import { scheduleNextReportOccurrence } from '../queue/reportSubmissions.js'
import { recordAuditLog } from '../lib/auditLog.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

// A report is submitted BY the employee, in their own chat with the
// organization's linked WhatsApp number — the opposite direction from
// #task/#sced (which the admin types from their own linked phone) — so
// this only ever looks at messages the admin's number received, never sent.
// Called from connectionManager.ts's messages.upsert handler alongside (not
// instead of) the task/command/chat/recurring-reminder handlers.
export async function handleReportSubmissionMessage(
  sock: WASocket,
  m: WAMessage,
  organizationId: number | null
): Promise<void> {
  if (m.key.fromMe || !m.key.remoteJid || !m.key.id || organizationId === null) return

  const mapped = await mapContent(sock, m)
  if (!mapped?.messageText) return

  const parsed = parseReportSubmission(mapped.messageText)
  if (!parsed) return

  const definitions = await db
    .selectFrom('report_definitions')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('recipient_jid', '=', m.key.remoteJid)
    .where('enabled', '=', true)
    .execute()

  if (definitions.length === 0) return

  // Exact (case-insensitive) name match first; if none, and this employee
  // has exactly one report currently open, assume that's the one they mean
  // — forgiving of a slightly different name, same reasoning as the
  // portal Chat page's single-active-task "done" shortcut.
  const exact = definitions.find((d) => d.name.toLowerCase() === parsed.name.toLowerCase())
  let definition = exact ?? null

  if (!definition) {
    const openForRecipient = await db
      .selectFrom('report_submissions')
      .innerJoin('report_definitions', 'report_definitions.id', 'report_submissions.report_definition_id')
      .select(['report_definitions.id as definitionId'])
      .where('report_submissions.status', '=', 'pending')
      .where('report_definitions.recipient_jid', '=', m.key.remoteJid)
      .where('report_definitions.organization_id', '=', organizationId)
      .execute()

    if (openForRecipient.length === 1) {
      definition = definitions.find((d) => d.id === openForRecipient[0]!.definitionId) ?? null
    } else if (openForRecipient.length > 1) {
      const names = definitions
        .filter((d) => openForRecipient.some((o) => o.definitionId === d.id))
        .map((d) => `• ${d.name}`)
        .join('\n')
      await sock.sendMessage(m.key.remoteJid, {
        text: `I couldn't tell which report "${parsed.name}" was for. You currently have more than one open:\n${names}\n\nReply again with the exact name, e.g. "#report ${definitions[0]?.name ?? ''}".`
      })
      return
    }
  }

  if (!definition) return // not a recognized report name for this chat — leave it alone, not our message to handle

  const submission = await db
    .selectFrom('report_submissions')
    .selectAll()
    .where('report_definition_id', '=', definition.id)
    .where('status', '=', 'pending')
    .orderBy('due_at', 'desc')
    .executeTakeFirst()

  if (!submission) {
    await sock.sendMessage(m.key.remoteJid, { text: `There's no *${definition.name}* currently due — nothing to submit right now.` })
    return
  }

  // Already submitted for this occurrence (e.g. a resend/duplicate) — don't
  // silently overwrite what was already recorded.
  if (submission.status !== 'pending') return

  let mediaPath: string | null = null
  if (mapped.mediaBuffer) {
    const key = crypto.randomUUID()
    try {
      await uploadObject(key, mapped.mediaBuffer, mapped.mediaMimetype ?? 'application/octet-stream')
      mediaPath = key
    } catch (err) {
      logger.warn({ err, submissionId: submission.id }, 'failed to upload report submission media')
    }
  }

  await db
    .updateTable('report_submissions')
    .set({
      status: 'submitted',
      submitted_at: new Date(),
      submission_text: parsed.body,
      submission_media_path: mediaPath,
      submission_media_mimetype: mediaPath ? mapped.mediaMimetype : null,
      wa_message_id: m.key.id
    })
    .where('id', '=', submission.id)
    .execute()

  await scheduleNextReportOccurrence(definition.id)

  await recordAuditLog({
    userId: null,
    action: 'report_submitted',
    entityType: 'report_submission',
    entityId: submission.id,
    metadata: { definitionId: definition.id, name: definition.name, recipientJid: m.key.remoteJid, hasMedia: mediaPath !== null }
  })

  await sock.sendMessage(m.key.remoteJid, { text: `✅ Got it — *${definition.name}* recorded as submitted.` })
}
