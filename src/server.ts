import './config/paths.js'
import { env } from './config/env.js'
import { app } from './app.js'
import { requestConnect } from './whatsapp/connectionManager.js'
import { startBoss } from './queue/boss.js'
import { startOutgoingWorker } from './queue/outgoingWorker.js'
import { getRateLimitConfig } from './queue/rateLimiter.js'
import { initTaskReminderQueue, startTaskReminderWorker } from './queue/taskReminders.js'
import { initAutoReportQueues, startAutoReportWorkers, applyAutoReportSchedules, loadTaskSettings } from './queue/autoReports.js'
import { initDigestQueues, startDigestWorkers, applyDigestSchedules } from './queue/scheduledDigests.js'
import { initRecurringTaskQueue, startRecurringTaskWorker } from './queue/recurringTasks.js'

app.listen(env.PORT, () => {
  console.log(`WA Messenger listening on http://localhost:${env.PORT}`)
})

// Attempt to (re)establish the shared WhatsApp connection on boot. If no
// session was ever linked, this just brings the socket up to qr_pending.
void requestConnect().catch((err) => {
  console.error('Initial WhatsApp connection attempt failed:', err)
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
