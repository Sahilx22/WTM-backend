import { parse } from 'csv-parse/sync'
import { normalizePhoneDigits, isValidPhoneDigits } from '../lib/phone.js'

const PHONE_HEADER_CANDIDATES = ['phone', 'phone_number', 'phonenumber', 'number', 'mobile', 'whatsapp']
const NAME_HEADER_CANDIDATES = ['name', 'display_name', 'displayname', 'full_name', 'contact_name']

export interface ParsedCsvRow {
  raw: Record<string, string>
  phoneNumber: string | null
  displayName: string | null
  validity: 'valid' | 'duplicate' | 'invalid'
  reason: string | null
}

export interface CsvParseResult {
  rows: ParsedCsvRow[]
  validCount: number
  duplicateCount: number
  invalidCount: number
}

function findColumn(headers: string[], candidates: string[]): string | null {
  const normalized = headers.map((h) => h.trim().toLowerCase())
  for (const candidate of candidates) {
    const idx = normalized.indexOf(candidate)
    if (idx !== -1) return headers[idx] ?? null
  }
  return null
}

export function parseCsvBuffer(buffer: Buffer, existingPhoneNumbers: Set<string>): CsvParseResult {
  const records: Record<string, string>[] = parse(buffer, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true
  })

  const rows: ParsedCsvRow[] = []
  const seenInFile = new Set<string>()

  if (records.length === 0) {
    return { rows: [], validCount: 0, duplicateCount: 0, invalidCount: 0 }
  }

  const headers = Object.keys(records[0] ?? {})
  const phoneColumn = findColumn(headers, PHONE_HEADER_CANDIDATES) ?? headers[0] ?? null
  const nameColumn = findColumn(headers, NAME_HEADER_CANDIDATES)

  let validCount = 0
  let duplicateCount = 0
  let invalidCount = 0

  for (const raw of records) {
    const rawPhone = phoneColumn ? (raw[phoneColumn] ?? '') : ''
    const displayName = nameColumn ? (raw[nameColumn]?.trim() ?? null) || null : null
    const digits = normalizePhoneDigits(rawPhone)

    let validity: ParsedCsvRow['validity']
    let reason: string | null = null

    if (!digits || !isValidPhoneDigits(digits)) {
      validity = 'invalid'
      reason = 'Missing or invalid phone number'
      invalidCount++
    } else if (seenInFile.has(digits) || existingPhoneNumbers.has(digits)) {
      validity = 'duplicate'
      reason = existingPhoneNumbers.has(digits) ? 'Already in contacts' : 'Duplicate within this file'
      duplicateCount++
    } else {
      validity = 'valid'
      validCount++
      seenInFile.add(digits)
    }

    rows.push({ raw, phoneNumber: digits || null, displayName, validity, reason })
  }

  return { rows, validCount, duplicateCount, invalidCount }
}
