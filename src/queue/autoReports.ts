import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss } from './boss.js'
import { db } from '../db/index.js'
import { getPrimarySocketForOrganization, getPrimarySnapshotForOrganization } from '../whatsapp/connectionManager.js'
import { getReportData } from '../reports/taskMetrics.js'
import { renderTaskReportPdf } from '../reports/taskReportPdf.js'
import { loadReportBranding } from '../reports/branding.js'
import { isProduction } from '../config/env.js'
import type { TaskSettings } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

export type AutoReportPeriod = 'daily' | 'weekly' | 'monthly'

const QUEUE_NAMES: Record<AutoReportPeriod, string> = {
  daily: 'auto-report-daily',
  weekly: 'auto-report-weekly',
  monthly: 'auto-report-monthly'
}

export const WEEKDAY_NUMBERS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
}

export function cronFromTime(time: string): { minute: number; hour: number } {
  const [hourRaw, minuteRaw] = time.split(':')
  const hour = Number(hourRaw)
  const minute = Number(minuteRaw)
  return {
    hour: Number.isFinite(hour) ? hour : 9,
    minute: Number.isFinite(minute) ? minute : 0
  }
}

function nextDailyAt(hour: number, minute: number, from: Date): Date {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, minute, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next
}

function nextWeeklyAt(dayNum: number, hour: number, minute: number, from: Date): Date {
  const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, minute, 0, 0)
  const diff = (dayNum - from.getDay() + 7) % 7
  next.setDate(next.getDate() + diff)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 7)
  return next
}

function nextMonthlyAt(day: number, hour: number, minute: number, from: Date): Date {
  let next = new Date(from.getFullYear(), from.getMonth(), day, hour, minute, 0, 0)
  if (next.getTime() <= from.getTime()) next = new Date(from.getFullYear(), from.getMonth() + 1, day, hour, minute, 0, 0)
  return next
}

function isEnabled(period: AutoReportPeriod, settings: TaskSettings): boolean {
  if (period === 'daily') return settings.auto_report_daily_enabled
  if (period === 'weekly') return settings.auto_report_weekly_enabled
  return settings.auto_report_monthly_enabled
}

function nextFireTime(period: AutoReportPeriod, settings: TaskSettings, from: Date = new Date()): Date {
  if (period === 'daily') {
    const { hour, minute } = cronFromTime(settings.auto_report_daily_time)
    return nextDailyAt(hour, minute, from)
  }
  if (period === 'weekly') {
    const { hour, minute } = cronFromTime(settings.auto_report_weekly_time)
    const dayNum = WEEKDAY_NUMBERS[settings.auto_report_weekly_day] ?? 1
    return nextWeeklyAt(dayNum, hour, minute, from)
  }
  const { hour, minute } = cronFromTime(settings.auto_report_monthly_time)
  const day = Math.min(28, Math.max(1, settings.auto_report_monthly_day))
  return nextMonthlyAt(day, hour, minute, from)
}

export async function initAutoReportQueues(): Promise<void> {
  await boss.createQueue(QUEUE_NAMES.daily, { retryLimit: 1 })
  await boss.createQueue(QUEUE_NAMES.weekly, { retryLimit: 1 })
  await boss.createQueue(QUEUE_NAMES.monthly, { retryLimit: 1 })
}

interface AutoReportJobData {
  organizationId: number
  period: AutoReportPeriod
}

async function enqueueAutoReport(organizationId: number, period: AutoReportPeriod, startAfter: Date): Promise<void> {
  await boss.send(
    QUEUE_NAMES[period],
    { organizationId, period },
    { singletonKey: `${QUEUE_NAMES[period]}-${organizationId}`, startAfter }
  )
}

// Schedules (or reschedules) the next occurrence of one organization's three
// auto-report chains, self-rescheduling like task reminders/recurring tasks
// rather than a single shared pg-boss cron — every organization has its own
// independent enabled flag/time-of-day, so a shared cron trigger couldn't
// represent them all at once. Call this once per organization at boot (see
// queue/lifecycle.ts) and again whenever that organization saves new task
// settings.
export async function applyAutoReportSchedule(organizationId: number, settings: TaskSettings): Promise<void> {
  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    if (!isEnabled(period, settings)) continue
    await enqueueAutoReport(organizationId, period, nextFireTime(period, settings))
  }
}

async function sendAutoReport(organizationId: number, period: AutoReportPeriod): Promise<void> {
  // Re-read settings fresh at fire time rather than trusting whatever was
  // true when this job was enqueued — if the org disabled this report (or
  // the org no longer exists) since then, this is where that takes effect.
  const settings = await db.selectFrom('task_settings').selectAll().where('organization_id', '=', organizationId).executeTakeFirst()
  if (!settings || !isEnabled(period, settings)) return

  // Auto-reports, like reminders, always come from this org's own admin
  // (primary) session — never a delegator session, and never a different
  // organization's session.
  const sock = getPrimarySocketForOrganization(organizationId)
  const snapshot = getPrimarySnapshotForOrganization(organizationId)

  if (!sock || !snapshot?.waJid) {
    logger.warn({ organizationId, period }, 'skipped auto report — no primary WhatsApp session connected, retrying shortly')
    await enqueueAutoReport(organizationId, period, new Date(Date.now() + 5 * 60_000))
    return
  }

  try {
    const [data, branding] = await Promise.all([
      getReportData(period, undefined, undefined, undefined, undefined, organizationId),
      loadReportBranding(organizationId)
    ])
    const pdf = await renderTaskReportPdf(data, branding)
    const filename = `task-report-${period}-${new Date().toISOString().slice(0, 10)}.pdf`

    await sock.sendMessage(snapshot.waJid, {
      document: pdf,
      mimetype: 'application/pdf',
      fileName: filename,
      caption: `Auto report — ${data.periodLabel} — ${data.overall.total} task(s), ${data.overall.completionPercent}% completed`
    })
  } catch (err) {
    logger.warn({ err, organizationId, period }, 'failed to send auto report')
  }

  await enqueueAutoReport(organizationId, period, nextFireTime(period, settings))
}

export async function startAutoReportWorkers(): Promise<void> {
  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    await boss.work<AutoReportJobData>(QUEUE_NAMES[period], { batchSize: 1 }, async (jobs: Job<AutoReportJobData>[]) => {
      for (const job of jobs) {
        await sendAutoReport(job.data.organizationId, job.data.period)
      }
    })
  }
}

export async function loadTaskSettingsForOrganization(organizationId: number): Promise<TaskSettings> {
  return db.selectFrom('task_settings').selectAll().where('organization_id', '=', organizationId).executeTakeFirstOrThrow()
}

// Every organization's own settings row — used at boot to (re)start every
// organization's auto-report/digest chains, not just one.
export async function listAllTaskSettings(): Promise<TaskSettings[]> {
  return db.selectFrom('task_settings').selectAll().execute()
}
