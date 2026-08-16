import { db } from '../db/index.js'
import { recipientDisplayName } from '../lib/recipientDisplay.js'
import type { TaskStatus } from '../db/schema.js'

export type ReportPeriod = 'daily' | 'weekly' | 'monthly' | 'all'

export interface DateRange {
  from?: Date
  to?: Date
}

export interface EmployeeMetrics {
  recipientJid: string
  employeeName: string
  total: number
  completed: number
  pending: number
  needsReview: number
  onTime: number
  late: number
  completionPercent: number
  avgDaysToComplete: number | null
}

export interface ReportData {
  period: ReportPeriod
  periodLabel: string
  generatedAt: Date
  employees: EmployeeMetrics[]
  overall: {
    total: number
    completed: number
    pending: number
    needsReview: number
    completionPercent: number
  }
}

function periodStart(period: ReportPeriod): Date | null {
  const now = new Date()
  if (period === 'daily') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'weekly') {
    const day = now.getDay() // 0 = Sunday .. 6 = Saturday
    const diffToMonday = (day + 6) % 7
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday)
  }
  if (period === 'monthly') return new Date(now.getFullYear(), now.getMonth(), 1)
  return null
}

function periodLabel(period: ReportPeriod, range?: DateRange): string {
  if (range?.from || range?.to) {
    const fromLabel = range.from ? range.from.toISOString().slice(0, 10) : '…'
    const toLabel = range.to ? range.to.toISOString().slice(0, 10) : '…'
    return `${fromLabel} – ${toLabel}`
  }
  switch (period) {
    case 'daily':
      return 'Today'
    case 'weekly':
      return 'This week (Mon–today)'
    case 'monthly':
      return 'This month'
    default:
      return 'All time'
  }
}

export async function getReportData(
  period: ReportPeriod,
  recipientFilter?: string,
  statusFilter?: TaskStatus,
  dateRange?: DateRange
): Promise<ReportData> {
  let query = db
    .selectFrom('tasks')
    .leftJoin('contacts', 'contacts.id', 'tasks.contact_id')
    .leftJoin('groups', 'groups.wa_jid', 'tasks.recipient_jid')
    .select([
      'tasks.recipient_jid',
      'tasks.status',
      'tasks.target_date',
      'tasks.completed_at',
      'tasks.created_at',
      'contacts.display_name as contactName',
      'groups.subject as groupSubject'
    ])

  // An explicit date range (from a chat command like "/report from ... to
  // ...") always wins over the coarse period bucket — otherwise fall back to
  // the period's own cutoff.
  if (dateRange?.from || dateRange?.to) {
    if (dateRange.from) query = query.where('tasks.created_at', '>=', dateRange.from)
    if (dateRange.to) {
      const exclusiveEnd = new Date(dateRange.to)
      exclusiveEnd.setDate(exclusiveEnd.getDate() + 1)
      query = query.where('tasks.created_at', '<', exclusiveEnd)
    }
  } else {
    const start = periodStart(period)
    if (start) query = query.where('tasks.created_at', '>=', start)
  }

  if (statusFilter) {
    query = query.where('tasks.status', '=', statusFilter)
  }

  if (recipientFilter?.trim()) {
    const like = `%${recipientFilter.trim()}%`
    query = query.where((eb) =>
      eb.or([
        eb('tasks.recipient_jid', 'ilike', like),
        eb('contacts.display_name', 'ilike', like),
        eb('groups.subject', 'ilike', like)
      ])
    )
  }

  const rows = await query.execute()

  const byRecipient = new Map<string, typeof rows>()
  for (const row of rows) {
    const arr = byRecipient.get(row.recipient_jid) ?? []
    arr.push(row)
    byRecipient.set(row.recipient_jid, arr)
  }

  const employees: EmployeeMetrics[] = []
  for (const [jid, taskRows] of byRecipient) {
    const total = taskRows.length
    const completed = taskRows.filter((t) => t.status === 'completed').length
    const pending = taskRows.filter((t) => t.status === 'pending').length
    const needsReview = taskRows.filter((t) => t.status === 'needs_review').length

    const completedWithTarget = taskRows.filter((t) => t.status === 'completed' && t.target_date && t.completed_at)
    const onTime = completedWithTarget.filter(
      (t) => new Date(t.completed_at as Date).getTime() <= new Date(t.target_date as Date).getTime()
    ).length
    const late = completedWithTarget.length - onTime

    const completedDurationsDays = taskRows
      .filter((t) => t.status === 'completed' && t.completed_at)
      .map((t) => (new Date(t.completed_at as Date).getTime() - new Date(t.created_at).getTime()) / 86_400_000)
    const avgDaysToComplete =
      completedDurationsDays.length > 0
        ? Math.round((completedDurationsDays.reduce((a, b) => a + b, 0) / completedDurationsDays.length) * 10) / 10
        : null

    employees.push({
      recipientJid: jid,
      employeeName: recipientDisplayName(jid, taskRows[0]?.contactName, taskRows[0]?.groupSubject),
      total,
      completed,
      pending,
      needsReview,
      onTime,
      late,
      completionPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
      avgDaysToComplete
    })
  }

  employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName))

  const overallTotal = rows.length
  const overallCompleted = rows.filter((r) => r.status === 'completed').length
  const overallPending = rows.filter((r) => r.status === 'pending').length
  const overallNeedsReview = rows.filter((r) => r.status === 'needs_review').length

  return {
    period,
    periodLabel: periodLabel(period, dateRange),
    generatedAt: new Date(),
    employees,
    overall: {
      total: overallTotal,
      completed: overallCompleted,
      pending: overallPending,
      needsReview: overallNeedsReview,
      completionPercent: overallTotal > 0 ? Math.round((overallCompleted / overallTotal) * 100) : 0
    }
  }
}
