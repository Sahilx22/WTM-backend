import pino from 'pino'
import { startBoss, stopBoss, isBossStarted } from './boss.js'
import { startOutgoingWorker } from './outgoingWorker.js'
import { initTaskReminderQueue, startTaskReminderWorker } from './taskReminders.js'
import { initAutoReportQueues, startAutoReportWorkers, applyAutoReportSchedule, listAllTaskSettings } from './autoReports.js'
import { initDigestQueues, startDigestWorkers, applyDigestSchedule } from './scheduledDigests.js'
import { initRecurringTaskQueue, startRecurringTaskWorker } from './recurringTasks.js'
import { connectionEvents, isAnySessionConnected } from '../whatsapp/connectionManager.js'
import { isProduction } from '../config/env.js'
import type { TaskSettings } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

// pg-boss (the outgoing-message queue, task reminders, auto-reports,
// digests, recurring tasks) holds its own small pool of Postgres
// connections and polls continuously — useful only while at least one
// WhatsApp session is actually connected somewhere to act on. Idle
// otherwise, it's pure overhead against the hosted pooler's small
// connection cap, so it's started/stopped in step with whether any session
// is connected instead of running unconditionally for the life of the
// process. Nothing scheduled is lost while paused — jobs just wait for the
// next connect to be picked up, same as they already wait if the specific
// session they need happens to be offline (see queue/taskReminders.ts).
let starting = false
let stopping = false

// Verified empirically (not assumed): pg-boss does NOT keep a previously
// registered `.work()` subscription alive across a stop()/start() cycle —
// jobs sent after a restart are silently never picked up unless `.work()`
// is called again. So every single transition from stopped to running has
// to redo the full queue-create + worker-register sequence, not just the
// first one. `initXQueue()` is idempotent (safe to call again on a queue
// that already exists), so this is safe to repeat.
async function registerWorkers(): Promise<void> {
  // The outgoing-message queue/worker is shared by every organization (all
  // orgs' messages flow through the one `send-message` queue) — there is no
  // single "the" concurrency setting to read here anymore now that
  // rate_limit_config is per-organization (see migration 036). `batchSize`
  // only controls how many jobs are pulled per poll, not real parallelism
  // (see outgoingWorker.ts), so a fixed default is safe; an org's own saved
  // concurrency value still takes effect via settings/routes.ts calling
  // restartOutgoingWorker() directly.
  await startOutgoingWorker(1)
  await initTaskReminderQueue()
  await startTaskReminderWorker()
  await initAutoReportQueues()
  await startAutoReportWorkers()
  await initDigestQueues()
  await startDigestWorkers()
  await initRecurringTaskQueue()
  await startRecurringTaskWorker()
}

// How long to wait before trying again after a failed start (e.g. the
// hosted pooler's connection cap was momentarily full) — long enough for
// that kind of transient pressure to clear, short enough that reminders/
// reports aren't stuck off for long once a session is actually connected.
const RETRY_DELAY_MS = 30_000

export async function ensureQueuesRunning(): Promise<void> {
  if (isBossStarted() || starting) return
  starting = true
  try {
    await startBoss()
    await registerWorkers()
    // Every organization's own auto-report/digest chains get (re)started
    // here, not just one — each is independent (see applyAutoReportSchedule/
    // applyDigestSchedule), so a fresh boot resumes every org's schedule.
    const allTaskSettings = await listAllTaskSettings()
    for (const settings of allTaskSettings) {
      await applyAutoReportSchedule(settings.organization_id, settings)
      await applyDigestSchedule(settings.organization_id, settings)
    }
    logger.info('queue workers started — a WhatsApp session is connected')
  } catch (err) {
    logger.error({ err }, 'failed to start queue workers — will retry shortly')
    // startBoss() may have partially succeeded (its own connections opened,
    // ours registered as started, but createQueue/worker registration
    // failed) — release whatever it did open before retrying, so a retry
    // starts from a clean slate instead of piling more connections on top.
    try {
      await stopBoss()
    } catch (cleanupErr) {
      logger.error({ err: cleanupErr }, 'failed to clean up after a failed queue start')
    }
    setTimeout(() => {
      // Only worth retrying if something is still actually connected —
      // otherwise ensureQueuesStopped() already covers the "nothing to do"
      // case and this would just be a wasted connection attempt.
      if (isAnySessionConnected()) void ensureQueuesRunning()
    }, RETRY_DELAY_MS)
  } finally {
    starting = false
  }
}

export async function ensureQueuesStopped(): Promise<void> {
  if (!isBossStarted() || stopping) return
  stopping = true
  try {
    await stopBoss()
    logger.info('queue workers stopped — no WhatsApp session is connected anywhere, freed their database connections')
  } catch (err) {
    logger.error({ err }, 'failed to stop queue workers cleanly')
  } finally {
    stopping = false
  }
}

// Called by the Settings routes when one organization's task/report/digest
// settings change — applies immediately if the queues are live; if they're
// currently paused (nothing connected anywhere), it's a no-op, since
// ensureQueuesRunning() above always re-applies every organization's latest
// settings the moment something reconnects.
export async function reapplySchedulesIfRunning(organizationId: number, settings: TaskSettings): Promise<void> {
  if (!isBossStarted()) {
    logger.info({ organizationId }, 'queue workers are paused — new schedule will apply once a session reconnects')
    return
  }
  await applyAutoReportSchedule(organizationId, settings)
  await applyDigestSchedule(organizationId, settings)
}

function handleConnectionChange(): void {
  if (isAnySessionConnected()) {
    void ensureQueuesRunning()
  } else {
    void ensureQueuesStopped()
  }
}

// Call once at boot. Session reconnects from bootAllSessions() (and every
// future connect/disconnect) flow through the same connectionEvents emitter,
// so this one subscription covers startup and the whole process lifetime.
export function initQueueLifecycle(): void {
  connectionEvents.on('update', handleConnectionChange)
}
