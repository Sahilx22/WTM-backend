import { Router } from 'express'
import { getReportData, type ReportPeriod } from '../../reports/taskMetrics.js'
import { renderTaskReportPdf } from '../../reports/taskReportPdf.js'
import { loadReportBranding } from '../../reports/branding.js'

export const reportsRouter = Router()

function parsePeriod(raw: unknown): ReportPeriod {
  return raw === 'daily' || raw === 'weekly' || raw === 'monthly' ? raw : 'all'
}

reportsRouter.get('/reports', async (req, res) => {
  const period = parsePeriod(req.query.period)
  const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : ''

  // Regular org users only ever see their own organization's tasks; the
  // super admin (no organization) gets the unscoped, cross-org view.
  const data = await getReportData(period, recipient, undefined, undefined, undefined, req.user?.organizationId ?? undefined)

  res.json({ data, period, recipient })
})

reportsRouter.get('/reports/download', async (req, res) => {
  const period = parsePeriod(req.query.period)
  const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : ''

  const [data, branding] = await Promise.all([
    getReportData(period, recipient, undefined, undefined, undefined, req.user?.organizationId ?? undefined),
    loadReportBranding(req.user?.organizationId ?? undefined)
  ])
  const pdf = await renderTaskReportPdf(data, branding)

  const filename = `task-report-${period}-${new Date().toISOString().slice(0, 10)}.pdf`
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${filename}"`
  })
  res.send(pdf)
})
