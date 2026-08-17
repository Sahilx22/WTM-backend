import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss } from './boss.js'
import { db } from '../db/index.js'
import { getSocket, getSnapshot } from '../whatsapp/connectionManager.js'
import { isProduction } from '../config/env.js'

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

function parseTimeStr(timeStr: string, fallbackHour: number, fallbackMinute: number): { hour: number; minute: number } {
  const [hourRaw, minuteRaw] = timeStr.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  return {
    hour: Number.isFinite(hour) ? hour : fallbackHour,
    minute: Number.isFinite(minute) ? minute : fallbackMinute
  }
}

// "1TAD" reminders anchor to a fixed wall-clock time (e.g. 9:30am) instead of
// a rolling 24h-from-last-send interval, so they don't drift and always land
// at the same time each day. Returns today's occurrence of `HH:MM` if it's
// still ahead of `from`, otherwise tomorrow's.
export function nextDailyAnchorTime(timeStr: string, from: Date = new Date()): Date {
  const { hour, minute } = parseTimeStr(timeStr, 9, 30)
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, minute, 0, 0)
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

// For "2TAD"/"3TAD"/etc — splits the working-hours window into N equal
// slots for a given calendar day. E.g. 09:00-18:30 with n=2 gives slots at
// 09:00 and 13:45.
function workingHourSlotsForDay(date: Date, startStr: string, endStr: string, n: number): Date[] {
  const start = parseTimeStr(startStr, 9, 0)
  const end = parseTimeStr(endStr, 18, 30)
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), start.hour, start.minute, 0, 0)
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), end.hour, end.minute, 0, 0)
  const stepMs = (dayEnd.getTime() - dayStart.getTime()) / n
  return Array.from({ length: n }, (_, i) => new Date(dayStart.getTime() + i * stepMs))
}

// Finds the next working-hour slot strictly after `from` — today's remaining
// slots first, else tomorrow's first slot.
export function nextWorkingHourSlot(n: number, startStr: string, endStr: string, from: Date = new Date()): Date {
  const todaySlots = workingHourSlotsForDay(from, startStr, endStr, n)
  const next = todaySlots.find((slot) => slot.getTime() > from.getTime())
  if (next) return next

  const tomorrow = new Date(from)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const firstSlot = workingHourSlotsForDay(tomorrow, startStr, endStr, n)[0]
  return firstSlot ?? nextDailyAnchorTime(startStr, from)
}

// Once-every-N-days reminders ("1IN2D"/"1IN3D") — N days from `from`, snapped
// to the daily anchor time so they land at a predictable hour.
function nextIntervalDaysTime(intervalDays: number, anchorTimeStr: string, from: Date = new Date()): Date {
  const { hour, minute } = parseTimeStr(anchorTimeStr, 9, 30)
  const target = new Date(from)
  target.setDate(target.getDate() + intervalDays)
  target.setHours(hour, minute, 0, 0)
  return target
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
// Reads the task's own reminder_times_per_day/reminder_interval_days off the
// row — no-ops if neither is set (no repeating reminder configured).
export async function scheduleNextReminder(taskId: number): Promise<void> {
  const task = await db
    .selectFrom('tasks')
    .select(['reminder_times_per_day', 'reminder_interval_days'])
    .where('id', '=', taskId)
    .executeTakeFirst()

  if (!task || (!task.reminder_times_per_day && !task.reminder_interval_days)) return

  const settings = await db
    .selectFrom('task_settings')
    .select(['reminder_daily_time', 'working_hours_start', 'working_hours_end'])
    .where('id', '=', 1)
    .executeTakeFirstOrThrow()

  let nextAt: Date
  if (task.reminder_interval_days) {
    nextAt = nextIntervalDaysTime(task.reminder_interval_days, settings.reminder_daily_time)
  } else if (task.reminder_times_per_day === 1) {
    nextAt = nextDailyAnchorTime(settings.reminder_daily_time)
  } else {
    nextAt = nextWorkingHourSlot(task.reminder_times_per_day!, settings.working_hours_start, settings.working_hours_end)
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
  if (
    !task ||
    task.status !== 'pending' ||
    !task.reminders_enabled ||
    (!task.reminder_times_per_day && !task.reminder_interval_days)
  ) {
    return
  }

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
  const text = `⏰ [${task.priority}] Reminder: ${task.name}${dueText}`

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

  await scheduleNextReminder(taskId)
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
