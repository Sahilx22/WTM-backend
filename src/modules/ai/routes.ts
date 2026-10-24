import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/index.js'
import { env } from '../../config/env.js'
import { requireOrgAdmin } from '../../auth/middleware.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { logger } from '../../lib/logger.js'
import { runAssistant, type ConversationTurn } from '../../ai/assistant.js'
import { AiQuotaError } from '../../ai/openai.js'
import { takeAiRateLimitSlot } from '../../ai/rateLimit.js'
import type { AiContext } from '../../ai/tools.js'
import { getPrimarySnapshotForOrganization, getPrimarySocketForOrganization } from '../../whatsapp/connectionManager.js'

// The portal's AI Assistant page — the same assistant as WhatsApp "@ai"
// (src/ai/), talked to directly. Admin-only: the assistant reads every task
// in the organization, which a restricted (Shared Access) user must never
// see. The page itself keeps the conversation; each request sends the
// recent turns back, so nothing is stored server-side.
export const aiRouter = Router()

const chatSchema = z.object({
  message: z.string().trim().min(1, 'Type a message first.').max(2000, 'Keep the message under 2000 characters.'),
  // "read" never offers or runs a task-changing tool (enforced in
  // src/ai/tools.ts, not just by the model's instructions).
  access: z.enum(['read', 'write']),
  history: z
    .array(z.object({ user: z.string().max(4000), assistant: z.string().max(8000) }))
    .max(20)
    .default([])
})

const HISTORY_TURNS = 8

aiRouter.get('/ai/status', requireOrgAdmin, (req, res) => {
  const organizationId = req.user!.organizationId!
  res.json({
    configured: Boolean(env.OPENAI_API_KEY),
    whatsappConnected: getPrimarySocketForOrganization(organizationId) !== null,
    requestsPerHour: env.AI_MAX_REQUESTS_PER_HOUR
  })
})

aiRouter.post('/ai/chat', requireOrgAdmin, async (req, res) => {
  const parsed = chatSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request.' })
    return
  }
  const { message, access, history } = parsed.data
  const user = req.user!
  const organizationId = user.organizationId!

  if (!env.OPENAI_API_KEY) {
    res.status(503).json({ error: 'The AI assistant is not configured on this server yet.' })
    return
  }
  if (!takeAiRateLimitSlot(organizationId)) {
    res.status(429).json({ error: `Your organization has reached its limit of ${env.AI_MAX_REQUESTS_PER_HOUR} AI requests per hour. Please try again a bit later.` })
    return
  }

  const primary = getPrimarySnapshotForOrganization(organizationId)
  const ctx: AiContext = {
    sock: getPrimarySocketForOrganization(organizationId),
    organizationId,
    sessionId: primary?.sessionId ?? null,
    ownJid: primary?.waJid ?? null,
    mode: 'portal',
    access,
    userId: user.id,
    chatJid: '',
    chatLabel: 'the web portal',
    triggerMessageId: null,
    mentionedJids: [],
    createdTaskIds: [],
    writeCount: 0,
    sentMessageIds: []
  }

  const organization = await db.selectFrom('organizations').select('name').where('id', '=', organizationId).executeTakeFirst()
  const startedAt = Date.now()
  let error: string | null = null
  let quotaExhausted = false
  let result: Awaited<ReturnType<typeof runAssistant>> | null = null

  try {
    result = await runAssistant(ctx, message, history.slice(-HISTORY_TURNS) as ConversationTurn[], {
      organizationName: organization?.name ?? 'the organization',
      mentionedPeople: [],
      quotedContext: null,
      userName: user.username
    })
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    quotaExhausted = err instanceof AiQuotaError
    logger.error({ err, organizationId, userId: user.id }, 'portal AI request failed')
  }

  await recordAuditLog({
    userId: user.id,
    action: 'ai_request',
    entityType: 'organization',
    entityId: organizationId,
    ipAddress: req.ip ?? null,
    metadata: {
      via: 'portal',
      access,
      prompt: message.slice(0, 500),
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

  if (!result) {
    res.status(quotaExhausted ? 429 : 502).json({
      error: quotaExhausted
        ? 'The AI service has reached its usage limit for now (OpenAI account quota). Please try again later.'
        : "The AI assistant couldn't answer right now. Please try again in a minute."
    })
    return
  }

  const reply = result.exhausted
    ? 'That needed more steps than I can take in one go. Please split it into smaller requests.'
    : result.text.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+/gm, '').trim() || 'Done.'

  res.json({
    reply,
    access,
    // What actually ran, so the page can flag answers that changed data.
    changedData: ctx.writeCount > 0,
    createdTaskIds: ctx.createdTaskIds,
    toolCalls: result.toolCalls
  })
})
