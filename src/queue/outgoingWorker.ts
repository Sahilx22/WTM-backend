import type { Job } from 'pg-boss'
import { boss, QUEUE_SEND_MESSAGE, enqueueSendJob, cancelSendJob, type SendJobData } from './boss.js'
import { db } from '../db/index.js'
import { waitForSendSlot, recordSendOutcome } from './rateLimiter.js'
import { getPrimarySocketForOrganization, getConnectedSocketForSession, maskPhoneNumber } from '../whatsapp/connectionManager.js'
import { buildMessageContent } from '../whatsapp/send.js'
import { cacheOwnMessage } from '../whatsapp/store.js'
import { bumpCampaignCounters, campaignEvents } from './campaignProgress.js'
import { chatMessageEvents } from '../whatsapp/chatEvents.js'

// Chat-originated sends (see modules/chat/routes.ts) already got their
// full normalized shape back in the POST response for the tab that sent
// them — this only needs to patch that message's status/wa_message_id, not
// re-sign media (an extra S3 round trip on the hot send path). A second
// browser tab watching the same thread that didn't originate the send
// simply won't recognize this id yet and will pick it up on its next full
// load — an accepted simplification, not a live mirror of another tab's sends.
function emitChatStatus(organizationId: number, contactId: number, messageId: number, messageType: string, status: string, waMessageId: string | null) {
  chatMessageEvents.emit('message', {
    organizationId,
    contactId,
    message: {
      id: `msg-${messageId}`,
      direction: 'outbound',
      messageType,
      text: null,
      mediaUrl: null,
      mediaMimetype: null,
      status,
      waMessageId,
      createdAt: new Date().toISOString()
    }
  })
}

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

// The WhatsApp number chosen for a campaign isn't connected when its
// messages come due: mark the whole campaign failed (every message that
// hasn't gone out yet fails with the reason, its pending queue jobs are
// cancelled) instead of retrying or sending through another number.
// Messages already sent stay sent and keep counting as successes.
async function failCampaignSessionUnavailable(campaignId: number, sessionId: number): Promise<void> {
  const session = await db
    .selectFrom('whatsapp_sessions')
    .select(['label', 'phone_number'])
    .where('id', '=', sessionId)
    .executeTakeFirst()
  const name = session ? [session.label, maskPhoneNumber(session.phone_number)].filter(Boolean).join(' · ') : `#${sessionId}`
  const reason = `The selected WhatsApp${name ? ` (${name})` : ''} was not connected at the scheduled time.`

  const now = new Date()
  const failed = await db
    .updateTable('messages')
    .set({ status: 'failed', failure_reason: reason, updated_at: now })
    .where('campaign_id', '=', campaignId)
    .where('status', 'in', ['scheduled', 'queued', 'sending'])
    .returning(['id', 'pg_boss_job_id'])
    .execute()

  for (const m of failed) await cancelSendJob(m.pg_boss_job_id)

  await db
    .updateTable('campaigns')
    .set((eb) => ({
      status: 'failed',
      processed_count: eb('processed_count', '+', failed.length),
      failed_count: eb('failed_count', '+', failed.length),
      completed_at: now,
      updated_at: now
    }))
    .where('id', '=', campaignId)
    .where('status', 'in', ['scheduled', 'sending'])
    .execute()

  campaignEvents.emit('update', campaignId)
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
  // The session a campaign was created to send from — null for non-campaign
  // messages and for campaigns predating the choice (primary session).
  let campaignSessionId: number | null = null
  if (message.campaign_id) {
    const campaign = await db
      .selectFrom('campaigns')
      .select(['rate_limit_override', 'status', 'whatsapp_session_id'])
      .where('id', '=', message.campaign_id)
      .executeTakeFirst()
    // A campaign already marked failed/cancelled never sends anything more.
    if (campaign?.status === 'failed' || campaign?.status === 'cancelled') return
    const raw = campaign?.rate_limit_override as { minDelayMs?: number; maxDelayMs?: number } | null | undefined
    if (raw) rateOverride = raw
    campaignSessionId = campaign?.whatsapp_session_id ?? null

    // A scheduled campaign becomes "sending" once its first message comes
    // due — bumpCampaignCounters only completes a campaign that is "sending".
    if (campaign?.status === 'scheduled') {
      await db
        .updateTable('campaigns')
        .set({ status: 'sending', started_at: new Date(), updated_at: new Date() })
        .where('id', '=', message.campaign_id)
        .where('status', '=', 'scheduled')
        .execute()
      campaignEvents.emit('update', message.campaign_id)
    }

    // Fail fast, before waiting on the rate limiter, when the chosen number
    // is already not connected.
    if (campaignSessionId !== null && !getConnectedSocketForSession(campaignSessionId, organizationId)) {
      await failCampaignSessionUnavailable(message.campaign_id, campaignSessionId)
      return
    }
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

  // The chosen number is the only one a campaign may use — if it dropped
  // while waiting for a send slot, the campaign fails rather than the
  // message quietly going out through a different number.
  if (message.campaign_id && campaignSessionId !== null && !getConnectedSocketForSession(campaignSessionId, organizationId)) {
    await failCampaignSessionUnavailable(message.campaign_id, campaignSessionId)
    return
  }

  await db.updateTable('messages').set({ status: 'sending', updated_at: new Date() }).where('id', '=', messageId).execute()

  const sock =
    campaignSessionId !== null
      ? getConnectedSocketForSession(campaignSessionId, organizationId)
      : getPrimarySocketForOrganization(organizationId)

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
    if (message.recipient_contact_id) {
      emitChatStatus(organizationId, message.recipient_contact_id, messageId, message.message_type, 'sent', waMessageId)
    }
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
    if (message.recipient_contact_id) {
      emitChatStatus(organizationId, message.recipient_contact_id, messageId, message.message_type, 'failed', null)
    }
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
