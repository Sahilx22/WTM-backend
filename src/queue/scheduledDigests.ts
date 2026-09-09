import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss } from './boss.js'
import { db } from '../db/index.js'
import { getPrimarySocket, getPrimarySnapshot } from '../whatsapp/connectionManager.js'
import { recipientDisplayName } from '../lib/recipientDisplay.js'
import { SERVER_TZ, WEEKDAY_NUMBERS, cronFromTime } from './autoReports.js'
import { isProduction } from '../config/env.js'
import type { TaskSettings } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

const QUEUE_DAILY_OVERVIEW = 'daily-overview'
const QUEUE_WEEKLY_REPORT = 'weekly-report'
const QUEUE_REVIEW_DIGEST = 'review-digest'

export async function initDigestQueues(): Promise<void> {
  await boss.createQueue(QUEUE_DAILY_OVERVIEW, { retryLimit: 1 })
  await boss.createQueue(QUEUE_WEEKLY_REPORT, { retryLimit: 1 })
  await boss.createQueue(QUEUE_REVIEW_DIGEST, { retryLimit: 1 })
}

// Re-derives the three cron schedules from task_settings — call at boot and
// again whenever an admin saves new task settings, mirroring
// applyAutoReportSchedules.
export async function applyDigestSchedules(settings: TaskSettings): Promise<void> {
  if (settings.daily_overview_enabled) {
    const { hour, minute } = cronFromTime(settings.daily_overview_time)
    await boss.schedule(QUEUE_DAILY_OVERVIEW, `${minute} ${hour} * * *`, {}, { tz: SERVER_TZ })
  } else {
    await boss.unschedule(QUEUE_DAILY_OVERVIEW)
  }

  if (settings.weekly_report_enabled) {
    const { hour, minute } = cronFromTime(settings.weekly_report_time)
    const dayNum = WEEKDAY_NUMBERS[settings.weekly_report_day] ?? 1
    await boss.schedule(QUEUE_WEEKLY_REPORT, `${minute} ${hour} * * ${dayNum}`, {}, { tz: SERVER_TZ })
  } else {
    await boss.unschedule(QUEUE_WEEKLY_REPORT)
  }

  if (settings.review_digest_enabled) {
    const { hour, minute } = cronFromTime(settings.review_digest_time)
    await boss.schedule(QUEUE_REVIEW_DIGEST, `${minute} ${hour} * * *`, {}, { tz: SERVER_TZ })
  } else {
    await boss.unschedule(QUEUE_REVIEW_DIGEST)
  }
}

async function sendDailyOverview(): Promise<void> {
  const sock = getPrimarySocket()
  if (!sock) {
    logger.warn('skipped daily overview — WhatsApp not connected')
    return
  }

  // Eligibility: anyone with at least one currently-active (not yet
  // completed) task gets their personal summary.
  const activeRecipients = await db
    .selectFrom('tasks')
    .select('recipient_jid')
    .distinct()
    .where('status', 'in', ['pending', 'needs_review'])
    .execute()

  for (const { recipient_jid } of activeRecipients) {
    try {
      const rows = await db.selectFrom('tasks').select(['status']).where('recipient_jid', '=', recipient_jid).execute()
      const completed = rows.filter((r) => r.status === 'completed').length
      const pending = rows.filter((r) => r.status === 'pending').length
      const needsReview = rows.filter((r) => r.status === 'needs_review').length

      const text = `📋 *Your task overview for today*\n✅ Completed: ${completed}\n🕓 Pending: ${pending}\n🔎 In review: ${needsReview}`
      await sock.sendMessage(recipient_jid, { text })
    } catch (err) {
      logger.warn({ err, recipient_jid }, 'failed to send daily overview')
    }
  }
}

function startOfWeek(date: Date): Date {
  const day = date.getDay() // 0 = Sunday .. 6 = Saturday
  const diffToMonday = (day + 6) % 7
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - diffToMonday)
}

async function sendWeeklyReport(): Promise<void> {
  const sock = getPrimarySocket()
  if (!sock) {
    logger.warn('skipped weekly report — WhatsApp not connected')
    return
  }

  const thisWeekStart = startOfWeek(new Date())
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  const rows = await db
    .selectFrom('tasks')
    .select(['recipient_jid', 'status'])
    .where('created_at', '>=', lastWeekStart)
    .where('created_at', '<', thisWeekStart)
    .where('status', 'in', ['pending', 'needs_review', 'completed'])
    .execute()

  const byRecipient = new Map<string, typeof rows>()
  for (const row of rows) {
    const arr = byRecipient.get(row.recipient_jid) ?? []
    arr.push(row)
    byRecipient.set(row.recipient_jid, arr)
  }

  for (const [recipientJid, taskRows] of byRecipient) {
    try {
      const completed = taskRows.filter((r) => r.status === 'completed').length
      const pending = taskRows.filter((r) => r.status === 'pending').length
      const needsReview = taskRows.filter((r) => r.status === 'needs_review').length

      const text = `🗓️ *Your weekly task report*\n✅ Completed: ${completed}\n🕓 Pending: ${pending}\n🔎 In review: ${needsReview}`
      await sock.sendMessage(recipientJid, { text })
    } catch (err) {
      logger.warn({ err, recipientJid }, 'failed to send weekly report')
    }
  }
}

async function sendReviewDigest(): Promise<void> {
  const sock = getPrimarySocket()
  const snapshot = getPrimarySnapshot()
  if (!sock || !snapshot?.waJid) {
    logger.warn('skipped review digest — WhatsApp not connected')
    return
  }

  const rows = await db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select([
      'tasks.id',
      'tasks.name',
      'tasks.recipient_jid',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject'
    ])
    .where('tasks.status', '=', 'needs_review')
    .orderBy('tasks.updated_at', 'asc')
    .execute()

  if (rows.length === 0) return

  const lines = rows.map((t) => `#${t.id} *${t.name}* — ${recipientDisplayName(t.recipient_jid, t.contactName, t.groupSubject)}`)
  const text = `🔎 *Today's tasks awaiting review* (${rows.length})\n\n${lines.join('\n')}\n\nUse /complete <id> once you've reviewed one.`

  try {
    await sock.sendMessage(snapshot.waJid, { text })
  } catch (err) {
    logger.warn({ err }, 'failed to send review digest')
  }
}

export async function startDigestWorkers(): Promise<void> {
  await boss.work(QUEUE_DAILY_OVERVIEW, { batchSize: 1 }, async (jobs: Job[]) => {
    for (const _job of jobs) await sendDailyOverview()
  })
  await boss.work(QUEUE_WEEKLY_REPORT, { batchSize: 1 }, async (jobs: Job[]) => {
    for (const _job of jobs) await sendWeeklyReport()
  })
  await boss.work(QUEUE_REVIEW_DIGEST, { batchSize: 1 }, async (jobs: Job[]) => {
    for (const _job of jobs) await sendReviewDigest()
  })
}
