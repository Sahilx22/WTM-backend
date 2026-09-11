import { Router } from 'express'
import { db } from '../../db/index.js'
import { hashPassword } from '../../auth/passwords.js'
import { requireSuperAdmin } from '../../auth/middleware.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { createOrganizationSchema, updateOrganizationSchema } from './schemas.js'

export const organizationsRouter = Router()

// Applied per-route below rather than as a router-wide `.use()`: this router
// is mounted at the API root alongside every other module router, and a
// path-less `.use()` here would run for *any* request that falls through to
// it — including ones meant for routers mounted after it (e.g. tasks,
// reports) — blocking them with a super-admin check they were never meant
// to have.
organizationsRouter.get('/organizations', requireSuperAdmin, async (_req, res) => {
  const organizations = await db.selectFrom('organizations').selectAll().orderBy('created_at', 'desc').execute()
  res.json({ organizations })
})

organizationsRouter.get('/organizations/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const organization = await db.selectFrom('organizations').selectAll().where('id', '=', id).executeTakeFirst()

  if (!organization) {
    res.status(404).json({ error: 'Organization not found.' })
    return
  }

  res.json({ organization })
})

organizationsRouter.post('/organizations', requireSuperAdmin, async (req, res) => {
  const parsed = createOrganizationSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const { name, admin_wa_number, max_sessions, username, password, display_name } = parsed.data

  const existing = await db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst()
  if (existing) {
    res.status(409).json({ error: 'That username is already taken.' })
    return
  }

  const passwordHash = await hashPassword(password)

  const result = await db.transaction().execute(async (trx) => {
    const organization = await trx
      .insertInto('organizations')
      .values({ name, admin_wa_number: admin_wa_number ?? null, max_sessions: max_sessions ?? 1 })
      .returningAll()
      .executeTakeFirstOrThrow()

    const user = await trx
      .insertInto('users')
      .values({
        username,
        password_hash: passwordHash,
        display_name,
        organization_id: organization.id,
        is_super_admin: false
      })
      .returning(['id', 'username', 'display_name'])
      .executeTakeFirstOrThrow()

    // Every organization gets its own independent rate-limit and
    // task-settings row (see migrations 036/037) — column defaults cover
    // every field, so this just needs to exist.
    await trx.insertInto('rate_limit_config').values({ organization_id: organization.id }).execute()
    await trx.insertInto('task_settings').values({ organization_id: organization.id }).execute()

    return { organization, user }
  })

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'organization_created',
    entityType: 'organization',
    entityId: result.organization.id,
    metadata: { name, username },
    ipAddress: req.ip
  })

  res.status(201).json(result)
})

organizationsRouter.put('/organizations/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const parsed = updateOrganizationSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  if (Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: 'Nothing to update.' })
    return
  }

  const organization = await db
    .updateTable('organizations')
    .set({ ...parsed.data, updated_at: new Date() })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()

  if (!organization) {
    res.status(404).json({ error: 'Organization not found.' })
    return
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'organization_updated',
    entityType: 'organization',
    entityId: id,
    metadata: parsed.data,
    ipAddress: req.ip
  })

  res.json({ organization })
})
