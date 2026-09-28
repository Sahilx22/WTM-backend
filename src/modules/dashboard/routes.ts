import { Router } from 'express'
import { sql } from 'kysely'
import { db } from '../../db/index.js'
import { listSessionsForOrganization, maskPhoneNumber } from '../../whatsapp/connectionManager.js'
import { getRateLimitConfig } from '../../queue/rateLimiter.js'
import { recipientDisplayName } from '../../lib/recipientDisplay.js'
import { formatIsoDate } from '../../lib/dateFormat.js'

export const dashboardRouter = Router()

const DEFAULT_RATE_LIMIT_CONFIG = {
  max_per_minute: 10,
  max_per_hour: 200,
  min_delay_ms: 3000,
  max_delay_ms: 8000,
  concurrency: 1,
  pause_after_consecutive_failures: 5,
  is_paused: false
}

dashboardRouter.get('/dashboard', async (req, res) => {
  const organizationId = req.user?.organizationId ?? undefined
  // date_trunc('day', now()) alone truncates using the DATABASE session's
  // own timezone (Postgres defaults to UTC, independent of whatever TZ the
  // app server runs as) — "today" would silently mean the UTC calendar day,
  // not the IST one this app is built around. The double AT TIME ZONE
  // conversion below is the standard Postgres idiom for a timezone-safe
  // truncation: convert to a naive IST wall-clock value, truncate that, then
  // convert back to a real instant — correct regardless of the session's
  // configured timezone.
  const todayStart = sql<Date>`date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`

  // One aggregate query covers every messages-table stat the dashboard needs
  // (today's counts, the pending queue depth, and the rolling send-rate
  // windows) instead of six separate round trips — each FILTER clause scans
  // the same result set Postgres already has to read once. Every query here
  // is scoped to the caller's own organization; the super admin (no
  // organization) gets the unscoped, cross-org view, same convention as
  // tasks/contacts.
  let messageStatsQuery = db.selectFrom('messages')
  let totalContactsQuery = db.selectFrom('contacts')
  let activeBatchesQuery = db.selectFrom('campaigns').where('status', 'in', ['scheduled', 'sending'])
  let recentActivityQuery = db.selectFrom('messages').leftJoin('campaigns', 'campaigns.id', 'messages.campaign_id')
  let lastSentQuery = db.selectFrom('messages').where('sent_at', 'is not', null)

  if (organizationId !== undefined) {
    messageStatsQuery = messageStatsQuery.where('organization_id', '=', organizationId)
    totalContactsQuery = totalContactsQuery.where('organization_id', '=', organizationId)
    activeBatchesQuery = activeBatchesQuery.where('organization_id', '=', organizationId)
    recentActivityQuery = recentActivityQuery.where('messages.organization_id', '=', organizationId)
    lastSentQuery = lastSentQuery.where('organization_id', '=', organizationId)
  }

  const [messageStats, totalContacts, activeBatches, recentActivity, lastSent, rateLimitConfig] = await Promise.all([
    messageStatsQuery
      .select((eb) => [
        eb.fn.count<number>('id').filterWhere('sent_at', '>=', todayStart).as('sentToday'),
        eb.fn
          .count<number>('id')
          .filterWhere((fb) => fb.and([fb('status', 'in', ['delivered', 'read']), fb('sent_at', '>=', todayStart)]))
          .as('deliveredToday'),
        eb.fn
          .count<number>('id')
          .filterWhere((fb) => fb.and([fb('status', '=', 'failed'), fb('updated_at', '>=', todayStart)]))
          .as('failedToday'),
        eb.fn.count<number>('id').filterWhere('status', 'in', ['scheduled', 'queued', 'sending']).as('pending'),
        eb.fn
          .count<number>('id')
          .filterWhere('sent_at', '>=', sql<Date>`now() - interval '60 seconds'`)
          .as('perMinute'),
        eb.fn
          .count<number>('id')
          .filterWhere('sent_at', '>=', sql<Date>`now() - interval '1 hour'`)
          .as('perHour')
      ])
      .executeTakeFirstOrThrow(),
    totalContactsQuery.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
    activeBatchesQuery.select((eb) => eb.fn.count<number>('batch_id').distinct().as('count')).executeTakeFirstOrThrow(),
    recentActivityQuery
      .select([
        'messages.id',
        'messages.recipient_jid',
        'messages.message_type',
        'messages.status',
        'messages.updated_at',
        'campaigns.name as campaignName'
      ])
      .orderBy('messages.updated_at', 'desc')
      .limit(10)
      .execute(),
    lastSentQuery
      .select(['recipient_jid', 'status', 'sent_at'])
      .orderBy('sent_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst(),
    organizationId !== undefined ? getRateLimitConfig(organizationId) : Promise.resolve(DEFAULT_RATE_LIMIT_CONFIG)
  ])

  // The dashboard's connection tile shows this org's primary session (the
  // one reminders/auto-reports go through) — falling back to whichever
  // session exists if none is primary yet, or a disconnected placeholder if
  // this org has no organization (e.g. the super admin) or no sessions at all.
  const sessions = req.user?.organizationId ? await listSessionsForOrganization(req.user.organizationId) : []
  const primary = sessions.find((s) => s.isPrimary) ?? sessions[0] ?? null
  const connection = primary
    ? { status: primary.status, qrDataUrl: primary.qrDataUrl, phoneNumber: primary.phoneNumber, waJid: primary.waJid, lastDisconnectReason: primary.lastDisconnectReason }
    : { status: 'disconnected' as const, qrDataUrl: null, phoneNumber: null, waJid: null, lastDisconnectReason: null }

  res.json({
    stats: {
      sentToday: Number(messageStats.sentToday),
      deliveredToday: Number(messageStats.deliveredToday),
      failedToday: Number(messageStats.failedToday),
      pending: Number(messageStats.pending),
      totalContacts: Number(totalContacts.count),
      activeBatches: Number(activeBatches.count)
    },
    recentActivity,
    lastSent,
    connection: { ...connection, maskedPhoneNumber: maskPhoneNumber(connection.phoneNumber) },
    sessionCount: sessions.length,
    rateLimitConfig,
    rollingCounts: { perMinute: Number(messageStats.perMinute), perHour: Number(messageStats.perHour) }
  })
})

const MAX_ANALYTICS_RANGE_DAYS = 366
const MAX_EMPLOYEE_BARS = 15

function parseAnalyticsDate(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw) return fallback
  const d = new Date(`${raw}T00:00:00`)
  return Number.isNaN(d.getTime()) ? fallback : d
}

// Task analytics for the dashboard's charts: a "cohort" of tasks assigned
// (created) within [from, to] — every number here (the status breakdown,
// the per-employee comparison, and the daily "assigned" line) describes
// that same cohort, so the whole panel tells one consistent story: "of what
// was assigned in this window, here's where it stands today." The daily
// "completed" line plots each cohort task's actual completion day, which
// can be blank near the right edge of the range for tasks that haven't
// finished yet — that's expected, not a bug.
dashboardRouter.get('/dashboard/task-analytics', async (req, res) => {
  const organizationId = req.user?.organizationId ?? undefined
  const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : ''

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const defaultFrom = new Date(today)
  defaultFrom.setDate(defaultFrom.getDate() - 29) // last 30 days, inclusive of today

  let from = parseAnalyticsDate(req.query.from, defaultFrom)
  let to = parseAnalyticsDate(req.query.to, today)
  if (from.getTime() > to.getTime()) [from, to] = [to, from]
  const maxSpanMs = MAX_ANALYTICS_RANGE_DAYS * 24 * 60 * 60 * 1000
  if (to.getTime() - from.getTime() > maxSpanMs) from = new Date(to.getTime() - maxSpanMs)
  // Inclusive of the whole "to" day.
  const toExclusive = new Date(to)
  toExclusive.setDate(toExclusive.getDate() + 1)

  // Qualified with the table prefix throughout (even before any join
  // exists) so this base query stays valid once byEmployee below joins in
  // contacts/groups — both of which also have their own created_at column.
  let cohort = db.selectFrom('tasks').where('tasks.created_at', '>=', from).where('tasks.created_at', '<', toExclusive)
  if (organizationId !== undefined) cohort = cohort.where('tasks.organization_id', '=', organizationId)
  if (recipient) cohort = cohort.where('tasks.recipient_jid', '=', recipient)

  const [summaryRow, dailyRows, employeeRows] = await Promise.all([
    cohort
      .select((eb) => [
        eb.fn.countAll<number>().as('total'),
        eb.fn.count<number>('id').filterWhere('status', '=', 'completed').as('completed'),
        eb.fn.count<number>('id').filterWhere('status', '=', 'pending').as('pending'),
        eb.fn.count<number>('id').filterWhere('status', '=', 'needs_review').as('needsReview')
      ])
      .executeTakeFirstOrThrow(),

    // Zero-filled per-day series across the whole range, from a generated
    // calendar rather than only the days that happen to have rows — so a
    // quiet day shows as 0 on the chart instead of a gap. Every day
    // boundary here uses the same "convert to naive IST wall-clock, do the
    // date math, convert back" idiom as todayStart above — generate_series'
    // bounds, each subquery's bucketing, and the final to_char label would
    // otherwise all be computed in the database session's own timezone
    // (Postgres defaults to UTC), silently mislabeling which calendar day
    // (IST) a task actually belongs to.
    sql<{ date: string; assigned: string; completed: string }>`
      select
        to_char(gs.day AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') as date,
        coalesce(a.assigned, 0) as assigned,
        coalesce(c.completed, 0) as completed
      from generate_series(
        date_trunc('day', ${from}::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata',
        date_trunc('day', ${to}::timestamptz AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata',
        interval '1 day'
      ) as gs(day)
      left join (
        select date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' as day, count(*) as assigned
        from tasks
        where created_at >= ${from} and created_at < ${toExclusive}
          ${organizationId !== undefined ? sql`and organization_id = ${organizationId}` : sql``}
          ${recipient ? sql`and recipient_jid = ${recipient}` : sql``}
        group by 1
      ) a on a.day = gs.day
      left join (
        select date_trunc('day', completed_at AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' as day, count(*) as completed
        from tasks
        where created_at >= ${from} and created_at < ${toExclusive} and completed_at is not null
          ${organizationId !== undefined ? sql`and organization_id = ${organizationId}` : sql``}
          ${recipient ? sql`and recipient_jid = ${recipient}` : sql``}
        group by 1
      ) c on c.day = gs.day
      order by gs.day
    `.execute(db),

    cohort
      .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
      .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
      .select((eb) => [
        'tasks.recipient_jid',
        'contacts.display_name as contactName',
        'groups.subject as groupSubject',
        eb.fn.countAll<number>().as('total'),
        eb.fn.count<number>('tasks.id').filterWhere('tasks.status', '=', 'completed').as('completed'),
        eb.fn.count<number>('tasks.id').filterWhere('tasks.status', '=', 'pending').as('pending'),
        eb.fn.count<number>('tasks.id').filterWhere('tasks.status', '=', 'needs_review').as('needsReview')
      ])
      .groupBy(['tasks.recipient_jid', 'contacts.display_name', 'groups.subject'])
      .orderBy('total', 'desc')
      .execute()
  ])

  const total = Number(summaryRow.total)
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0)
  const completed = Number(summaryRow.completed)
  const pending = Number(summaryRow.pending)
  const needsReview = Number(summaryRow.needsReview)

  const byEmployee = employeeRows.slice(0, MAX_EMPLOYEE_BARS).map((r) => ({
    jid: r.recipient_jid,
    name: recipientDisplayName(r.recipient_jid, r.contactName, r.groupSubject),
    total: Number(r.total),
    completed: Number(r.completed),
    pending: Number(r.pending),
    needsReview: Number(r.needsReview)
  }))

  res.json({
    range: { from: formatIsoDate(from), to: formatIsoDate(to) },
    summary: { total, completed, pending, needsReview, completedPct: pct(completed), pendingPct: pct(pending), needsReviewPct: pct(needsReview) },
    daily: dailyRows.rows.map((r) => ({ date: r.date, assigned: Number(r.assigned), completed: Number(r.completed) })),
    byEmployee,
    employeeCount: employeeRows.length,
    truncatedEmployees: employeeRows.length > MAX_EMPLOYEE_BARS
  })
})
