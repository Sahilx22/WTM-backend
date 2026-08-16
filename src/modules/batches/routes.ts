import { Router } from 'express'
import { z } from 'zod'
import { db } from '../../db/index.js'
import { recordAuditLog } from '../../lib/auditLog.js'

export const batchesRouter = Router()

async function recomputeBatchContactCount(batchId: number): Promise<void> {
  const { count } = await db
    .selectFrom('batch_members')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('batch_id', '=', batchId)
    .executeTakeFirstOrThrow()

  await db
    .updateTable('batches')
    .set({ contact_count: Number(count), updated_at: new Date() })
    .where('id', '=', batchId)
    .execute()
}

batchesRouter.get('/batches', async (_req, res) => {
  const batches = await db.selectFrom('batches').selectAll().orderBy('created_at', 'desc').execute()
  res.json({ batches })
})

const batchInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => (v ? v : null))
})

batchesRouter.post('/batches', async (req, res) => {
  const parsed = batchInputSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const created = await db
    .insertInto('batches')
    .values({ name: parsed.data.name, description: parsed.data.description, created_by: req.user?.id ?? null })
    .returning('id')
    .executeTakeFirstOrThrow()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'batch_created',
    entityType: 'batch',
    entityId: created.id,
    ipAddress: req.ip
  })

  res.status(201).json({ id: created.id })
})

batchesRouter.get('/batches/:id', async (req, res) => {
  const id = Number(req.params.id)
  const batch = await db.selectFrom('batches').selectAll().where('id', '=', id).executeTakeFirst()
  if (!batch) {
    res.status(404).json({ error: 'Batch not found.' })
    return
  }

  const members = await db
    .selectFrom('batch_members')
    .innerJoin('contacts', 'contacts.id', 'batch_members.contact_id')
    .select(['contacts.id', 'contacts.phone_number', 'contacts.display_name', 'batch_members.added_at'])
    .where('batch_id', '=', id)
    .orderBy('contacts.display_name', 'asc')
    .orderBy('contacts.phone_number', 'asc')
    .execute()

  res.json({ batch, members })
})

batchesRouter.get('/batches/:id/add-members', async (req, res) => {
  const id = Number(req.params.id)
  const batch = await db.selectFrom('batches').select(['id', 'name']).where('id', '=', id).executeTakeFirst()
  if (!batch) {
    res.status(404).json({ error: 'Batch not found.' })
    return
  }

  const search = typeof req.query.search === 'string' ? req.query.search : ''
  let query = db
    .selectFrom('contacts')
    .leftJoin('batch_members', (join) =>
      join.onRef('batch_members.contact_id', '=', 'contacts.id').on('batch_members.batch_id', '=', id)
    )
    .select(['contacts.id', 'contacts.phone_number', 'contacts.display_name', 'batch_members.id as memberRowId'])
    .orderBy('contacts.display_name', 'asc')
    .orderBy('contacts.phone_number', 'asc')
    .limit(300)

  if (search.trim()) {
    const like = `%${search.trim()}%`
    query = query.where((eb) =>
      eb.or([eb('contacts.phone_number', 'ilike', like), eb('contacts.display_name', 'ilike', like)])
    )
  }

  const candidates = await query.execute()

  res.json({ batch, candidates, search })
})

batchesRouter.post('/batches/:id/members', async (req, res) => {
  const id = Number(req.params.id)
  const rawIds = req.body?.contact_ids
  const contactIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [])
    .map((v: string) => Number(v))
    .filter((n: number) => Number.isInteger(n) && n > 0)

  if (contactIds.length > 0) {
    await db
      .insertInto('batch_members')
      .values(contactIds.map((contactId: number) => ({ batch_id: id, contact_id: contactId })))
      .onConflict((oc) => oc.columns(['batch_id', 'contact_id']).doNothing())
      .execute()

    await recomputeBatchContactCount(id)

    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'batch_members_added',
      entityType: 'batch',
      entityId: id,
      metadata: { count: contactIds.length },
      ipAddress: req.ip
    })
  }

  res.status(204).end()
})

batchesRouter.delete('/batches/:id/members/:contactId', async (req, res) => {
  const id = Number(req.params.id)
  const contactId = Number(req.params.contactId)

  await db.deleteFrom('batch_members').where('batch_id', '=', id).where('contact_id', '=', contactId).execute()
  await recomputeBatchContactCount(id)

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'batch_member_removed',
    entityType: 'batch',
    entityId: id,
    metadata: { contactId },
    ipAddress: req.ip
  })

  res.status(204).end()
})

batchesRouter.delete('/batches/:id', async (req, res) => {
  const id = Number(req.params.id)
  await db.deleteFrom('batches').where('id', '=', id).execute()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'batch_deleted',
    entityType: 'batch',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})
