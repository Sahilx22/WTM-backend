import crypto from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { db } from '../../db/index.js'
import { contactInputSchema } from './schemas.js'
import { normalizePhoneDigits, isValidPhoneDigits } from '../../lib/phone.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { parseCsvBuffer } from '../../csv/parse.js'
import { HttpError } from '../../lib/httpError.js'

export const contactsRouter = Router()

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okMime = file.mimetype === 'text/csv' || file.mimetype === 'application/vnd.ms-excel'
    const okExt = file.originalname.toLowerCase().endsWith('.csv')
    if (okMime || okExt) {
      cb(null, true)
    } else {
      cb(new HttpError(400, 'Only .csv files are accepted.'))
    }
  }
})

contactsRouter.get('/contacts', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search : ''

  let query = db.selectFrom('contacts').selectAll().orderBy('display_name', 'asc').orderBy('phone_number', 'asc').limit(200)

  if (search.trim()) {
    const like = `%${search.trim()}%`
    query = query.where((eb) =>
      eb.or([eb('phone_number', 'ilike', like), eb('display_name', 'ilike', like)])
    )
  }

  const contacts = await query.execute()
  res.json({ contacts })
})

contactsRouter.get('/contacts/:id', async (req, res) => {
  const id = Number(req.params.id)
  const contact = await db.selectFrom('contacts').selectAll().where('id', '=', id).executeTakeFirst()
  if (!contact) {
    res.status(404).json({ error: 'Contact not found.' })
    return
  }
  res.json({ contact })
})

contactsRouter.post('/contacts', async (req, res) => {
  const parsed = contactInputSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const digits = normalizePhoneDigits(parsed.data.phone_number)
  if (!isValidPhoneDigits(digits)) {
    res.status(400).json({ error: 'Enter a valid phone number including country code (8-15 digits).' })
    return
  }

  const existing = await db
    .selectFrom('contacts')
    .select('id')
    .where('phone_number', '=', digits)
    .executeTakeFirst()
  if (existing) {
    res.status(400).json({ error: 'A contact with this phone number already exists.' })
    return
  }

  const created = await db
    .insertInto('contacts')
    .values({
      phone_number: digits,
      display_name: parsed.data.display_name,
      notes: parsed.data.notes,
      source: 'manual',
      created_by: req.user?.id ?? null
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'contact_created',
    entityType: 'contact',
    entityId: created.id,
    ipAddress: req.ip
  })

  res.status(201).json({ id: created.id })
})

contactsRouter.put('/contacts/:id', async (req, res) => {
  const id = Number(req.params.id)
  const parsed = contactInputSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const digits = normalizePhoneDigits(parsed.data.phone_number)
  if (!isValidPhoneDigits(digits)) {
    res.status(400).json({ error: 'Enter a valid phone number including country code (8-15 digits).' })
    return
  }

  const conflict = await db
    .selectFrom('contacts')
    .select('id')
    .where('phone_number', '=', digits)
    .where('id', '!=', id)
    .executeTakeFirst()
  if (conflict) {
    res.status(400).json({ error: 'Another contact already uses this phone number.' })
    return
  }

  await db
    .updateTable('contacts')
    .set({
      phone_number: digits,
      display_name: parsed.data.display_name,
      notes: parsed.data.notes,
      updated_at: new Date()
    })
    .where('id', '=', id)
    .execute()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'contact_updated',
    entityType: 'contact',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})

contactsRouter.delete('/contacts/:id', async (req, res) => {
  const id = Number(req.params.id)
  await db.deleteFrom('contacts').where('id', '=', id).execute()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'contact_deleted',
    entityType: 'contact',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

contactsRouter.post('/contacts/import/preview', csvUpload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Choose a .csv file to upload.' })
    return
  }

  let parsed: ReturnType<typeof parseCsvBuffer>
  try {
    const existingRows = await db.selectFrom('contacts').select('phone_number').execute()
    const existingSet = new Set(existingRows.map((r) => r.phone_number))
    parsed = parseCsvBuffer(req.file.buffer, existingSet)
  } catch (err) {
    res.status(400).json({ error: `Could not parse that file: ${err instanceof Error ? err.message : 'unknown error'}` })
    return
  }

  if (parsed.rows.length === 0) {
    res.status(400).json({ error: 'That file has no rows to import.' })
    return
  }

  const importId = crypto.randomUUID()
  await db
    .insertInto('csv_import_rows')
    .values(
      parsed.rows.map((row) => ({
        import_id: importId,
        raw_row: row.raw,
        phone_number: row.phoneNumber,
        display_name: row.displayName,
        validity: row.validity,
        reason: row.reason,
        created_by: req.user?.id ?? null
      }))
    )
    .execute()

  const batches = await db.selectFrom('batches').select(['id', 'name']).orderBy('name', 'asc').execute()

  res.json({
    importId,
    rows: parsed.rows.slice(0, 200),
    totalRows: parsed.rows.length,
    validCount: parsed.validCount,
    duplicateCount: parsed.duplicateCount,
    invalidCount: parsed.invalidCount,
    batches
  })
})

const confirmImportSchema = z.object({
  import_id: z.string().uuid(),
  batch_mode: z.enum(['new', 'existing']),
  new_batch_name: z.string().trim().max(120).optional(),
  existing_batch_id: z.string().optional()
})

contactsRouter.post('/contacts/import/confirm', async (req, res) => {
  const parsed = confirmImportSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid import confirmation request.' })
    return
  }

  const { import_id, batch_mode, new_batch_name, existing_batch_id } = parsed.data

  const validStagedRows = await db
    .selectFrom('csv_import_rows')
    .select(['phone_number', 'display_name'])
    .where('import_id', '=', import_id)
    .where('validity', '=', 'valid')
    .execute()

  const result = await db.transaction().execute(async (trx) => {
    let batchId: number

    if (batch_mode === 'new') {
      const name = new_batch_name?.trim()
      if (!name) throw new Error('Enter a name for the new batch.')
      const created = await trx
        .insertInto('batches')
        .values({ name, created_by: req.user?.id ?? null })
        .returning('id')
        .executeTakeFirstOrThrow()
      batchId = created.id
    } else {
      const id = Number(existing_batch_id)
      if (!Number.isInteger(id)) throw new Error('Choose a batch to import into.')
      batchId = id
    }

    let importedCount = 0

    if (validStagedRows.length > 0) {
      const insertedContacts = await trx
        .insertInto('contacts')
        .values(
          validStagedRows.map((row) => ({
            phone_number: row.phone_number as string,
            display_name: row.display_name,
            source: 'csv' as const,
            created_by: req.user?.id ?? null
          }))
        )
        .onConflict((oc) => oc.column('phone_number').doUpdateSet({ updated_at: new Date() }))
        .returning(['id'])
        .execute()

      importedCount = insertedContacts.length

      if (insertedContacts.length > 0) {
        await trx
          .insertInto('batch_members')
          .values(insertedContacts.map((c) => ({ batch_id: batchId, contact_id: c.id })))
          .onConflict((oc) => oc.columns(['batch_id', 'contact_id']).doNothing())
          .execute()

        const { count } = await trx
          .selectFrom('batch_members')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('batch_id', '=', batchId)
          .executeTakeFirstOrThrow()

        await trx
          .updateTable('batches')
          .set({ contact_count: Number(count), updated_at: new Date() })
          .where('id', '=', batchId)
          .execute()
      }
    }

    await trx.deleteFrom('csv_import_rows').where('import_id', '=', import_id).execute()

    return { batchId, importedCount }
  })

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'contacts_csv_imported',
    entityType: 'batch',
    entityId: result.batchId,
    metadata: { importedCount: result.importedCount },
    ipAddress: req.ip
  })

  res.json({ batchId: result.batchId, importedCount: result.importedCount })
})
