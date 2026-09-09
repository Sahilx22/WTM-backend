import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss } from './boss.js'
import { db } from '../db/index.js'
import { getPrimarySocket, getPrimarySnapshot } from '../whatsapp/connectionManager.js'
import { getReportData, type ReportPeriod } from '../reports/taskMetrics.js'
import { renderTaskReportPdf } from '../reports/taskReportPdf.js'
import { loadReportBranding } from '../reports/branding.js'
import { isProduction } from '../config/env.js'
import type { TaskSettings } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

const QUEUE_NAMES: Record<ReportPeriod, string> = {
  daily: 'auto-report-daily',
  weekly: 'auto-report-weekly',
  monthly: 'auto-report-monthly',
  all: 'auto-report-all' // unused for scheduling, kept for type completeness
}

export const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

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

export async function initAutoReportQueues(): Promise<void> {
  await boss.createQueue(QUEUE_NAMES.daily, { retryLimit: 1 })
  await boss.createQueue(QUEUE_NAMES.weekly, { retryLimit: 1 })
  await boss.createQueue(QUEUE_NAMES.monthly, { retryLimit: 1 })
}

// Re-derives the three cron schedules from task_settings — call this at boot
// and again whenever an admin saves new auto-report settings so changes take
// effect immediately without a restart.
export async function applyAutoReportSchedules(settings: TaskSettings): Promise<void> {
  if (settings.auto_report_daily_enabled) {
    const { hour, minute } = cronFromTime(settings.auto_report_daily_time)
    await boss.schedule(QUEUE_NAMES.daily, `${minute} ${hour} * * *`, { period: 'daily' }, { tz: SERVER_TZ })
  } else {
    await boss.unschedule(QUEUE_NAMES.daily)
  }

  if (settings.auto_report_weekly_enabled) {
    const { hour, minute } = cronFromTime(settings.auto_report_weekly_time)
    const dayNum = WEEKDAY_NUMBERS[settings.auto_report_weekly_day] ?? 1
    await boss.schedule(QUEUE_NAMES.weekly, `${minute} ${hour} * * ${dayNum}`, { period: 'weekly' }, { tz: SERVER_TZ })
  } else {
    await boss.unschedule(QUEUE_NAMES.weekly)
  }

  if (settings.auto_report_monthly_enabled) {
    const { hour, minute } = cronFromTime(settings.auto_report_monthly_time)
    const day = Math.min(28, Math.max(1, settings.auto_report_monthly_day))
    await boss.schedule(QUEUE_NAMES.monthly, `${minute} ${hour} ${day} * *`, { period: 'monthly' }, { tz: SERVER_TZ })
  } else {
    await boss.unschedule(QUEUE_NAMES.monthly)
  }
}

interface AutoReportJobData {
  period: ReportPeriod
}

async function sendAutoReport(period: ReportPeriod): Promise<void> {
  // Auto-reports, like reminders, always come from the org's admin
  // (primary) session — never a delegator session.
  const sock = getPrimarySocket()
  const snapshot = getPrimarySnapshot()

  if (!sock || !snapshot?.waJid) {
    logger.warn({ period }, 'skipped auto report — no primary WhatsApp session connected')
    return
  }

  try {
    const [data, branding] = await Promise.all([
      getReportData(period, undefined, undefined, undefined, undefined, snapshot.organizationId),
      loadReportBranding(snapshot.organizationId)
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
    logger.warn({ err, period }, 'failed to send auto report')
  }
}

export async function startAutoReportWorkers(): Promise<void> {
  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    await boss.work<AutoReportJobData>(QUEUE_NAMES[period], { batchSize: 1 }, async (jobs: Job<AutoReportJobData>[]) => {
      for (const job of jobs) {
        await sendAutoReport(job.data.period)
      }
    })
  }
}

export async function loadTaskSettings(): Promise<TaskSettings> {
  return db.selectFrom('task_settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
}
