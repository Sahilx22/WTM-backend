import type { Job } from 'pg-boss'
import { boss, QUEUE_SEND_MESSAGE, enqueueSendJob, type SendJobData } from './boss.js'
import { db } from '../db/index.js'
import { waitForSendSlot, recordSendOutcome } from './rateLimiter.js'
import { getPrimarySocketForOrganization } from '../whatsapp/connectionManager.js'
import { buildMessageContent } from '../whatsapp/send.js'
import { cacheOwnMessage } from '../whatsapp/store.js'
import { bumpCampaignCounters } from './campaignProgress.js'

const MAX_SEND_ATTEMPTS = 5

async function recordAttempt(messageId: number, attemptNumber: number, success: boolean, error: string | null) {
  await db
    .insertInto('message_attempts')
    .values({
      message_id: messageId,
      attempt_number: attemptNumber,
      status: success ? 'success' : 'failure',
      error_message: error
    })
    .execute()
}

async function processMessage(messageId: number): Promise<void> {
  const message = await db.selectFrom('messages').selectAll().where('id', '=', messageId).executeTakeFirst()
  if (!message || message.status === 'cancelled') return

  // Every message belongs to exactly one organization (see migration 035) —
  // its own org's rate limits/rolling counts apply, and it can only ever go
  // out through that org's own primary session, never a different org's.
  const organizationId = message.organization_id
  if (organizationId === null) {
    await recordAttempt(messageId, message.retry_count + 1, false, 'Message has no owning organization.')
    await db
      .updateTable('messages')
      .set({ status: 'failed', retry_count: message.retry_count + 1, failure_reason: 'Message has no owning organization.', updated_at: new Date() })
      .where('id', '=', messageId)
      .execute()
    return
  }

  let rateOverride: { minDelayMs?: number; maxDelayMs?: number } | null = null
  if (message.campaign_id) {
    const campaign = await db
      .selectFrom('campaigns')
      .select(['rate_limit_override'])
      .where('id', '=', message.campaign_id)
      .executeTakeFirst()
    const raw = campaign?.rate_limit_override as { minDelayMs?: number; maxDelayMs?: number } | null | undefined
    if (raw) rateOverride = raw
  }

  await waitForSendSlot(organizationId, rateOverride)

  // Re-check after potentially waiting a while — the message may have been
  // cancelled in the meantime.
  const fresh = await db
    .selectFrom('messages')
    .select(['status', 'retry_count'])
    .where('id', '=', messageId)
    .executeTakeFirst()
  if (!fresh || fresh.status === 'cancelled') return

  await db.updateTable('messages').set({ status: 'sending', updated_at: new Date() }).where('id', '=', messageId).execute()

  const sock = getPrimarySocketForOrganization(organizationId)

  let error: string | null = null
  let waMessageId: string | null = null

  if (!sock) {
    error = 'WhatsApp is not connected.'
  } else {
    try {
      const content = await buildMessageContent(message)
      const result = await sock.sendMessage(message.recipient_jid, content)
      if (result?.key?.id) {
        waMessageId = result.key.id
        if (result.message) await cacheOwnMessage(result.key, result.message)
      } else {
        error = 'Send did not return a message key.'
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown send error'
    }
  }

  const attemptNumber = fresh.retry_count + 1
  await recordAttempt(messageId, attemptNumber, error === null, error)

  if (error === null) {
    await db
      .updateTable('messages')
      .set({
        status: 'sent',
        wa_message_id: waMessageId,
        sent_at: new Date(),
        failure_reason: null,
        retry_count: attemptNumber,
        updated_at: new Date()
      })
      .where('id', '=', messageId)
      .execute()

    await recordSendOutcome(organizationId, true)
    if (message.campaign_id) await bumpCampaignCounters(message.campaign_id, true)
    return
  }

  await recordSendOutcome(organizationId, false)

  if (attemptNumber >= MAX_SEND_ATTEMPTS) {
    await db
      .updateTable('messages')
      .set({ status: 'failed', retry_count: attemptNumber, failure_reason: error, updated_at: new Date() })
      .where('id', '=', messageId)
      .execute()

    if (message.campaign_id) await bumpCampaignCounters(message.campaign_id, false)
  } else {
    const backoffSeconds = Math.min(300, 5 * 2 ** attemptNumber)
    const jobId = await enqueueSendJob(messageId, { startAfter: backoffSeconds })
    await db
      .updateTable('messages')
      .set({
        status: 'queued',
        retry_count: attemptNumber,
        failure_reason: error,
        pg_boss_job_id: jobId,
        updated_at: new Date()
      })
      .where('id', '=', messageId)
      .execute()
  }
}

let currentWorkerId: string | null = null

// `batchSize` only controls how many jobs are pulled into the handler array
// per poll — the for-loop below always processes them one at a time, in
// series. Actual concurrent WhatsApp sends are deliberately never enabled:
// the rate limiter's pacing (and its rolling-window safety counts) only hold
// up if sends happen one after another, so real parallelism stays off the
// table regardless of this setting.
export async function startOutgoingWorker(batchSize = 1): Promise<void> {
  currentWorkerId = await boss.work<SendJobData>(
    QUEUE_SEND_MESSAGE,
    { batchSize: Math.max(1, batchSize), pollingIntervalSeconds: 2 },
    async (jobs: Job<SendJobData>[]) => {
      for (const job of jobs) {
        await processMessage(job.data.messageId)
      }
    }
  )
}

export async function restartOutgoingWorker(batchSize: number): Promise<void> {
  if (currentWorkerId) {
    await boss.offWork(QUEUE_SEND_MESSAGE)
  }
  await startOutgoingWorker(batchSize)
}
