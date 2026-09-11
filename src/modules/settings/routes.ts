import { Router } from 'express'
import { db } from '../../db/index.js'
import { rateLimitConfigSchema, taskSettingsSchema, brandingSchema } from './schemas.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { resetConsecutiveFailureCounter } from '../../queue/rateLimiter.js'
import { restartOutgoingWorker } from '../../queue/outgoingWorker.js'
import { loadTaskSettingsForOrganization } from '../../queue/autoReports.js'
import { reapplySchedulesIfRunning } from '../../queue/lifecycle.js'

export const settingsRouter = Router()

// Every route below operates on the caller's own organization's settings
// only — there is no longer a single shared config row (see migrations
// 036/037), so a super admin (no organization) has no settings of its own to
// read or change here.
function requireOrganization(req: import('express').Request, res: import('express').Response): number | null {
  if (!req.user?.organizationId) {
    res.status(403).json({ error: 'No organization to manage settings for.' })
    return null
  }
  return req.user.organizationId
}

async function loadConfig(organizationId: number) {
  return db.selectFrom('rate_limit_config').selectAll().where('organization_id', '=', organizationId).executeTakeFirstOrThrow()
}

settingsRouter.get('/settings', async (req, res) => {
  const organizationId = requireOrganization(req, res)
  if (organizationId === null) return

  const [config, taskSettings, organization] = await Promise.all([
    loadConfig(organizationId),
    loadTaskSettingsForOrganization(organizationId),
    db.selectFrom('organizations').select(['id', 'name', 'logo_url', 'admin_wa_number']).where('id', '=', organizationId).executeTakeFirst()
  ])

  res.json({
    config,
    taskSettings,
    organization: organization
      ? { id: organization.id, name: organization.name, logoUrl: organization.logo_url, adminWaNumber: organization.admin_wa_number }
      : null
  })
})

settingsRouter.post('/settings/branding', async (req, res) => {
  const organizationId = requireOrganization(req, res)
  if (organizationId === null) return

  const parsed = brandingSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const { name, logo_url } = parsed.data

  const organization = await db
    .updateTable('organizations')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(logo_url !== undefined ? { logo_url: logo_url === '' ? null : logo_url } : {}),
      updated_at: new Date()
    })
    .where('id', '=', organizationId)
    .returning(['id', 'name', 'logo_url', 'admin_wa_number'])
    .executeTakeFirstOrThrow()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'branding_updated',
    entityType: 'organization',
    entityId: organization.id,
    metadata: parsed.data,
    ipAddress: req.ip
  })

  res.json({
    organization: { id: organization.id, name: organization.name, logoUrl: organization.logo_url, adminWaNumber: organization.admin_wa_number }
  })
})

settingsRouter.post('/settings', async (req, res) => {
  const organizationId = requireOrganization(req, res)
  if (organizationId === null) return

  const parsed = rateLimitConfigSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const before = await loadConfig(organizationId)

  await db
    .updateTable('rate_limit_config')
    .set({ ...parsed.data, updated_at: new Date(), updated_by: req.user?.id ?? null })
    .where('organization_id', '=', organizationId)
    .execute()

  if (parsed.data.concurrency !== before.concurrency) {
    await restartOutgoingWorker(parsed.data.concurrency)
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'rate_limit_config_updated',
    entityType: 'rate_limit_config',
    metadata: parsed.data,
    ipAddress: req.ip
  })

  const config = await loadConfig(organizationId)
  res.json({ config })
})

settingsRouter.post('/settings/unpause', async (req, res) => {
  const organizationId = requireOrganization(req, res)
  if (organizationId === null) return

  await db
    .updateTable('rate_limit_config')
    .set({ is_paused: false, updated_at: new Date(), updated_by: req.user?.id ?? null })
    .where('organization_id', '=', organizationId)
    .execute()

  resetConsecutiveFailureCounter(organizationId)

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'rate_limit_unpaused',
    entityType: 'rate_limit_config',
    ipAddress: req.ip
  })

  const config = await loadConfig(organizationId)
  res.json({ config })
})

settingsRouter.post('/settings/tasks', async (req, res) => {
  const organizationId = requireOrganization(req, res)
  if (organizationId === null) return

  const parsed = taskSettingsSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  await db
    .updateTable('task_settings')
    .set({ ...parsed.data, updated_at: new Date(), updated_by: req.user?.id ?? null })
    .where('organization_id', '=', organizationId)
    .execute()

  const updated = await loadTaskSettingsForOrganization(organizationId)
  await reapplySchedulesIfRunning(organizationId, updated)

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'task_settings_updated',
    entityType: 'task_settings',
    metadata: parsed.data,
    ipAddress: req.ip
  })

  res.json({ taskSettings: updated })
})
