import './lib/quietLibsignal.js'
import './config/paths.js'
import { env } from './config/env.js'
import { app } from './app.js'
import { pool, getPoolStats } from './db/index.js'
import { bootAllSessionsWithRetry, shutdownAllSockets } from './whatsapp/connectionManager.js'
import { startWatchdog, stopWatchdog } from './whatsapp/watchdog.js'
import { stopBoss } from './queue/boss.js'
import { initQueueLifecycle } from './queue/lifecycle.js'
import { logger } from './lib/logger.js'
import { recordAuditLog } from './lib/auditLog.js'
import { loadPreviousCrash, recordIncident, writeCrashReport, errorMessage } from './lib/systemHealth.js'

// Surface (and later audit-log) a crash of the previous process before
// anything else — a crash-and-restart must never be silent.
const previousCrash = loadPreviousCrash()

const server = app.listen(env.PORT, () => {
  logger.info(`WA Messenger listening on http://localhost:${env.PORT}`)
})

// A dropped database connection is something the app recovers from on its
// own (pg discards the dead client, the next query opens a fresh one) — but
// a race inside `pg` can re-emit it as an 'error' event nobody is listening
// for, which Node turns into an uncaughtException. That exact error crashed
// production on 2026-10-04 and kicked off a multi-day outage. These are
// treated as non-fatal; anything else still exits (after writing a crash
// report) so Docker restarts us into a clean state.
function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: string }).code
  const fromPg = /node_modules[\\/](pg|pg-pool|pg-boss)[\\/]/.test(err.stack ?? '')
  const transient =
    /Connection terminated|connection timeout|terminating connection|server closed the connection|Client has encountered a connection error/i.test(err.message) ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '08006', '08003', '08001'].includes(code ?? '')
  return fromPg && transient
}

process.on('uncaughtException', (err) => {
  if (isTransientDbError(err)) {
    logger.error({ err }, 'transient database connection error (non-fatal) — continuing')
    recordIncident('transient_db_error', `Database connection dropped: ${errorMessage(err)}`)
    return
  }
  logger.fatal({ err }, 'uncaught exception — writing crash report and exiting')
  writeCrashReport(err)
  void shutdown('uncaughtException', 1)
})

// Logged instead of crashing the process: one forgotten .catch() somewhere
// should never take every WhatsApp session down with it.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection')
  recordIncident('unhandled_rejection', `Unhandled promise rejection: ${errorMessage(reason)}`)
})

// Render (and most PaaS hosts) send SIGTERM to the old instance on every
// deploy. Without this, the process dies with its Postgres connections still
// open — Supabase's pooler only reclaims those once its own timeout notices
// the socket is dead, so repeated deploys can silently pile up idle
// connections until unrelated requests start failing with pool-exhaustion
// errors. A 10s hard-exit fallback guards against any one step hanging.
let shuttingDown = false
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, shutting down gracefully…`)
  stopWatchdog()

  const forceExit = setTimeout(() => {
    console.warn('Graceful shutdown timed out — forcing exit.')
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  try {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    console.error('Error closing HTTP server:', err)
  }

  // Best-effort — never blocks the rest of shutdown on a socket that won't
  // close cleanly. Also cancels pending reconnect timers, so nothing tries
  // to open a fresh DB query after the pool below is gone.
  shutdownAllSockets()

  try {
    await stopBoss()
  } catch (err) {
    console.error('Error stopping pg-boss:', err)
  }

  // pool.end() is only ever called here, on process shutdown — never after
  // a request, message, or job. Logged so a stuck shutdown (something still
  // holding a connection) is visible instead of silently hanging until the
  // 10s force-exit fallback below fires.
  console.log('Postgres pool before close:', getPoolStats())
  try {
    await pool.end()
  } catch (err) {
    console.error('Error closing Postgres pool:', err)
  }

  clearTimeout(forceExit)
  process.exit(exitCode)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Starts/stops pg-boss (reminders, auto-reports, digests, the outgoing
// queue) in step with whether any WhatsApp session is connected anywhere —
// see queue/lifecycle.ts. Registered before bootAllSessions() so it's ready
// to react the moment any resumed session reconnects.
initQueueLifecycle()

// Resume every organization's previously-created WhatsApp session(s) on
// boot. A session with no saved creds yet just comes up at qr_pending.
// Retries until it succeeds — see bootAllSessionsWithRetry() for why.
void bootAllSessionsWithRetry().then(() => {
  if (!previousCrash) return
  recordAuditLog({
    userId: null,
    action: 'server_crash_recovered',
    entityType: 'system',
    metadata: { crashedAt: previousCrash.at, message: previousCrash.message, stack: previousCrash.stack?.slice(0, 2000) }
  }).catch((err) => logger.error({ err }, 'failed to write server_crash_recovered audit log'))
})

startWatchdog()
