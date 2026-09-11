import { Router } from 'express'
import { db } from '../../db/index.js'
import { getPrimarySocketForOrganization, getPrimarySnapshotForOrganization } from '../../whatsapp/connectionManager.js'
import { upsertGroupMetadata } from '../../whatsapp/store.js'
import { recordAuditLog } from '../../lib/auditLog.js'

export const groupsRouter = Router()

async function fetchGroups(organizationId: number | undefined) {
  let query = db.selectFrom('groups').selectAll().orderBy('subject', 'asc')
  // Regular org users only ever see their own organization's groups; the
  // super admin (no organization) gets the unscoped, cross-org view.
  if (organizationId !== undefined) {
    query = query.where('organization_id', '=', organizationId)
  }
  return query.execute()
}

groupsRouter.get('/groups', async (req, res) => {
  const groups = await fetchGroups(req.user?.organizationId ?? undefined)
  res.json({ groups })
})

groupsRouter.post('/groups/sync', async (req, res) => {
  const organizationId = req.user?.organizationId
  if (!organizationId) {
    res.status(403).json({ error: 'No organization to sync groups for.' })
    return
  }

  const sock = getPrimarySocketForOrganization(organizationId)
  const snapshot = getPrimarySnapshotForOrganization(organizationId)

  if (!sock || !snapshot) {
    const groups = await fetchGroups(organizationId)
    res.status(400).json({ groups, message: 'WhatsApp is not connected — connect it first to sync groups.' })
    return
  }

  const allGroups = await sock.groupFetchAllParticipating()
  for (const metadata of Object.values(allGroups)) {
    await upsertGroupMetadata(metadata, organizationId, snapshot.waJid ?? undefined)
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'groups_synced',
    entityType: 'groups',
    metadata: { count: Object.keys(allGroups).length },
    ipAddress: req.ip
  })

  const groups = await fetchGroups(organizationId)
  res.json({ groups, message: `Synced ${Object.keys(allGroups).length} group(s).` })
})
