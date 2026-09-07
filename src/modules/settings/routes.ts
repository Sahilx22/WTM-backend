import { Router } from 'express'
import { db } from '../../db/index.js'
import { rateLimitConfigSchema, taskSettingsSchema, brandingSchema } from './schemas.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { resetConsecutiveFailureCounter } from '../../queue/rateLimiter.js'
import { restartOutgoingWorker } from '../../queue/outgoingWorker.js'
import { applyAutoReportSchedules, loadTaskSettings } from '../../queue/autoReports.js'
import { applyDigestSchedules } from '../../queue/scheduledDigests.js'

export const settingsRouter = Router()

async function loadConfig() {
  return db.selectFrom('rate_limit_config').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
}

settingsRouter.get('/settings', async (req, res) => {
  const [config, taskSettings] = await Promise.all([loadConfig(), loadTaskSettings()])

  const organization = req.user?.organizationId
    ? await db
        .selectFrom('organizations')
        .select(['id', 'name', 'logo_url', 'admin_wa_number'])
        .where('id', '=', req.user.organizationId)
        .executeTakeFirst()
    : null

  res.json({
    config,
    taskSettings,
    organization: organization
      ? { id: organization.id, name: organization.name, logoUrl: organization.logo_url, adminWaNumber: organization.admin_wa_number }
      : null
  })
})

settingsRouter.post('/settings/branding', async (req, res) => {
  if (!req.user?.organizationId) {
    res.status(403).json({ error: 'No organization to update.' })
    return
  }

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
    .where('id', '=', req.user.organizationId)
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
  const parsed = rateLimitConfigSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const before = await loadConfig()

  await db
    .updateTable('rate_limit_config')
    .set({ ...parsed.data, updated_at: new Date(), updated_by: req.user?.id ?? null })
    .where('id', '=', 1)
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

  const config = await loadConfig()
  res.json({ config })
})

settingsRouter.post('/settings/unpause', async (req, res) => {
  await db
    .updateTable('rate_limit_config')
    .set({ is_paused: false, updated_at: new Date(), updated_by: req.user?.id ?? null })
    .where('id', '=', 1)
    .execute()

  resetConsecutiveFailureCounter()

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'rate_limit_unpaused',
    entityType: 'rate_limit_config',
    ipAddress: req.ip
  })

  const config = await loadConfig()
  res.json({ config })
})

settingsRouter.post('/settings/tasks', async (req, res) => {
  const parsed = taskSettingsSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  await db
    .updateTable('task_settings')
    .set({ ...parsed.data, updated_at: new Date(), updated_by: req.user?.id ?? null })
    .where('id', '=', 1)
    .execute()

  const updated = await loadTaskSettings()
  await applyAutoReportSchedules(updated)
  await applyDigestSchedules(updated)

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'task_settings_updated',
    entityType: 'task_settings',
    metadata: parsed.data,
    ipAddress: req.ip
  })

  res.json({ taskSettings: updated })
})
