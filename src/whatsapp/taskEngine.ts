import { isPnUser, isLidUser, jidDecode, type WASocket, type WAMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from '../db/index.js'
import { isProduction } from '../config/env.js'
import { parseTaskMessage, isThumbsUp } from './taskParser.js'
import { scheduleNextReminder, cancelTaskReminder } from '../queue/taskReminders.js'
import { recordAuditLog } from '../lib/auditLog.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

// A contact's saved `wa_jid` and the jid on an incoming message can be in
// different forms (phone-number vs LID) even though they're the same
// person — a direct string match on wa_jid silently misses those. Fall back
// to resolving the message's jid down to a phone number (decoding directly
// for PN-form, or via Baileys' LID↔PN mapping for LID-form) and matching
// contacts on that instead, since phone_number is our one form-independent
// identifier.
export async function resolveContactId(sock: WASocket, jid: string): Promise<number | null> {
  const direct = await db.selectFrom('contacts').select('id').where('wa_jid', '=', jid).executeTakeFirst()
  if (direct) return direct.id

  let phoneNumber: string | null = null

  if (isPnUser(jid)) {
    phoneNumber = jidDecode(jid)?.user ?? null
  } else if (isLidUser(jid)) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid)
      if (pn) phoneNumber = jidDecode(pn)?.user ?? null
    } catch (err) {
      logger.warn({ err, jid }, 'failed to resolve LID to PN for contact matching')
    }
  }

  if (!phoneNumber) return null

  const byPhone = await db.selectFrom('contacts').select('id').where('phone_number', '=', phoneNumber).executeTakeFirst()
  return byPhone?.id ?? null
}

async function createTaskFromPhoneMessage(
  sock: WASocket,
  recipientJid: string,
  originalMessageId: string,
  text: string
): Promise<void> {
  const parsed = parseTaskMessage(text)
  if (!parsed) return

  const contactId = await resolveContactId(sock, recipientJid)

  const created = await db
    .insertInto('tasks')
    .values({
      recipient_jid: recipientJid,
      contact_id: contactId,
      name: parsed.name,
      priority: parsed.priority,
      reminder_times_per_day: parsed.timesPerDay,
      reminder_interval_days: parsed.intervalDays,
      target_date: parsed.targetDate ? new Date(parsed.targetDate) : null,
      status: 'pending'
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

  logger.info({ taskId: created.id, name: parsed.name, recipientJid }, 'created task from phone message')

  await recordAuditLog({
    userId: null,
    action: 'task_created_from_whatsapp',
    entityType: 'task',
    entityId: created.id,
    metadata: {
      name: parsed.name,
      priority: parsed.priority,
      timesPerDay: parsed.timesPerDay,
      intervalDays: parsed.intervalDays,
      targetDate: parsed.targetDate,
      recipientJid
    }
  })
}

async function handleThumbsUpReaction(reactedMessageId: string): Promise<void> {
  const taskMessage = await db
    .selectFrom('task_messages')
    .select('task_id')
    .where('wa_message_id', '=', reactedMessageId)
    .executeTakeFirst()

  if (!taskMessage) return

  const task = await db
    .selectFrom('tasks')
    .select(['id', 'status', 'next_reminder_job_id'])
    .where('id', '=', taskMessage.task_id)
    .executeTakeFirst()

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
// caller so a single bad message never takes down the connection.
export async function handleMessageForTasks(sock: WASocket, m: WAMessage): Promise<void> {
  const reaction = m.message?.reactionMessage

  if (reaction?.key?.id && !m.key.fromMe) {
    if (isThumbsUp(reaction.text)) {
      await handleThumbsUpReaction(reaction.key.id)
    }
    return
  }

  // Only messages sent from the linked phone/app (fromMe) can create tasks —
  // this is a deliberate design choice: tasks are created by typing "#task"
  // in a normal WhatsApp chat, not through this web app's compose UI.
  if (m.key.fromMe && m.key.remoteJid && m.key.id) {
    const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text
    if (text) {
      await createTaskFromPhoneMessage(sock, m.key.remoteJid, m.key.id, text)
    }
  }
}
