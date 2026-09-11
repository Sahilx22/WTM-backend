import { PgBoss } from 'pg-boss'
import { env } from '../config/env.js'

export const QUEUE_SEND_MESSAGE = 'send-message'

// Same SSL reasoning as db/index.ts — hosted Postgres needs it, local dev doesn't.
const isLocalDb = /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)

// Small on purpose — see db/index.ts for why (shares the same hosted
// Postgres connection cap as the main app pool). Only actually held open
// while at least one WhatsApp session is connected somewhere — see
// queue/lifecycle.ts.
export const boss = new PgBoss({
  application_name: 'wa-automation-boss',
  connectionString: env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 10_000,
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false }
})

boss.on('error', (err: Error) => console.error('pg-boss error:', err))

let started = false

export async function startBoss(): Promise<void> {
  if (started) return
  await boss.start()
  // Marked started as soon as .start() itself succeeds — before
  // createQueue() below, which can still fail on its own (e.g. the hosted
  // pooler's connection cap, exactly what happens under load). If it does,
  // .start() has already opened pg-boss's connections; started must be true
  // so a caller's cleanup (stopBoss()) actually closes them instead of
  // no-op'ing on a flag that says "never started".
  started = true
  await boss.createQueue(QUEUE_SEND_MESSAGE, {
    // Retries are handled by our own application logic (message.retry_count +
    // manual re-enqueue with backoff) so message status stays accurate —
    // pg-boss itself makes exactly one delivery attempt per job.
    retryLimit: 0,
    expireInSeconds: 3600
  })
}

// Releases pg-boss's own Postgres connections (its `max` in the constructor
// above) — see queue/lifecycle.ts, which calls this whenever no WhatsApp
// session is connected anywhere, since polling for jobs nobody can act on
// yet is pure overhead against the hosted pooler's small connection cap.
export async function stopBoss(): Promise<void> {
  if (!started) return
  await boss.stop({ graceful: true, timeout: 5000 })
  started = false
}

export function isBossStarted(): boolean {
  return started
}

export interface SendJobData {
  messageId: number
}

export async function enqueueSendJob(
  messageId: number,
  options?: { startAfter?: number | string | Date }
): Promise<string | null> {
  return boss.send(
    QUEUE_SEND_MESSAGE,
    { messageId },
    {
      singletonKey: `message-${messageId}`,
      ...(options?.startAfter !== undefined ? { startAfter: options.startAfter } : {})
    }
  )
}

export async function cancelSendJob(jobId: string | null): Promise<void> {
  if (!jobId) return
  try {
    await boss.cancel(QUEUE_SEND_MESSAGE, jobId)
  } catch {
    // Job may already have completed/failed — nothing to cancel, that's fine.
  }
}
