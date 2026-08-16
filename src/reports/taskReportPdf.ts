import PDFDocument from 'pdfkit'
import type { ReportData } from './taskMetrics.js'

const COLUMNS = [
  { label: 'Employee', width: 170 },
  { label: 'Total', width: 55 },
  { label: 'Done', width: 55 },
  { label: 'Done %', width: 60 },
  { label: 'On time', width: 60 },
  { label: 'Late', width: 50 },
  { label: 'Pending', width: 60 },
  { label: 'In review', width: 65 },
  { label: 'Avg days', width: 65 }
] as const

export function renderTaskReportPdf(data: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' })
    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(18).fillColor('#2B2620').text('WhatsApp Task Report')
    doc
      .fontSize(10)
      .fillColor('#746A5D')
      .text(`${data.periodLabel} — generated ${data.generatedAt.toLocaleString()}`)
    doc.moveDown(1)

    doc.fontSize(12).fillColor('#2B2620').text('Overall summary')
    doc
      .fontSize(10)
      .fillColor('#2B2620')
      .text(
        `Total tasks: ${data.overall.total}    Completed: ${data.overall.completed} (${data.overall.completionPercent}%)    Pending: ${data.overall.pending}    Needs review: ${data.overall.needsReview}`
      )
    doc.moveDown(1.2)

    doc.fontSize(12).fillColor('#2B2620').text('By employee')
    doc.moveDown(0.4)

    const startX = doc.page.margins.left
    const tableWidth = COLUMNS.reduce((sum, c) => sum + c.width, 0)
    let y = doc.y

    function drawHeader() {
      let x = startX
      doc.fontSize(9).fillColor('#746A5D')
      for (const col of COLUMNS) {
        doc.text(col.label, x, y, { width: col.width })
        x += col.width
      }
      y += 16
      doc
        .moveTo(startX, y)
        .lineTo(startX + tableWidth, y)
        .strokeColor('#E7E0D6')
        .stroke()
      y += 6
    }

    drawHeader()
    doc.fontSize(9).fillColor('#2B2620')

    for (const emp of data.employees) {
      if (y > doc.page.height - doc.page.margins.bottom - 30) {
        doc.addPage()
        y = doc.page.margins.top
        drawHeader()
        doc.fontSize(9).fillColor('#2B2620')
      }

      const cells = [
        emp.employeeName,
        String(emp.total),
        String(emp.completed),
        `${emp.completionPercent}%`,
        String(emp.onTime),
        String(emp.late),
        String(emp.pending),
        String(emp.needsReview),
        emp.avgDaysToComplete !== null ? String(emp.avgDaysToComplete) : '—'
      ]

      let x = startX
      for (let i = 0; i < COLUMNS.length; i++) {
        doc.text(cells[i] ?? '', x, y, { width: COLUMNS[i]!.width })
        x += COLUMNS[i]!.width
      }
      y += 18
    }

    if (data.employees.length === 0) {
      doc.fillColor('#A89D8E').text('No tasks in this period.', startX, y)
    }

    doc.end()
  })
}
