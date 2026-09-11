import type { Job } from 'pg-boss'
import pino from 'pino'
import { boss } from './boss.js'
import { db } from '../db/index.js'
import { getPrimarySocketForOrganization, getPrimarySnapshotForOrganization } from '../whatsapp/connectionManager.js'
import { recipientDisplayName } from '../lib/recipientDisplay.js'
import { WEEKDAY_NUMBERS, cronFromTime } from './autoReports.js'
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

interface DigestJobData {
  organizationId: number
}

async function enqueueDigest(queueName: string, organizationId: number, startAfter: Date): Promise<void> {
  await boss.send(queueName, { organizationId }, { singletonKey: `${queueName}-${organizationId}`, startAfter })
}

// Schedules (or reschedules) the next occurrence of one organization's three
// digest chains, self-rescheduling like task reminders/auto-reports rather
// than a single shared pg-boss cron — every organization has its own
// independent enabled flag/time-of-day. Call this once per organization at
// boot (see queue/lifecycle.ts) and again whenever that organization saves
// new task settings.
export async function applyDigestSchedule(organizationId: number, settings: TaskSettings): Promise<void> {
  if (settings.daily_overview_enabled) {
    const { hour, minute } = cronFromTime(settings.daily_overview_time)
    await enqueueDigest(QUEUE_DAILY_OVERVIEW, organizationId, nextDailyAt(hour, minute, new Date()))
  }
  if (settings.weekly_report_enabled) {
    const { hour, minute } = cronFromTime(settings.weekly_report_time)
    const dayNum = WEEKDAY_NUMBERS[settings.weekly_report_day] ?? 1
    await enqueueDigest(QUEUE_WEEKLY_REPORT, organizationId, nextWeeklyAt(dayNum, hour, minute, new Date()))
  }
  if (settings.review_digest_enabled) {
    const { hour, minute } = cronFromTime(settings.review_digest_time)
    await enqueueDigest(QUEUE_REVIEW_DIGEST, organizationId, nextDailyAt(hour, minute, new Date()))
  }
}

async function sendDailyOverview(organizationId: number): Promise<void> {
  const settings = await db.selectFrom('task_settings').selectAll().where('organization_id', '=', organizationId).executeTakeFirst()
  if (!settings || !settings.daily_overview_enabled) return

  const sock = getPrimarySocketForOrganization(organizationId)
  if (!sock) {
    logger.warn({ organizationId }, 'skipped daily overview — WhatsApp not connected, retrying shortly')
    await enqueueDigest(QUEUE_DAILY_OVERVIEW, organizationId, new Date(Date.now() + 5 * 60_000))
    return
  }

  // Eligibility: anyone with at least one currently-active (not yet
  // completed) task in this organization gets their personal summary.
  const activeRecipients = await db
    .selectFrom('tasks')
    .select('recipient_jid')
    .distinct()
    .where('status', 'in', ['pending', 'needs_review'])
    .where('organization_id', '=', organizationId)
    .execute()

  for (const { recipient_jid } of activeRecipients) {
    try {
      const rows = await db
        .selectFrom('tasks')
        .select(['status'])
        .where('recipient_jid', '=', recipient_jid)
        .where('organization_id', '=', organizationId)
        .execute()
      const completed = rows.filter((r) => r.status === 'completed').length
      const pending = rows.filter((r) => r.status === 'pending').length
      const needsReview = rows.filter((r) => r.status === 'needs_review').length

      const text = `📋 *Your task overview for today*\n✅ Completed: ${completed}\n🕓 Pending: ${pending}\n🔎 In review: ${needsReview}`
      await sock.sendMessage(recipient_jid, { text })
    } catch (err) {
      logger.warn({ err, organizationId, recipient_jid }, 'failed to send daily overview')
    }
  }

  const { hour, minute } = cronFromTime(settings.daily_overview_time)
  await enqueueDigest(QUEUE_DAILY_OVERVIEW, organizationId, nextDailyAt(hour, minute, new Date()))
}

function startOfWeek(date: Date): Date {
  const day = date.getDay() // 0 = Sunday .. 6 = Saturday
  const diffToMonday = (day + 6) % 7
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - diffToMonday)
}

async function sendWeeklyReport(organizationId: number): Promise<void> {
  const settings = await db.selectFrom('task_settings').selectAll().where('organization_id', '=', organizationId).executeTakeFirst()
  if (!settings || !settings.weekly_report_enabled) return

  const sock = getPrimarySocketForOrganization(organizationId)
  if (!sock) {
    logger.warn({ organizationId }, 'skipped weekly report — WhatsApp not connected, retrying shortly')
    await enqueueDigest(QUEUE_WEEKLY_REPORT, organizationId, new Date(Date.now() + 5 * 60_000))
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
    .where('organization_id', '=', organizationId)
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
      logger.warn({ err, organizationId, recipientJid }, 'failed to send weekly report')
    }
  }

  const { hour, minute } = cronFromTime(settings.weekly_report_time)
  const dayNum = WEEKDAY_NUMBERS[settings.weekly_report_day] ?? 1
  await enqueueDigest(QUEUE_WEEKLY_REPORT, organizationId, nextWeeklyAt(dayNum, hour, minute, new Date()))
}

async function sendReviewDigest(organizationId: number): Promise<void> {
  const settings = await db.selectFrom('task_settings').selectAll().where('organization_id', '=', organizationId).executeTakeFirst()
  if (!settings || !settings.review_digest_enabled) return

  const sock = getPrimarySocketForOrganization(organizationId)
  const snapshot = getPrimarySnapshotForOrganization(organizationId)
  if (!sock || !snapshot?.waJid) {
    logger.warn({ organizationId }, 'skipped review digest — WhatsApp not connected, retrying shortly')
    await enqueueDigest(QUEUE_REVIEW_DIGEST, organizationId, new Date(Date.now() + 5 * 60_000))
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
    .where('tasks.organization_id', '=', organizationId)
    .orderBy('tasks.updated_at', 'asc')
    .execute()

  if (rows.length > 0) {
    const lines = rows.map((t) => `#${t.id} *${t.name}* — ${recipientDisplayName(t.recipient_jid, t.contactName, t.groupSubject)}`)
    const text = `🔎 *Today's tasks awaiting review* (${rows.length})\n\n${lines.join('\n')}\n\nUse /complete <id> once you've reviewed one.`

    try {
      await sock.sendMessage(snapshot.waJid, { text })
    } catch (err) {
      logger.warn({ err, organizationId }, 'failed to send review digest')
    }
  }

  const { hour, minute } = cronFromTime(settings.review_digest_time)
  await enqueueDigest(QUEUE_REVIEW_DIGEST, organizationId, nextDailyAt(hour, minute, new Date()))
}

export async function startDigestWorkers(): Promise<void> {
  await boss.work<DigestJobData>(QUEUE_DAILY_OVERVIEW, { batchSize: 1 }, async (jobs: Job<DigestJobData>[]) => {
    for (const job of jobs) await sendDailyOverview(job.data.organizationId)
  })
  await boss.work<DigestJobData>(QUEUE_WEEKLY_REPORT, { batchSize: 1 }, async (jobs: Job<DigestJobData>[]) => {
    for (const job of jobs) await sendWeeklyReport(job.data.organizationId)
  })
  await boss.work<DigestJobData>(QUEUE_REVIEW_DIGEST, { batchSize: 1 }, async (jobs: Job<DigestJobData>[]) => {
    for (const job of jobs) await sendReviewDigest(job.data.organizationId)
  })
}
