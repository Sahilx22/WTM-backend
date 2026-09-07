import { Router } from 'express'
import { z } from 'zod'
import { db } from '../db/index.js'
import { verifyPassword } from './passwords.js'
import { signToken } from './jwt.js'
import { recordAuditLog } from '../lib/auditLog.js'
import { authRateLimit } from '../middleware/authRateLimit.js'
import { requireAuth } from './middleware.js'

export const authRouter = Router()

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200)
})

authRouter.post('/auth/login', authRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: 'Enter a username and password.' })
    return
  }

  const { username, password } = parsed.data
  const user = await db
    .selectFrom('users')
    .selectAll()
    .where('username', '=', username)
    .where('is_active', '=', true)
    .executeTakeFirst()

  const genericError = 'Invalid username or password.'

  if (!user) {
    // Still hash to keep response timing similar whether or not the user exists.
    await verifyPassword(password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali')
    res.status(401).json({ error: genericError })
    return
  }

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) {
    await recordAuditLog({
      userId: null,
      action: 'login_failed',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip
    })
    res.status(401).json({ error: genericError })
    return
  }

  await db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', user.id).execute()
  await recordAuditLog({
    userId: user.id,
    action: 'login_success',
    entityType: 'user',
    entityId: user.id,
    ipAddress: req.ip
  })

  const token = signToken({
    id: user.id,
    username: user.username,
    organizationId: user.organization_id,
    isSuperAdmin: user.is_super_admin
  })

  const organization = user.organization_id
    ? await db
        .selectFrom('organizations')
        .select(['id', 'name', 'logo_url'])
        .where('id', '=', user.organization_id)
        .executeTakeFirst()
    : null

  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      organizationId: user.organization_id,
      isSuperAdmin: user.is_super_admin,
      organization: organization ? { id: organization.id, name: organization.name, logoUrl: organization.logo_url } : null
    }
  })
})

authRouter.post('/auth/logout', requireAuth, async (req, res) => {
  await recordAuditLog({ userId: req.user?.id ?? null, action: 'logout', ipAddress: req.ip })
  res.status(204).end()
})

authRouter.get('/auth/me', requireAuth, async (req, res) => {
  const user = await db
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'organization_id', 'is_super_admin'])
    .where('id', '=', req.user!.id)
    .executeTakeFirst()

  if (!user) {
    res.status(401).json({ error: 'Authentication required.' })
    return
  }

  const organization = user.organization_id
    ? await db
        .selectFrom('organizations')
        .select(['id', 'name', 'logo_url'])
        .where('id', '=', user.organization_id)
        .executeTakeFirst()
    : null

  res.json({
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      organizationId: user.organization_id,
      isSuperAdmin: user.is_super_admin,
      organization: organization ? { id: organization.id, name: organization.name, logoUrl: organization.logo_url } : null
    }
  })
})
