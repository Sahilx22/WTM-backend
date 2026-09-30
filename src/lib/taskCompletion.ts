import { db } from '../db/index.js'
import { cancelTaskReminder } from '../queue/taskReminders.js'
import { scheduleRecurrence } from '../queue/recurringTasks.js'
import { recordAuditLog } from './auditLog.js'
import type { Task } from '../db/schema.js'

export interface CompleteTaskOptions {
  userId?: number | null
  via?: string
  ipAddress?: string | null
}

// Marks a task completed and handles everything that must happen alongside
// that transition — cancelling any pending reminder job and, for recurring
// tasks, scheduling the next occurrence. Shared by every place a task can be
// completed: the portal's "Mark completed" button (modules/tasks/routes.ts),
// the WhatsApp /complete command (whatsapp/commandEngine.ts), a WhatsApp
// quote-reply saying "done" (whatsapp/taskEngine.ts), and the portal Chat
// feature's own "done" shortcut (modules/chat/routes.ts) — so this logic
// only exists once instead of drifting across four near-copies of it.
//
// A standing task (never_completes, the "rec" tag on #task — see
// taskParser.ts) silently no-ops here: it's meant to keep reminding
// forever, so none of the above paths are allowed to close it out. The
// "done" reply/portal click still isn't lost — logTaskNoteIfReply() logs it
// as a chat note either way, this only suppresses the status change.
export async function completeTask(task: Task, options: CompleteTaskOptions = {}): Promise<void> {
  if (task.status === 'completed' || task.never_completes) return

  await cancelTaskReminder(task.next_reminder_job_id)

  const completedAt = new Date()
  await db
    .updateTable('tasks')
    .set({
      status: 'completed',
      next_reminder_job_id: null,
      next_reminder_at: null,
      completed_at: completedAt,
      updated_at: completedAt
    })
    .where('id', '=', task.id)
    .execute()

  await recordAuditLog({
    userId: options.userId ?? null,
    action: 'task_completed',
    entityType: 'task',
    entityId: task.id,
    metadata: options.via ? { via: options.via } : null,
    ipAddress: options.ipAddress ?? null
  })

  if (task.is_recurring) {
    await scheduleRecurrence({ ...task, status: 'completed', completed_at: completedAt })
  }
}

export interface MarkNeedsReviewOptions {
  userId?: number | null
  via?: string
  ipAddress?: string | null
}

type NeedsReviewCandidate = Pick<Task, 'id' | 'next_reminder_job_id' | 'never_completes'> & { status: string }

// Moves a task from pending to needs_review and stops its reminders —
// shared by the WhatsApp thumbs-up reaction (whatsapp/taskEngine.ts) and
// the portal's own "flag for review" button (modules/tasks/routes.ts), same
// reasoning as completeTask() above. A standing task (never_completes)
// no-ops here too — a thumbs-up on it would otherwise silently pause its
// reminders exactly like completing it would, defeating the point of it
// never completing.
export async function markNeedsReview(task: NeedsReviewCandidate, options: MarkNeedsReviewOptions = {}): Promise<void> {
  if (task.status !== 'pending' || task.never_completes) return

  await cancelTaskReminder(task.next_reminder_job_id)

  await db
    .updateTable('tasks')
    .set({ status: 'needs_review', next_reminder_job_id: null, next_reminder_at: null, updated_at: new Date() })
    .where('id', '=', task.id)
    .execute()

  await recordAuditLog({
    userId: options.userId ?? null,
    action: 'task_marked_needs_review',
    entityType: 'task',
    entityId: task.id,
    metadata: options.via ? { via: options.via } : null,
    ipAddress: options.ipAddress ?? null
  })
}
