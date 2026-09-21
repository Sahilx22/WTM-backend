import type { Job } from 'pg-boss'
import { sql } from 'kysely'
import pino from 'pino'
import { boss, isBossStarted } from './boss.js'
import { db } from '../db/index.js'
import { getPrimarySocketForOrganization } from '../whatsapp/connectionManager.js'
import { nextDailyAnchorTime } from './taskReminders.js'
import { isProduction } from '../config/env.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

export const QUEUE_RECURRING_REMINDER = 'recurring-reminder'

export async function initRecurringReminderQueue(): Promise<void> {
  await boss.createQueue(QUEUE_RECURRING_REMINDER, { retryLimit: 0, expireInSeconds: 300 })
}

interface RecurringReminderJobData {
  reminderId: number
}

// Cancels every job still waiting to run for one reminder (never the one
// currently executing). pg-boss's `singletonKey` alone does NOT dedupe
// jobs that have a future `startAfter` — verified by test, scheduling the
// same reminder three times left three pending jobs — so "at most one
// pending job per reminder" is enforced here instead, by clearing whatever
// is pending before every enqueue (and on turn-off/delete).
export async function cancelPendingRecurringReminderJobs(reminderId: number): Promise<void> {
  const pending = await sql<{ id: string }>`
    select id from pgboss.job
    where name = ${QUEUE_RECURRING_REMINDER}
      and data->>'reminderId' = ${String(reminderId)}
      and state in ('created', 'retry')
  `.execute(db)
  for (const row of pending.rows) {
    await cancelRecurringReminder(row.id)
  }
}

export async function enqueueRecurringReminder(reminderId: number, startAfter: number | string | Date): Promise<string | null> {
  await cancelPendingRecurringReminderJobs(reminderId)
  return boss.send(QUEUE_RECURRING_REMINDER, { reminderId }, { startAfter })
}

export async function cancelRecurringReminder(jobId: string | null): Promise<void> {
  if (!jobId) return
  try {
    await boss.cancel(QUEUE_RECURRING_REMINDER, jobId)
  } catch {
    // Job may already have run or been removed — nothing to do.
  }
}

// Idempotency guard, same reasoning as queue/scheduledDigests.ts's
// alreadySentToday: makes the actual send safe to attempt more than once on
// the same calendar day, regardless of how the job got (re)scheduled.
function alreadySentToday(lastSentAt: Date | null): boolean {
  if (!lastSentAt) return false
  const now = new Date()
  return lastSentAt.getFullYear() === now.getFullYear() && lastSentAt.getMonth() === now.getMonth() && lastSentAt.getDate() === now.getDate()
}

function isPastEndDate(endDate: Date | null): boolean {
  if (!endDate) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const end = new Date(endDate)
  end.setHours(0, 0, 0, 0)
  return today.getTime() > end.getTime()
}

async function turnOff(reminderId: number): Promise<void> {
  await db
    .updateTable('recurring_reminders')
    .set({ enabled: false, next_send_job_id: null, next_send_at: null, updated_at: new Date() })
    .where('id', '=', reminderId)
    .execute()
}

// Schedules (or reschedules) a recurring reminder's next daily occurrence at
// its own fixed scheduled_time. Called once when a reminder is created
// (whatsapp/recurringReminderEngine.ts), once after each successful/skipped
// send (below), and when re-enabled from the portal — deliberately NOT
// bulk-reapplied on every WhatsApp reconnect the way queue/scheduledDigests.ts
// used to be (see migration 042's comment) — pg-boss keeps each reminder's
// one pending job in its own Postgres-backed queue table, so it's simply
// picked up whenever a worker next polls, without needing to be re-sent.
export async function scheduleNextRecurringReminder(reminderId: number): Promise<void> {
  // The queue is stopped whenever no WhatsApp session is connected anywhere
  // (see queue/lifecycle.ts) — enqueueing then would throw. The reminder just
  // stays enabled with no job, and scheduleUnscheduledRecurringReminders()
  // below schedules it the moment the queue next starts.
  if (!isBossStarted()) return

  const reminder = await db.selectFrom('recurring_reminders').selectAll().where('id', '=', reminderId).executeTakeFirst()
  if (!reminder || !reminder.enabled) return

  if (isPastEndDate(reminder.end_date)) {
    await turnOff(reminderId)
    return
  }

  const nextAt = nextDailyAnchorTime(reminder.scheduled_time)
  const jobId = await enqueueRecurringReminder(reminderId, nextAt)
  await db.updateTable('recurring_reminders').set({ next_send_job_id: jobId, next_send_at: nextAt }).where('id', '=', reminderId).execute()
}

// Called once each time the queue starts (queue/lifecycle.ts): picks up any
// enabled reminder that has no pending job — e.g. one re-enabled from the
// portal, or created, while the queue was stopped. Reminders that already
// have a job are left completely alone, so this can never double-schedule
// (and enqueueRecurringReminder's singletonKey backs that up regardless).
export async function scheduleUnscheduledRecurringReminders(): Promise<void> {
  const rows = await db.selectFrom('recurring_reminders').select('id').where('enabled', '=', true).where('next_send_job_id', 'is', null).execute()
  for (const { id } of rows) {
    await scheduleNextRecurringReminder(id)
  }
}

async function processRecurringReminder(reminderId: number): Promise<void> {
  const reminder = await db.selectFrom('recurring_reminders').selectAll().where('id', '=', reminderId).executeTakeFirst()
  if (!reminder || !reminder.enabled) return

  if (isPastEndDate(reminder.end_date)) {
    await turnOff(reminderId)
    return
  }

  if (alreadySentToday(reminder.last_sent_at)) {
    logger.warn({ reminderId }, 'recurring reminder already sent today — skipping duplicate, just rescheduling tomorrow')
    await scheduleNextRecurringReminder(reminderId)
    return
  }

  const sock = reminder.organization_id !== null ? getPrimarySocketForOrganization(reminder.organization_id) : null
  if (!sock) {
    // Not connected right now — don't drop it, just push back a few minutes.
    const retryAt = new Date(Date.now() + 5 * 60_000)
    const jobId = await enqueueRecurringReminder(reminderId, retryAt)
    await db.updateTable('recurring_reminders').set({ next_send_job_id: jobId, next_send_at: retryAt }).where('id', '=', reminderId).execute()
    return
  }

  try {
    await sock.sendMessage(reminder.recipient_jid, { text: `🔁 ${reminder.message_text}` })
  } catch (err) {
    logger.warn({ err, reminderId }, 'failed to send recurring reminder')
  }

  await db.updateTable('recurring_reminders').set({ last_sent_at: new Date(), updated_at: new Date() }).where('id', '=', reminderId).execute()

  await scheduleNextRecurringReminder(reminderId)
}

export async function startRecurringReminderWorker(): Promise<void> {
  await boss.work<RecurringReminderJobData>(
    QUEUE_RECURRING_REMINDER,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<RecurringReminderJobData>[]) => {
      for (const job of jobs) {
        await processRecurringReminder(job.data.reminderId)
      }
    }
  )
}
