import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss } from './boss.js'
import { db } from '../db/index.js'
import { getPrimarySocket } from '../whatsapp/connectionManager.js'
import { scheduleNextReminder } from './taskReminders.js'
import { isProduction } from '../config/env.js'
import type { Task } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

export const QUEUE_TASK_RECUR = 'task-recur'

export async function initRecurringTaskQueue(): Promise<void> {
  await boss.createQueue(QUEUE_TASK_RECUR, {
    retryLimit: 0,
    expireInSeconds: 300
  })
}

interface TaskRecurJobData {
  taskId: number
}

// Applies `recurrence_time` (if set) to a computed fire date, keeping the
// date but overriding the hour/minute — same "snap to a wall-clock time"
// idea as taskReminders.ts's daily anchor.
function snapToTime(date: Date, timeStr: string | null): Date {
  if (!timeStr) return date
  const [hourRaw, minuteRaw] = timeStr.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return date
  const snapped = new Date(date)
  snapped.setHours(hour, minute, 0, 0)
  return snapped
}

async function enqueueRecurrence(taskId: number, startAfter: number | string | Date): Promise<string | null> {
  return boss.send(QUEUE_TASK_RECUR, { taskId }, { singletonKey: `task-recur-${taskId}`, startAfter })
}

async function cancelRecurrence(jobId: string | null): Promise<void> {
  if (!jobId) return
  try {
    await boss.cancel(QUEUE_TASK_RECUR, jobId)
  } catch {
    // Job may already have run or been removed — nothing to do.
  }
}

// Call this whenever a recurring task is marked completed (from any path —
// the API route, the /complete chat command, etc). No-op for non-recurring
// tasks or ones missing the interval fields.
export async function scheduleRecurrence(task: Task): Promise<void> {
  if (!task.is_recurring || !task.recurrence_interval_value || !task.recurrence_interval_unit) return

  const base = task.completed_at ?? new Date()
  const intervalMs = task.recurrence_interval_value * (task.recurrence_interval_unit === 'weeks' ? 7 : 1) * 86_400_000
  const fireAt = snapToTime(new Date(base.getTime() + intervalMs), task.recurrence_time)

  const jobId = await enqueueRecurrence(task.id, fireAt)
  await db.updateTable('tasks').set({ next_recurrence_job_id: jobId }).where('id', '=', task.id).execute()
}

async function processRecurrence(taskId: number): Promise<void> {
  const original = await db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst()

  // Task was deleted or recurrence was turned off since this job was
  // scheduled — nothing to recreate.
  if (!original || !original.is_recurring) return

  const created = await db
    .insertInto('tasks')
    .values({
      recipient_jid: original.recipient_jid,
      contact_id: original.contact_id,
      name: original.name,
      category: original.category,
      priority: original.priority,
      reminder_times_per_day: original.reminder_times_per_day,
      reminder_interval_days: original.reminder_interval_days,
      target_date: null,
      status: 'pending',
      is_recurring: true,
      recurrence_interval_value: original.recurrence_interval_value,
      recurrence_interval_unit: original.recurrence_interval_unit,
      recurrence_time: original.recurrence_time,
      recurrence_parent_id: original.id,
      // Recreation is an automatic system action, not a fresh delegation —
      // attribute the new occurrence to whoever created the original chain,
      // in the same organization.
      created_by_session_id: original.created_by_session_id,
      organization_id: original.organization_id
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  // Recurring-task notifications always go out from the org's admin
  // (primary) session, same as reminders — never the delegator session that
  // may have created the original task.
  const sock = getPrimarySocket()

  if (sock) {
    try {
      const result = await sock.sendMessage(original.recipient_jid, { text: `🔁 ${original.name}` })
      if (result?.key?.id) {
        await db
          .insertInto('task_messages')
          .values({ task_id: created.id, wa_message_id: result.key.id, kind: 'original' })
          .execute()
      }
    } catch (err) {
      logger.warn({ err, taskId: created.id }, 'failed to send recurring task notification')
    }
  }

  if (original.reminder_times_per_day || original.reminder_interval_days) {
    await scheduleNextReminder(created.id)
  }

  await db.updateTable('tasks').set({ next_recurrence_job_id: null }).where('id', '=', original.id).execute()

  logger.info({ originalTaskId: original.id, newTaskId: created.id }, 'recreated recurring task')
}

export async function startRecurringTaskWorker(): Promise<void> {
  await boss.work<TaskRecurJobData>(
    QUEUE_TASK_RECUR,
    { batchSize: 1, pollingIntervalSeconds: 15 },
    async (jobs: Job<TaskRecurJobData>[]) => {
      for (const job of jobs) {
        await processRecurrence(job.data.taskId)
      }
    }
  )
}

export { cancelRecurrence }
