import { isJidGroup, type WASocket, type WAMessage } from '@whiskeysockets/baileys'
import { db } from '../db/index.js'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { recordAuditLog } from '../lib/auditLog.js'
import { AiNotConfiguredError, AiQuotaError } from '../ai/openai.js'
import { takeAiRateLimitSlot } from '../ai/rateLimit.js'
import { runAssistant, type ConversationTurn } from '../ai/assistant.js'
import type { AiContext } from '../ai/tools.js'
import { isSelfChat } from './commandEngine.js'
import { resolveContactId } from './taskEngine.js'

// "@ai" as its own word anywhere in the message — "@ai how many…",
// "hey @ai, …" — but never inside something like "someone@ai.com".
const AI_TRIGGER_RE = /(^|\s)@ai\b[:,]?/i
const AI_TRIGGER_GLOBAL_RE = /(^|\s)@ai\b[:,]?/gi

const HISTORY_TURNS = 6
const HISTORY_TTL_MS = 30 * 60_000
const MAX_REPLY_CHARS = 3500
const MAX_PROMPT_CHARS = 2000
const RECENT_ID_CAP = 500

function messageText(m: WAMessage): string | null {
  return m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? null
}

// Messages the assistant itself sent (replies and task cards). A quote-reply
// to one of its replies in the self-chat continues the conversation without
// retyping "@ai"; and none of them is ever treated as a new request.
const aiSentIds = new Set<string>()
function rememberSent(id: string | null | undefined): void {
  if (!id) return
  aiSentIds.add(id)
  if (aiSentIds.size > RECENT_ID_CAP) aiSentIds.delete(aiSentIds.values().next().value!)
}

// Only the session owner's own messages (sent from the linked phone, like
// #task and /commands) can invoke the assistant — an employee writing "@ai"
// to the admin never reaches the model, so nobody else can spend the
// organization's AI quota or query its data.
export function isAiRequest(m: WAMessage, ownJid: string | null): boolean {
  if (!ownJid || !m.key.fromMe || !m.key.remoteJid || !m.key.id) return false
  if (aiSentIds.has(m.key.id)) return false
  const text = messageText(m)
  if (!text) return false
  if (AI_TRIGGER_RE.test(text)) return true
  const quotedId = m.message?.extendedTextMessage?.contextInfo?.stanzaId
  return Boolean(quotedId && aiSentIds.has(quotedId) && isSelfChat(m, ownJid))
}

// --- short conversation memory (self-chat only, in memory) ------------------

const conversations = new Map<string, { turns: ConversationTurn[]; updatedAt: number }>()
function loadHistory(key: string): ConversationTurn[] {
  const entry = conversations.get(key)
  if (!entry || Date.now() - entry.updatedAt > HISTORY_TTL_MS) {
    conversations.delete(key)
    return []
  }
  return entry.turns
}
function saveTurn(key: string, turn: ConversationTurn): void {
  const turns = [...loadHistory(key), { user: turn.user.slice(0, 1000), assistant: turn.assistant.slice(0, 1500) }].slice(-HISTORY_TURNS)
  conversations.set(key, { turns, updatedAt: Date.now() })
}

// One request per chat at a time, in arrival order — so a quick follow-up
// sees the previous answer in its history instead of racing it.
const chains = new Map<string, Promise<void>>()

// --- helpers ------------------------------------------------------------------

async function chatLabelFor(sock: WASocket, jid: string, organizationId: number): Promise<string> {
  if (isJidGroup(jid)) {
    const group = await db
      .selectFrom('groups')
      .select('subject')
      .where('wa_jid', '=', jid)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst()
    return group?.subject ?? 'a group'
  }
  return (await contactName(sock, jid, organizationId)) ?? jid.split('@')[0] ?? 'this chat'
}

async function contactName(sock: WASocket, jid: string, organizationId: number): Promise<string | null> {
  const contactId = await resolveContactId(sock, jid, organizationId).catch(() => null)
  if (!contactId) return null
  const contact = await db.selectFrom('contacts').select(['display_name', 'phone_number']).where('id', '=', contactId).executeTakeFirst()
  return contact?.display_name ?? contact?.phone_number ?? null
}

// When the @ai message quotes a task's message (its original or a
// reminder), tell the model which task "this" refers to.
async function quotedTaskContext(m: WAMessage, organizationId: number): Promise<string | null> {
  const quotedId = m.message?.extendedTextMessage?.contextInfo?.stanzaId
  if (!quotedId || aiSentIds.has(quotedId)) return null
  const tasks = await db
    .selectFrom('task_messages')
    .innerJoin('tasks', 'tasks.id', 'task_messages.task_id')
    .select(['tasks.id', 'tasks.name'])
    .where('task_messages.wa_message_id', '=', quotedId)
    .where('tasks.organization_id', '=', organizationId)
    .execute()
  if (tasks.length === 0) return null
  return `(This message is a reply to the WhatsApp message for task ${tasks.map((t) => `#${t.id} "${t.name}"`).join(', ')}.)`
}

// Models sometimes answer in Markdown; WhatsApp uses *single* asterisks
// for bold and has no headings.
function toWhatsAppText(text: string): string {
  const cleaned = text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()
  return cleaned.length > MAX_REPLY_CHARS ? `${cleaned.slice(0, MAX_REPLY_CHARS)}…` : cleaned
}

// Every assistant reply ends with this sign-off, so it's clearly marked as
// generated without decorating the message itself.
const AI_SIGNATURE = '\n\n_— AI Assistant_'

async function sendToAdmin(sock: WASocket, ownJid: string, text: string, quoted?: WAMessage): Promise<void> {
  const sent = await sock.sendMessage(ownJid, { text: `${text}${AI_SIGNATURE}` }, quoted ? { quoted } : undefined)
  rememberSent(sent?.key?.id)
}

// --- entry point --------------------------------------------------------------

// Fire-and-forget: a model call can take many seconds, and the caller's
// messages.upsert loop must keep handling every other message (#task
// replies, reactions, commands) in the meantime.
export function handleAiMessage(sock: WASocket, m: WAMessage, sessionId: number, organizationId: number, ownJid: string): void {
  const key = `${sessionId}:${m.key.remoteJid}`
  const previous = chains.get(key) ?? Promise.resolve()
  const next = previous
    .then(() => processAiMessage(sock, m, sessionId, organizationId, ownJid))
    .catch((err) => logger.error({ err, key: m.key }, 'AI request failed'))
    .finally(() => {
      if (chains.get(key) === next) chains.delete(key)
    })
  chains.set(key, next)
}

async function processAiMessage(sock: WASocket, m: WAMessage, sessionId: number, organizationId: number, ownJid: string): Promise<void> {
  const chatJid = m.key.remoteJid!
  const selfChat = isSelfChat(m, ownJid)
  const mode: AiContext['mode'] = selfChat ? 'self' : 'chat'
  const userText = (messageText(m) ?? '').replace(AI_TRIGGER_GLOBAL_RE, ' ').trim().slice(0, MAX_PROMPT_CHARS)
  const startedAt = Date.now()

  if (!userText) {
    await sendToAdmin(sock, ownJid, 'Ask me anything after @ai — e.g. "@ai how many tasks are waiting for review?"', selfChat ? m : undefined)
    return
  }
  if (!env.OPENAI_API_KEY) {
    await sendToAdmin(sock, ownJid, 'The AI assistant is not configured on this server yet.', selfChat ? m : undefined)
    return
  }
  if (!takeAiRateLimitSlot(organizationId)) {
    await sendToAdmin(
      sock,
      ownJid,
      `The AI assistant has reached its limit of ${env.AI_MAX_REQUESTS_PER_HOUR} requests per hour for your organization — please try again a bit later. /commands still work as usual.`,
      selfChat ? m : undefined
    )
    return
  }

  const mentionedJids = m.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? []
  const [organization, chatLabel, mentionedPeople, quotedContext] = await Promise.all([
    db.selectFrom('organizations').select('name').where('id', '=', organizationId).executeTakeFirst(),
    selfChat ? Promise.resolve('your self-chat') : chatLabelFor(sock, chatJid, organizationId),
    Promise.all(mentionedJids.map(async (jid) => `${(await contactName(sock, jid, organizationId)) ?? 'unknown contact'} (jid ${jid}, shown as @${jid.split('@')[0]})`)),
    quotedTaskContext(m, organizationId)
  ])

  const ctx: AiContext = {
    sock,
    organizationId,
    sessionId,
    ownJid,
    mode,
    access: 'write',
    userId: null,
    chatJid,
    chatLabel,
    triggerMessageId: m.key.id!,
    mentionedJids,
    createdTaskIds: [],
    writeCount: 0,
    sentMessageIds: []
  }

  const historyKey = `${sessionId}:${ownJid}`
  if (selfChat) await sock.sendPresenceUpdate('composing', ownJid).catch(() => undefined)

  let replyText: string
  let error: string | null = null
  let result: Awaited<ReturnType<typeof runAssistant>> | null = null
  try {
    result = await runAssistant(ctx, userText, selfChat ? loadHistory(historyKey) : [], {
      organizationName: organization?.name ?? 'the organization',
      mentionedPeople,
      quotedContext
    })
    replyText = result.exhausted
      ? 'That needed more steps than I can take in one go — please split it into smaller requests.'
      : toWhatsAppText(result.text) || 'Done.'
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    logger.error({ err, organizationId, sessionId }, 'AI assistant request failed')
    replyText =
      err instanceof AiNotConfiguredError
        ? 'The AI assistant is not configured on this server yet.'
        : err instanceof AiQuotaError
          ? 'The AI service has reached its usage limit for now (OpenAI account quota). Please try again later — /commands still work as usual.'
          : "Sorry, I couldn't process that right now — please try again in a minute. /commands still work as usual."
  } finally {
    ctx.sentMessageIds.forEach(rememberSent)
    if (selfChat) await sock.sendPresenceUpdate('paused', ownJid).catch(() => undefined)
  }

  if (selfChat) {
    await sendToAdmin(sock, ownJid, `${replyText}`, m)
    if (!error) saveTurn(historyKey, { user: userText, assistant: replyText })
  } else if (ctx.createdTaskIds.length === 0 || error) {
    // In someone else's chat the task message itself is the confirmation;
    // anything else (a question back, a failure) goes privately to the
    // admin, never into the employee's or group's chat.
    await sendToAdmin(sock, ownJid, `About your @ai message in *${chatLabel}*: ${replyText}`)
  }

  await recordAuditLog({
    userId: null,
    action: 'ai_request',
    entityType: 'whatsapp_session',
    entityId: sessionId,
    metadata: {
      organizationId,
      mode,
      chatJid: selfChat ? null : chatJid,
      prompt: userText.slice(0, 500),
      toolCalls: result?.toolCalls ?? [],
      createdTaskIds: ctx.createdTaskIds,
      steps: result?.steps ?? 0,
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      durationMs: Date.now() - startedAt,
      model: env.OPENAI_MODEL,
      error
    }
  }).catch((err) => logger.error({ err }, 'failed to write ai_request audit log'))
}

