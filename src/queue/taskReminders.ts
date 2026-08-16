import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss } from './boss.js'
import { db } from '../db/index.js'
import { getSocket, getSnapshot } from '../whatsapp/connectionManager.js'
import { isProduction } from '../config/env.js'
import type { TaskFrequency } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

export const QUEUE_TASK_REMINDER = 'task-reminder'

export async function initTaskReminderQueue(): Promise<void> {
  await boss.createQueue(QUEUE_TASK_REMINDER, {
    retryLimit: 0,
    expireInSeconds: 300
  })
}

interface TaskReminderJobData {
  taskId: number
}

// Reminder cadence is admin-editable (Settings) rather than hardcoded — read
// fresh on every send so a mid-flight config change takes effect immediately.
export async function getReminderIntervalMinutes(frequency: TaskFrequency): Promise<number> {
  const settings = await db.selectFrom('task_settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
  switch (frequency) {
    case 'hourly':
      return settings.reminder_hourly_minutes
    case 'daily':
      return settings.reminder_daily_minutes
    case 'weekly':
      return settings.reminder_weekly_minutes
  }
}

// "Daily" reminders anchor to a fixed wall-clock time (e.g. 9:30am) instead
// of a rolling 24h-from-last-send interval, so they don't drift and always
// land at the same time each morning. Returns today's occurrence of `HH:MM`
// if it's still ahead of now, otherwise tomorrow's.
export function nextDailyAnchorTime(timeStr: string, from: Date = new Date()): Date {
  const [hourRaw, minuteRaw] = timeStr.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  const safeHour = Number.isFinite(hour) ? hour : 9
  const safeMinute = Number.isFinite(minute) ? minute : 30

  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), safeHour, safeMinute, 0, 0)
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

export async function enqueueTaskReminder(
  taskId: number,
  startAfter: number | string | Date
): Promise<string | null> {
  return boss.send(
    QUEUE_TASK_REMINDER,
    { taskId },
    { singletonKey: `task-reminder-${taskId}`, startAfter }
  )
}

export async function cancelTaskReminder(jobId: string | null): Promise<void> {
  if (!jobId) return
  try {
    await boss.cancel(QUEUE_TASK_REMINDER, jobId)
  } catch {
    // Job may already have run or been removed — nothing to do.
  }
}

// Schedules (or reschedules) the next reminder for a task and records the
// scheduled time on the row itself so the UI can show "next reminder at ...".
export async function scheduleNextReminder(taskId: number, frequency: TaskFrequency): Promise<void> {
  let nextAt: Date
  if (frequency === 'daily') {
    const settings = await db.selectFrom('task_settings').select('reminder_daily_time').where('id', '=', 1).executeTakeFirstOrThrow()
    nextAt = nextDailyAnchorTime(settings.reminder_daily_time)
  } else {
    const minutes = await getReminderIntervalMinutes(frequency)
    nextAt = new Date(Date.now() + minutes * 60_000)
  }
  const jobId = await enqueueTaskReminder(taskId, nextAt)
  await db
    .updateTable('tasks')
    .set({ next_reminder_job_id: jobId, next_reminder_at: nextAt })
    .where('id', '=', taskId)
    .execute()
}

async function processTaskReminder(taskId: number): Promise<void> {
  const task = await db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst()

  // Task was completed, put in review, deleted, or had reminders manually
  // turned off since this job was scheduled — stop the chain here.
  if (!task || task.status !== 'pending' || !task.reminders_enabled || !task.reminder_frequency) return

  const sock = getSocket()
  const snapshot = getSnapshot()

  if (!sock || snapshot.status !== 'connected') {
    // WhatsApp isn't connected right now — don't drop the reminder, just
    // push it back a few minutes and try again.
    const retryAt = new Date(Date.now() + 5 * 60_000)
    const jobId = await enqueueTaskReminder(taskId, retryAt)
    await db
      .updateTable('tasks')
      .set({ next_reminder_job_id: jobId, next_reminder_at: retryAt })
      .where('id', '=', taskId)
      .execute()
    return
  }

  const dueText = task.target_date ? ` (due ${new Date(task.target_date).toISOString().slice(0, 10)})` : ''
  const text = `⏰ Reminder: ${task.name}${dueText}`

  try {
    const result = await sock.sendMessage(task.recipient_jid, { text })
    if (result?.key?.id) {
      await db
        .insertInto('task_messages')
        .values({ task_id: taskId, wa_message_id: result.key.id, kind: 'reminder' })
        .execute()
    }
  } catch (err) {
    logger.warn({ err, taskId }, 'failed to send task reminder')
  }

  await db
    .updateTable('tasks')
    .set({ last_reminder_sent_at: new Date(), updated_at: new Date() })
    .where('id', '=', taskId)
    .execute()

  await scheduleNextReminder(taskId, task.reminder_frequency)
}

export async function startTaskReminderWorker(): Promise<void> {
  await boss.work<TaskReminderJobData>(
    QUEUE_TASK_REMINDER,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async (jobs: Job<TaskReminderJobData>[]) => {
      for (const job of jobs) {
        await processTaskReminder(job.data.taskId)
      }
    }
  )
}
