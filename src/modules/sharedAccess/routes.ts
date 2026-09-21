import { Router } from 'express'
import { db } from '../../db/index.js'
import { requireOrgAdmin } from '../../auth/middleware.js'
import { hashPassword } from '../../auth/passwords.js'
import { normalizePhoneDigits, isValidPhoneDigits } from '../../lib/phone.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { createEmployeeSchema, createGrantSchema } from './schemas.js'

// Applied per-route below rather than as a router-wide `.use()`, matching
// organizationsRouter's convention: this router is mounted at the API root
// alongside every other module router, and a path-less `.use()` here would
// also gate any router mounted after it in app.ts.
export const sharedAccessRouter = Router()

sharedAccessRouter.get('/shared-access/employees', requireOrgAdmin, async (req, res) => {
  const organizationId = req.user!.organizationId!

  const employees = await db
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'is_active'])
    .where('organization_id', '=', organizationId)
    .where('role', '=', 'restricted')
    .orderBy('display_name', 'asc')
    .execute()

  const grants = await db
    .selectFrom('contact_access_grants')
    .innerJoin('contacts', 'contacts.id', 'contact_access_grants.contact_id')
    .select([
      'contact_access_grants.id',
      'contact_access_grants.user_id',
      'contact_access_grants.contact_id',
      'contact_access_grants.created_at',
      'contacts.display_name as contactDisplayName',
      'contacts.phone_number as contactPhoneNumber'
    ])
    .where('contact_access_grants.organization_id', '=', organizationId)
    .execute()

  const grantsByUser = new Map<number, typeof grants>()
  for (const grant of grants) {
    const list = grantsByUser.get(grant.user_id) ?? []
    list.push(grant)
    grantsByUser.set(grant.user_id, list)
  }

  res.json({
    employees: employees.map((e) => ({
      id: e.id,
      username: e.username,
      displayName: e.display_name,
      isActive: e.is_active,
      grants: (grantsByUser.get(e.id) ?? []).map((g) => ({
        id: g.id,
        contactId: g.contact_id,
        contactDisplayName: g.contactDisplayName,
        contactPhoneNumber: g.contactPhoneNumber,
        createdAt: g.created_at
      }))
    }))
  })
})

sharedAccessRouter.post('/shared-access/employees', requireOrgAdmin, async (req, res) => {
  const parsed = createEmployeeSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const { username, password, display_name } = parsed.data

  // Usernames are unique across the whole table (migration 001), not per
  // organization — same check organizationsRouter uses when creating an
  // org's first admin login.
  const existing = await db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst()
  if (existing) {
    res.status(409).json({ error: 'That username is already taken.' })
    return
  }

  const passwordHash = await hashPassword(password)

  const created = await db
    .insertInto('users')
    .values({
      username,
      password_hash: passwordHash,
      display_name,
      organization_id: req.user!.organizationId,
      role: 'restricted',
      is_super_admin: false
    })
    .returning(['id', 'username', 'display_name'])
    .executeTakeFirstOrThrow()

  await recordAuditLog({
    userId: req.user!.id,
    action: 'restricted_employee_created',
    entityType: 'user',
    entityId: created.id,
    ipAddress: req.ip
  })

  res.status(201).json({ id: created.id, username: created.username, displayName: created.display_name })
})

sharedAccessRouter.get('/shared-access/grants', requireOrgAdmin, async (req, res) => {
  const organizationId = req.user!.organizationId!

  const grants = await db
    .selectFrom('contact_access_grants')
    .innerJoin('users as employee', 'employee.id', 'contact_access_grants.user_id')
    .innerJoin('contacts', 'contacts.id', 'contact_access_grants.contact_id')
    .leftJoin('users as admin', 'admin.id', 'contact_access_grants.granted_by')
    .select([
      'contact_access_grants.id',
      'contact_access_grants.created_at',
      'employee.id as employeeId',
      'employee.display_name as employeeDisplayName',
      'contacts.id as contactId',
      'contacts.display_name as contactDisplayName',
      'contacts.phone_number as contactPhoneNumber',
      'admin.display_name as grantedByDisplayName'
    ])
    .where('contact_access_grants.organization_id', '=', organizationId)
    .orderBy('contact_access_grants.created_at', 'desc')
    .execute()

  res.json({
    grants: grants.map((g) => ({
      id: g.id,
      createdAt: g.created_at,
      employeeId: g.employeeId,
      employeeDisplayName: g.employeeDisplayName,
      contactId: g.contactId,
      contactDisplayName: g.contactDisplayName,
      contactPhoneNumber: g.contactPhoneNumber,
      grantedByDisplayName: g.grantedByDisplayName
    }))
  })
})

sharedAccessRouter.post('/shared-access/grants', requireOrgAdmin, async (req, res) => {
  const parsed = createGrantSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const organizationId = req.user!.organizationId!
  const { user_id, contact_id, phone_number } = parsed.data

  // Never trust user_id from the request body at face value — it must be
  // one of this organization's own restricted employees.
  const employee = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', user_id)
    .where('organization_id', '=', organizationId)
    .where('role', '=', 'restricted')
    .executeTakeFirst()
  if (!employee) {
    res.status(400).json({ error: 'Choose a valid employee.' })
    return
  }

  let resolvedContactId: number

  if (contact_id) {
    const contact = await db
      .selectFrom('contacts')
      .select('id')
      .where('id', '=', contact_id)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst()
    if (!contact) {
      res.status(400).json({ error: 'Choose a valid contact.' })
      return
    }
    resolvedContactId = contact.id
  } else {
    const digits = normalizePhoneDigits(phone_number ?? '')
    if (!isValidPhoneDigits(digits)) {
      res.status(400).json({ error: 'Enter a valid phone number including country code (8-15 digits).' })
      return
    }

    const contact = await db
      .insertInto('contacts')
      .values({
        phone_number: digits,
        display_name: null,
        source: 'manual',
        created_by: req.user!.id,
        organization_id: organizationId
      })
      .onConflict((oc) => oc.columns(['organization_id', 'phone_number']).doUpdateSet({ updated_at: new Date() }))
      .returning('id')
      .executeTakeFirstOrThrow()
    resolvedContactId = contact.id
  }

  const inserted = await db
    .insertInto('contact_access_grants')
    .values({
      organization_id: organizationId,
      user_id: employee.id,
      contact_id: resolvedContactId,
      granted_by: req.user!.id
    })
    .onConflict((oc) => oc.columns(['user_id', 'contact_id']).doNothing())
    .returning('id')
    .execute()

  const grant = inserted[0]
  if (!grant) {
    res.status(409).json({ error: 'This employee already has access to that contact.' })
    return
  }

  await recordAuditLog({
    userId: req.user!.id,
    action: 'contact_access_granted',
    entityType: 'contact_access_grant',
    entityId: grant.id,
    metadata: { employeeUserId: employee.id, contactId: resolvedContactId },
    ipAddress: req.ip
  })

  res.status(201).json({ id: grant.id })
})

sharedAccessRouter.delete('/shared-access/grants/:id', requireOrgAdmin, async (req, res) => {
  const id = Number(req.params.id)
  const organizationId = req.user!.organizationId!

  await db.deleteFrom('contact_access_grants').where('id', '=', id).where('organization_id', '=', organizationId).execute()

  await recordAuditLog({
    userId: req.user!.id,
    action: 'contact_access_revoked',
    entityType: 'contact_access_grant',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})
