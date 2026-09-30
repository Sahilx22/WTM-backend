import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss, isBossStarted } from './boss.js'
import { db } from '../db/index.js'
import { getPrimarySocketForOrganization, getConnectedSocketForSession } from '../whatsapp/connectionManager.js'
import { nextIntervalDaysTime } from './taskReminders.js'
import { isProduction } from '../config/env.js'
import type { ReportDefinition } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

export const QUEUE_REPORT_CHECK = 'report-check'

export async function initReportCheckQueue(): Promise<void> {
  await boss.createQueue(QUEUE_REPORT_CHECK, { retryLimit: 0, expireInSeconds: 300 })
}

interface ReportCheckJobData {
  submissionId: number
  // 'due' fires at the report's own due time: if not yet submitted, send
  // one reminder and queue the 'missed' check for end of that same day.
  // 'missed' fires at day-end: if still not submitted, the occurrence is
  // resolved as missed and the next one is scheduled.
  stage: 'due' | 'missed'
}

function parseTimeStr(timeStr: string, fallbackHour: number, fallbackMinute: number): { hour: number; minute: number } {
  const [hourRaw, minuteRaw] = timeStr.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  return { hour: Number.isFinite(hour) ? hour : fallbackHour, minute: Number.isFinite(minute) ? minute : fallbackMinute }
}

// Next occurrence of `dayOfWeek` (0=Sunday..6=Saturday) at `timeStr`, today
// if it's that day and still ahead, otherwise the next matching weekday —
// same "anchor to a fixed wall-clock time" idea as tasks' nextDailyAnchorTime.
export function nextWeeklyOccurrence(dayOfWeek: number, timeStr: string, from: Date = new Date()): Date {
  const { hour, minute } = parseTimeStr(timeStr, 9, 30)
  const next = new Date(from)
  next.setHours(hour, minute, 0, 0)
  let daysUntil = (dayOfWeek - from.getDay() + 7) % 7
  if (daysUntil === 0 && next.getTime() <= from.getTime()) daysUntil = 7
  next.setDate(next.getDate() + daysUntil)
  return next
}

// 23:59:59 local time on the same calendar day as `dueAt` — the deadline
// after which a still-unsubmitted occurrence counts as missed.
function endOfDueDay(dueAt: Date): Date {
  const end = new Date(dueAt)
  end.setHours(23, 59, 59, 999)
  return end
}

export async function enqueueReportCheck(data: ReportCheckJobData, startAfter: number | string | Date): Promise<string | null> {
  return boss.send(QUEUE_REPORT_CHECK, data, { startAfter })
}

// Creates the next occurrence (a fresh pending report_submissions row) for
// a definition and queues its 'due' check — called when a definition is
// created/re-enabled, and every time the current occurrence resolves
// (submitted or missed). No-ops if the definition is disabled, or the
// queue is currently stopped (no WhatsApp session connected anywhere —
// see queue/lifecycle.ts); scheduleUnscheduledReportOccurrences() below
// picks up any definition left without one the moment the queue restarts.
export async function scheduleNextReportOccurrence(definitionId: number): Promise<void> {
  if (!isBossStarted()) return

  const def = await db.selectFrom('report_definitions').selectAll().where('id', '=', definitionId).executeTakeFirst()
  if (!def || !def.enabled) return

  const dueAt =
    def.schedule_type === 'weekly'
      ? nextWeeklyOccurrence(def.day_of_week ?? 1, def.due_time)
      : nextIntervalDaysTime(def.interval_days ?? 1, def.due_time)

  const submission = await db
    .insertInto('report_submissions')
    .values({ report_definition_id: definitionId, organization_id: def.organization_id, due_at: dueAt })
    .returning('id')
    .executeTakeFirstOrThrow()

  const jobId = await enqueueReportCheck({ submissionId: submission.id, stage: 'due' }, dueAt)
  await db.updateTable('report_definitions').set({ next_due_at: dueAt, next_due_job_id: jobId }).where('id', '=', definitionId).execute()
}

// Called once each time the queue starts: any enabled definition with no
// open (pending) occurrence gets one — e.g. one just created or
// re-enabled while the queue was stopped. A definition that already has a
// pending occurrence is left alone.
export async function scheduleUnscheduledReportOccurrences(): Promise<void> {
  const definitions = await db.selectFrom('report_definitions').select('id').where('enabled', '=', true).execute()
  for (const { id } of definitions) {
    const open = await db
      .selectFrom('report_submissions')
      .select('id')
      .where('report_definition_id', '=', id)
      .where('status', '=', 'pending')
      .executeTakeFirst()
    if (!open) await scheduleNextReportOccurrence(id)
  }
}

function resolveSock(def: Pick<ReportDefinition, 'organization_id' | 'whatsapp_session_id'>) {
  if (def.organization_id === null) return null
  return def.whatsapp_session_id !== null
    ? getConnectedSocketForSession(def.whatsapp_session_id, def.organization_id)
    : getPrimarySocketForOrganization(def.organization_id)
}

async function processReportCheck(data: ReportCheckJobData): Promise<void> {
  const submission = await db.selectFrom('report_submissions').selectAll().where('id', '=', data.submissionId).executeTakeFirst()
  if (!submission || submission.status !== 'pending') return // already submitted (or already resolved) — nothing to do

  const def = await db.selectFrom('report_definitions').selectAll().where('id', '=', submission.report_definition_id).executeTakeFirst()
  if (!def || !def.enabled) return

  if (data.stage === 'due') {
    const sock = resolveSock(def)
    if (sock) {
      try {
        await sock.sendMessage(def.recipient_jid, {
          text: `📋 Reminder: your *${def.name}* report is due today${def.description ? `\n${def.description}` : ''}. Reply with "#report ${def.name}" (attach a file if needed) to submit it.`
        })
      } catch (err) {
        logger.warn({ err, submissionId: submission.id }, 'failed to send report-due reminder')
      }
    } else {
      logger.warn({ submissionId: submission.id }, 'skipped report-due reminder — WhatsApp not connected')
    }

    await db.updateTable('report_submissions').set({ reminder_sent_at: new Date() }).where('id', '=', submission.id).execute()
    await enqueueReportCheck({ submissionId: submission.id, stage: 'missed' }, endOfDueDay(submission.due_at))
    return
  }

  // stage === 'missed': the due day has ended and it's still unsubmitted.
  await db.updateTable('report_submissions').set({ status: 'missed' }).where('id', '=', submission.id).execute()
  await scheduleNextReportOccurrence(def.id)
}

export async function startReportCheckWorker(): Promise<void> {
  await boss.work<ReportCheckJobData>(QUEUE_REPORT_CHECK, { batchSize: 1, pollingIntervalSeconds: 5 }, async (jobs: Job<ReportCheckJobData>[]) => {
    for (const job of jobs) {
      await processReportCheck(job.data)
    }
  })
}
