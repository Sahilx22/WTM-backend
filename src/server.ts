import './config/paths.js'
import { env } from './config/env.js'
import { app } from './app.js'
import { pool } from './db/index.js'
import { bootAllSessions } from './whatsapp/connectionManager.js'
import { boss, startBoss } from './queue/boss.js'
import { startOutgoingWorker } from './queue/outgoingWorker.js'
import { getRateLimitConfig } from './queue/rateLimiter.js'
import { initTaskReminderQueue, startTaskReminderWorker } from './queue/taskReminders.js'
import { initAutoReportQueues, startAutoReportWorkers, applyAutoReportSchedules, loadTaskSettings } from './queue/autoReports.js'
import { initDigestQueues, startDigestWorkers, applyDigestSchedules } from './queue/scheduledDigests.js'
import { initRecurringTaskQueue, startRecurringTaskWorker } from './queue/recurringTasks.js'

const server = app.listen(env.PORT, () => {
  console.log(`WA Messenger listening on http://localhost:${env.PORT}`)
})

// Render (and most PaaS hosts) send SIGTERM to the old instance on every
// deploy. Without this, the process dies with its Postgres connections still
// open — Supabase's pooler only reclaims those once its own timeout notices
// the socket is dead, so repeated deploys can silently pile up idle
// connections until unrelated requests start failing with pool-exhaustion
// errors. A 10s hard-exit fallback guards against any one step hanging.
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, shutting down gracefully…`)

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

  try {
    await boss.stop({ graceful: true, timeout: 5000 })
  } catch (err) {
    console.error('Error stopping pg-boss:', err)
  }

  try {
    await pool.end()
  } catch (err) {
    console.error('Error closing Postgres pool:', err)
  }

  clearTimeout(forceExit)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Resume every organization's previously-created WhatsApp session(s) on
// boot. A session with no saved creds yet just comes up at qr_pending.
void bootAllSessions().catch((err) => {
  console.error('Initial WhatsApp session bootstrap failed:', err)
})

void startBoss()
  .then(async () => {
    const cfg = await getRateLimitConfig()
    await startOutgoingWorker(cfg.concurrency)
    await initTaskReminderQueue()
    await startTaskReminderWorker()
    await initAutoReportQueues()
    await startAutoReportWorkers()
    await initDigestQueues()
    await startDigestWorkers()
    await initRecurringTaskQueue()
    await startRecurringTaskWorker()
    const taskSettings = await loadTaskSettings()
    await applyAutoReportSchedules(taskSettings)
    await applyDigestSchedules(taskSettings)
  })
  .catch((err) => {
    console.error('Failed to start the queue workers:', err)
  })
