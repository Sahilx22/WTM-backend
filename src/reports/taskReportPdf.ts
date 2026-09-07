import PDFDocument from 'pdfkit'
import { STATUS_LABEL, type ReportData } from './taskMetrics.js'
import type { ReportBranding } from './branding.js'

const INK = '#2B2620'
const MUTED = '#746A5D'
const FAINT = '#A89D8E'
const BORDER = '#E7E0D6'
const ACCENT = '#35536F'
const HEADER_FILL = '#F4F1EA'
const STRIPE_FILL = '#FAF8F4'
const SUCCESS = '#3F7A58'
const WARNING = '#A97A2B'

const DEFAULT_BRANDING: ReportBranding = { companyName: 'WhatsApp Task Report', logoBuffer: null }

const COLUMNS = [
  { key: 'employeeName', label: 'Employee', width: 165, align: 'left' as const },
  { key: 'total', label: 'Total', width: 50, align: 'right' as const },
  { key: 'completed', label: 'Done', width: 50, align: 'right' as const },
  { key: 'completionPercent', label: 'Done %', width: 55, align: 'right' as const },
  { key: 'onTime', label: 'On time', width: 55, align: 'right' as const },
  { key: 'late', label: 'Late', width: 45, align: 'right' as const },
  { key: 'pending', label: 'Pending', width: 55, align: 'right' as const },
  { key: 'needsReview', label: 'In review', width: 60, align: 'right' as const },
  { key: 'avgDaysToComplete', label: 'Avg days', width: 60, align: 'right' as const }
] as const

function formatFilterLine(data: ReportData): string {
  const parts: string[] = [data.periodLabel]
  if (data.filters.status) parts.push(`Status: ${STATUS_LABEL[data.filters.status]}`)
  if (data.filters.recipient) parts.push(`Assigned to: "${data.filters.recipient}"`)
  if (data.filters.category) parts.push(`Category: @${data.filters.category}`)
  return parts.join('   |   ')
}

export function renderTaskReportPdf(data: ReportData, branding: ReportBranding = DEFAULT_BRANDING): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape', bufferPages: true })
    const chunks: Buffer[] = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const startX = doc.page.margins.left
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
    const tableWidth = COLUMNS.reduce((sum, c) => sum + c.width, 0)

    // --- Page 1 masthead: logo + company name + report title + filters ---
    let y = doc.page.margins.top
    const logoSize = 40
    let textX = startX

    if (branding.logoBuffer) {
      try {
        doc.image(branding.logoBuffer, startX, y, { fit: [logoSize, logoSize] })
        textX = startX + logoSize + 14
      } catch {
        // Corrupt/unsupported image bytes slipped past the sniff check — fall
        // back to a text-only masthead rather than failing the whole report.
        textX = startX
      }
    }

    doc.fontSize(15).fillColor(INK).font('Helvetica-Bold').text(branding.companyName, textX, y, { width: pageWidth - (textX - startX) })
    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text('Task Report', textX, doc.y)

    y = Math.max(y + logoSize, doc.y) + 12
    doc
      .moveTo(startX, y)
      .lineTo(startX + pageWidth, y)
      .strokeColor(ACCENT)
      .lineWidth(1.5)
      .stroke()
    y += 12

    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text(formatFilterLine(data), startX, y, { width: pageWidth })
    doc.fontSize(8).fillColor(FAINT).text(`Generated ${data.generatedAt.toLocaleString()}`, startX, doc.y + 2, { width: pageWidth })
    y = doc.y + 16

    // --- Overall summary stat tiles ---
    const tiles: { label: string; value: string; color: string }[] = [
      { label: 'Total tasks', value: String(data.overall.total), color: INK },
      { label: 'Completed', value: `${data.overall.completed} (${data.overall.completionPercent}%)`, color: SUCCESS },
      { label: 'Pending', value: String(data.overall.pending), color: MUTED },
      { label: 'Needs review', value: String(data.overall.needsReview), color: WARNING }
    ]
    const tileGap = 10
    const tileWidth = (tableWidth - tileGap * (tiles.length - 1)) / tiles.length
    const tileHeight = 46

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]!
      const tx = startX + i * (tileWidth + tileGap)
      doc
        .roundedRect(tx, y, tileWidth, tileHeight, 4)
        .fillColor(HEADER_FILL)
        .fill()
      doc.fontSize(15).fillColor(tile.color).font('Helvetica-Bold').text(tile.value, tx + 10, y + 8, { width: tileWidth - 20 })
      doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(tile.label, tx + 10, y + 28, { width: tileWidth - 20 })
    }
    y += tileHeight + 18

    doc.fontSize(11).fillColor(INK).font('Helvetica-Bold').text('By employee', startX, y)
    y = doc.y + 8

    function drawTableHeader(atY: number): number {
      doc.rect(startX, atY, tableWidth, 20).fillColor(HEADER_FILL).fill()
      let x = startX
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(MUTED)
      for (const col of COLUMNS) {
        doc.text(col.label, x + 6, atY + 6, { width: col.width - 10, height: 14, align: col.align, ellipsis: true })
        x += col.width
      }
      return atY + 20
    }

    function drawRunningHeader(): number {
      let ry = doc.page.margins.top
      doc.fontSize(9).fillColor(MUTED).font('Helvetica-Bold').text(branding.companyName, startX, ry)
      doc
        .fontSize(9)
        .font('Helvetica')
        .text(data.periodLabel, startX, ry, { width: pageWidth, align: 'right' })
      ry = doc.y + 6
      doc
        .moveTo(startX, ry)
        .lineTo(startX + pageWidth, ry)
        .strokeColor(BORDER)
        .lineWidth(1)
        .stroke()
      return ry + 12
    }

    y = drawTableHeader(y)

    const rowHeight = 20
    let rowIndex = 0

    for (const emp of data.employees) {
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage()
        y = drawRunningHeader()
        y = drawTableHeader(y)
        rowIndex = 0
      }

      if (rowIndex % 2 === 1) {
        doc.rect(startX, y, tableWidth, rowHeight).fillColor(STRIPE_FILL).fill()
      }

      const cells: Record<(typeof COLUMNS)[number]['key'], string> = {
        employeeName: emp.employeeName,
        total: String(emp.total),
        completed: String(emp.completed),
        completionPercent: `${emp.completionPercent}%`,
        onTime: String(emp.onTime),
        late: String(emp.late),
        pending: String(emp.pending),
        needsReview: String(emp.needsReview),
        avgDaysToComplete: emp.avgDaysToComplete !== null ? String(emp.avgDaysToComplete) : '—'
      }

      let x = startX
      doc.fontSize(9).font('Helvetica').fillColor(INK)
      for (const col of COLUMNS) {
        doc.text(cells[col.key], x + 6, y + 5, { width: col.width - 10, height: rowHeight - 8, align: col.align, ellipsis: true })
        x += col.width
      }

      doc
        .moveTo(startX, y + rowHeight)
        .lineTo(startX + tableWidth, y + rowHeight)
        .strokeColor(BORDER)
        .lineWidth(0.5)
        .stroke()

      y += rowHeight
      rowIndex++
    }

    if (data.employees.length === 0) {
      doc.fontSize(9).fillColor(FAINT).font('Helvetica').text('No tasks in this period.', startX, y + 8)
      y += 30
    } else {
      // Totals row — sums the count columns across every employee shown above.
      const totals = data.employees.reduce(
        (acc, e) => ({
          total: acc.total + e.total,
          completed: acc.completed + e.completed,
          onTime: acc.onTime + e.onTime,
          late: acc.late + e.late,
          pending: acc.pending + e.pending,
          needsReview: acc.needsReview + e.needsReview
        }),
        { total: 0, completed: 0, onTime: 0, late: 0, pending: 0, needsReview: 0 }
      )

      if (y + rowHeight > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage()
        y = drawRunningHeader()
        y = drawTableHeader(y)
      }

      doc.rect(startX, y, tableWidth, rowHeight).fillColor(HEADER_FILL).fill()
      const totalCells: Record<(typeof COLUMNS)[number]['key'], string> = {
        employeeName: 'Totals',
        total: String(totals.total),
        completed: String(totals.completed),
        completionPercent: data.overall.total > 0 ? `${data.overall.completionPercent}%` : '—',
        onTime: String(totals.onTime),
        late: String(totals.late),
        pending: String(totals.pending),
        needsReview: String(totals.needsReview),
        avgDaysToComplete: '—'
      }
      let x = startX
      doc.fontSize(9).font('Helvetica-Bold').fillColor(INK)
      for (const col of COLUMNS) {
        doc.text(totalCells[col.key], x + 6, y + 5, { width: col.width - 10, height: rowHeight - 8, align: col.align, ellipsis: true })
        x += col.width
      }
      y += rowHeight
    }

    // --- Footer: page numbers on every page ---
    const pageRange = doc.bufferedPageRange()
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
      doc.switchToPage(i)
      const footerY = doc.page.height - doc.page.margins.bottom + 12
      doc
        .fontSize(8)
        .fillColor(FAINT)
        .font('Helvetica')
        .text(branding.companyName, startX, footerY, { width: pageWidth / 2, align: 'left' })
      doc
        .fontSize(8)
        .fillColor(FAINT)
        .text(`Page ${i - pageRange.start + 1} of ${pageRange.count}`, startX + pageWidth / 2, footerY, {
          width: pageWidth / 2,
          align: 'right'
        })
    }

    doc.end()
  })
}
