import { Router } from 'express'
import { db } from '../../db/index.js'
import { getPrimarySocket, getPrimarySnapshot } from '../../whatsapp/connectionManager.js'
import { upsertGroupMetadata } from '../../whatsapp/store.js'
import { recordAuditLog } from '../../lib/auditLog.js'

export const groupsRouter = Router()

async function fetchGroups() {
  return db.selectFrom('groups').selectAll().orderBy('subject', 'asc').execute()
}

groupsRouter.get('/groups', async (_req, res) => {
  const groups = await fetchGroups()
  res.json({ groups })
})

groupsRouter.post('/groups/sync', async (req, res) => {
  const sock = getPrimarySocket()
  const snapshot = getPrimarySnapshot()

  if (!sock || !snapshot) {
    const groups = await fetchGroups()
    res.status(400).json({ groups, message: 'WhatsApp is not connected — connect it first to sync groups.' })
    return
  }

  const allGroups = await sock.groupFetchAllParticipating()
  for (const metadata of Object.values(allGroups)) {
    await upsertGroupMetadata(metadata, snapshot.waJid ?? undefined)
  }

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'groups_synced',
    entityType: 'groups',
    metadata: { count: Object.keys(allGroups).length },
    ipAddress: req.ip
  })

  const groups = await fetchGroups()
  res.json({ groups, message: `Synced ${Object.keys(allGroups).length} group(s).` })
})
