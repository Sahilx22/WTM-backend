import { isPnUser, isLidUser, jidDecode, type WASocket, type WAMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from '../db/index.js'
import { isProduction } from '../config/env.js'
import { parseTaskMessage, isThumbsUp } from './taskParser.js'
import { scheduleNextReminder, cancelTaskReminder } from '../queue/taskReminders.js'
import { recordAuditLog } from '../lib/auditLog.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

// A jid's `wa_jid`/message-key form and the form a saved contact was
// recorded under can differ (phone-number vs LID) even though they're the
// same person — decode straight through for PN-form, or via Baileys'
// LID↔PN mapping for LID-form, since phone_number is our one
// form-independent identifier.
async function resolvePhoneNumber(sock: WASocket, jid: string): Promise<string | null> {
  if (isPnUser(jid)) {
    return jidDecode(jid)?.user ?? null
  }
  if (isLidUser(jid)) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid)
      return pn ? jidDecode(pn)?.user ?? null : null
    } catch (err) {
      logger.warn({ err, jid }, 'failed to resolve LID to PN')
      return null
    }
  }
  return null
}

// `organizationId` scopes the lookup so one organization's session never
// resolves to (or silently reuses the name of) another organization's
// contact for the same real phone number — see migration 030.
export async function resolveContactId(sock: WASocket, jid: string, organizationId: number | null): Promise<number | null> {
  let direct = db.selectFrom('contacts').select('id').where('wa_jid', '=', jid)
  direct = organizationId !== null ? direct.where('organization_id', '=', organizationId) : direct.where('organization_id', 'is', null)
  const directMatch = await direct.executeTakeFirst()
  if (directMatch) return directMatch.id

  const phoneNumber = await resolvePhoneNumber(sock, jid)
  if (!phoneNumber) return null

  let byPhone = db.selectFrom('contacts').select('id').where('phone_number', '=', phoneNumber)
  byPhone = organizationId !== null ? byPhone.where('organization_id', '=', organizationId) : byPhone.where('organization_id', 'is', null)
  const phoneMatch = await byPhone.executeTakeFirst()
  return phoneMatch?.id ?? null
}

// A real WhatsApp @mention always renders in the raw text as "@<the
// mentioned jid's own local part>" verbatim — whatever WhatsApp put in
// contextInfo.mentionedJid, digits never the display name — regardless of
// whether that jid is phone-number or LID form. Stripping directly off the
// jid itself (not a resolved phone number) means this never depends on
// resolvePhoneNumber succeeding: a group participant whose PN↔LID mapping
// this session hasn't synced yet would otherwise leave the mention
// unstripped, and since it sits right after "#task ", the "@category"
// shorthand would greedily match it, cut the task name to nothing, and
// silently drop the whole task (parseTaskMessage returns null on an empty
// name) — exactly the bug this avoids.
function stripMentionText(text: string, mentionedJids: string[]): string {
  let cleaned = text
  for (const jid of mentionedJids) {
    const localPart = jid.split('@')[0]
    if (!localPart) continue
    cleaned = cleaned.replace(new RegExp(`@${localPart}\\b`, 'g'), ' ')
  }
  return cleaned.replace(/[ \t]+/g, ' ').trim()
}

// One group #task message can @mention several employees at once — each
// gets its own independent task (own status, own reminders), all still
// delivered to the group chat (recipient_jid stays the group's jid; only
// `assigned_jid`/`contact_id` differ per task) exactly like today's single
// reminder-to-the-group behavior. No mention at all (a 1:1 chat, or a plain
// group #task) creates exactly one task addressed to the chat itself, same
// as before this feature existed.
async function createTasksFromPhoneMessage(
  sock: WASocket,
  recipientJid: string,
  originalMessageId: string,
  text: string,
  sessionId: number | null,
  organizationId: number | null,
  mentionedJids: string[]
): Promise<void> {
  const cleanedText = mentionedJids.length > 0 ? stripMentionText(text, mentionedJids) : text

  const parsed = parseTaskMessage(cleanedText)
  if (!parsed) return

  const assignees =
    mentionedJids.length > 0
      ? await Promise.all(
          mentionedJids.map(async (jid) => ({
            contactId: await resolveContactId(sock, jid, organizationId),
            assignedJid: jid as string | null
          }))
        )
      : [{ contactId: await resolveContactId(sock, recipientJid, organizationId), assignedJid: null as string | null }]

  for (const assignee of assignees) {
    const created = await db
      .insertInto('tasks')
      .values({
        recipient_jid: recipientJid,
        contact_id: assignee.contactId,
        assigned_jid: assignee.assignedJid,
        name: parsed.name,
        category: parsed.category,
        priority: parsed.priority,
        reminder_times_per_day: parsed.timesPerDay,
        reminder_interval_days: parsed.intervalDays,
        target_date: parsed.targetDate,
        status: 'pending',
        created_by_session_id: sessionId,
        organization_id: organizationId
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    await db
      .insertInto('task_messages')
      .values({ task_id: created.id, wa_message_id: originalMessageId, kind: 'original' })
      .execute()

    if (parsed.timesPerDay || parsed.intervalDays) {
      await scheduleNextReminder(created.id)
    }

    logger.info(
      { taskId: created.id, name: parsed.name, recipientJid, sessionId, assignedJid: assignee.assignedJid },
      'created task from phone message'
    )

    await recordAuditLog({
      userId: null,
      action: 'task_created_from_whatsapp',
      entityType: 'task',
      entityId: created.id,
      metadata: {
        name: parsed.name,
        category: parsed.category,
        priority: parsed.priority,
        timesPerDay: parsed.timesPerDay,
        intervalDays: parsed.intervalDays,
        targetDate: parsed.targetDate,
        recipientJid,
        sessionId,
        assignedJid: assignee.assignedJid
      }
    })
  }
}

interface TaskCandidate {
  id: number
  status: string
  next_reminder_job_id: string | null
  assigned_jid: string | null
}

// Finds which task(s) a given WhatsApp message (the original #task message,
// or one of its reminders) is tied to. Almost always exactly one — the only
// time it's more than one is a group #task that @mentioned several
// employees from the same message, in which case `participantJid` (who
// actually reacted/replied) is required to pick out the right one.
// `organizationId` constrains the match to the reacting/replying session's
// own organization — a quote-reply/reaction seen on one org's session can
// never log a note against or flip the status of a different org's task,
// even in the (very unlikely) event of a WhatsApp message-id collision
// across two organizations' separate accounts.
async function findTaskMessageCandidates(waMessageId: string, organizationId: number | null): Promise<TaskCandidate[]> {
  let query = db
    .selectFrom('task_messages')
    .innerJoin('tasks', 'tasks.id', 'task_messages.task_id')
    .select(['tasks.id', 'tasks.status', 'tasks.next_reminder_job_id', 'tasks.assigned_jid'])
    .where('task_messages.wa_message_id', '=', waMessageId)
  query = organizationId !== null ? query.where('tasks.organization_id', '=', organizationId) : query.where('tasks.organization_id', 'is', null)
  return query.execute()
}

async function matchCandidateToParticipant(
  sock: WASocket,
  candidates: TaskCandidate[],
  participantJid: string | null | undefined
): Promise<TaskCandidate | null> {
  if (candidates.length === 1) return candidates[0]!
  if (!participantJid) return null

  const participantPhone = await resolvePhoneNumber(sock, participantJid)
  if (!participantPhone) return null

  for (const candidate of candidates) {
    if (!candidate.assigned_jid) continue
    const assigneePhone = await resolvePhoneNumber(sock, candidate.assigned_jid)
    if (assigneePhone && assigneePhone === participantPhone) return candidate
  }
  return null
}

// Logs a WhatsApp quote-reply as a note against whichever task the quoted
// message (the task's original #task message, or one of its reminders)
// belongs to. Returns true if it matched a task and was logged, so the
// caller can skip treating the same text as anything else (e.g. a new
// #task creation). `replierJid` identifies who's actually replying — needed
// only when the quoted message created more than one task (see above); if
// the admin themself replies to such a message there's no way to tell which
// employee they mean, so the note is logged against all of them rather than
// guessed at or silently dropped.
async function logTaskNoteIfReply(
  sock: WASocket,
  quotedMessageId: string,
  waMessageId: string,
  fromAdmin: boolean,
  replierJid: string | null | undefined,
  text: string,
  organizationId: number | null
): Promise<boolean> {
  const candidates = await findTaskMessageCandidates(quotedMessageId, organizationId)
  if (candidates.length === 0) return false

  let targetTaskIds: number[]
  if (candidates.length === 1) {
    targetTaskIds = [candidates[0]!.id]
  } else if (!fromAdmin) {
    const matched = await matchCandidateToParticipant(sock, candidates, replierJid)
    targetTaskIds = matched ? [matched.id] : candidates.map((c) => c.id)
  } else {
    targetTaskIds = candidates.map((c) => c.id)
  }

  for (const taskId of targetTaskIds) {
    await db.insertInto('task_notes').values({ task_id: taskId, wa_message_id: waMessageId, from_admin: fromAdmin, body: text }).execute()
  }

  logger.info({ taskIds: targetTaskIds, fromAdmin }, 'logged task note from WhatsApp reply')
  return true
}

async function handleThumbsUpReaction(
  sock: WASocket,
  reactedMessageId: string,
  reactorJid: string | null | undefined,
  organizationId: number | null
): Promise<void> {
  const candidates = await findTaskMessageCandidates(reactedMessageId, organizationId)
  if (candidates.length === 0) return

  // Several employees can share the same original group message — only the
  // one who actually reacted should have their own task moved along, never
  // all of them, and never a guess if we can't tell who reacted.
  const task = await matchCandidateToParticipant(sock, candidates, reactorJid)
  if (!task || task.status !== 'pending') return

  await cancelTaskReminder(task.next_reminder_job_id)

  await db
    .updateTable('tasks')
    .set({ status: 'needs_review', next_reminder_job_id: null, updated_at: new Date() })
    .where('id', '=', task.id)
    .execute()

  logger.info({ taskId: task.id }, 'task marked needs_review via thumbs-up reaction')

  await recordAuditLog({
    userId: null,
    action: 'task_marked_needs_review',
    entityType: 'task',
    entityId: task.id,
    metadata: { via: 'whatsapp_reaction' }
  })
}

// Called for every message our socket sees (both messages we send from the
// linked phone and messages/reactions we receive). Errors are caught by the
// caller so a single bad message never takes down the connection. `sessionId`
// identifies which WhatsApp session received this message — recorded on any
// task it creates (see createTasksFromPhoneMessage) so the system knows which
// session/employee delegated it. `organizationId` is that session's own
// organization — stamped on the task so it never shows up in another
// organization's task list/reports/commands.
export async function handleMessageForTasks(
  sock: WASocket,
  m: WAMessage,
  sessionId: number | null,
  organizationId: number | null
): Promise<void> {
  const reaction = m.message?.reactionMessage

  if (reaction?.key?.id && !m.key.fromMe) {
    if (isThumbsUp(reaction.text)) {
      // In a group, m.key.participant is who actually sent the reaction —
      // absent in a 1:1 chat, where there's never more than one candidate
      // task to begin with.
      await handleThumbsUpReaction(sock, reaction.key.id, m.key.participant ?? m.key.remoteJid, organizationId)
    }
    return
  }

  const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text
  if (!text || !m.key.id) return

  // A WhatsApp quote-reply to a task's original message or a reminder for it
  // — from either the admin or the recipient — gets logged as a note on
  // that task rather than treated as anything else (e.g. a new #task).
  const quotedMessageId = m.message?.extendedTextMessage?.contextInfo?.stanzaId
  if (quotedMessageId) {
    const replierJid = m.key.fromMe ? null : m.key.participant ?? m.key.remoteJid
    const logged = await logTaskNoteIfReply(sock, quotedMessageId, m.key.id, Boolean(m.key.fromMe), replierJid, text, organizationId)
    if (logged) return
  }

  // Only messages sent from the linked phone/app (fromMe) can create tasks —
  // this is a deliberate design choice: tasks are created by typing "#task"
  // in a normal WhatsApp chat, not through this web app's compose UI.
  if (m.key.fromMe && m.key.remoteJid) {
    // Real WhatsApp @mentions only ever arrive on an extendedTextMessage's
    // contextInfo — never on a plain conversation message.
    const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? []
    await createTasksFromPhoneMessage(sock, m.key.remoteJid, m.key.id, text, sessionId, organizationId, mentionedJids)
  }
}
