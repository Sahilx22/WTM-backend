import { Router } from 'express'
import { getReportData, type ReportPeriod } from '../../reports/taskMetrics.js'
import { renderTaskReportPdf } from '../../reports/taskReportPdf.js'

export const reportsRouter = Router()

function parsePeriod(raw: unknown): ReportPeriod {
  return raw === 'daily' || raw === 'weekly' || raw === 'monthly' ? raw : 'all'
}

reportsRouter.get('/reports', async (req, res) => {
  const period = parsePeriod(req.query.period)
  const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : ''

  const data = await getReportData(period, recipient)

  res.json({ data, period, recipient })
})

reportsRouter.get('/reports/download', async (req, res) => {
  const period = parsePeriod(req.query.period)
  const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : ''

  const data = await getReportData(period, recipient)
  const pdf = await renderTaskReportPdf(data)

  const filename = `task-report-${period}-${new Date().toISOString().slice(0, 10)}.pdf`
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${filename}"`
  })
  res.send(pdf)
})
