import { Router } from 'express'
import { db } from '../../db/index.js'
import {
  connectionEvents,
  createSession,
  deleteSession,
  getMaxSessions,
  getPrimarySocket,
  listSessionsForOrganization,
  maskPhoneNumber,
  requestConnect,
  requestLogout,
  type SessionSnapshot
} from '../../whatsapp/connectionManager.js'
import type { ConnectionStatus } from '../../db/schema.js'

export const connectionRouter = Router()

const STATUS_PRESENTATION: Record<ConnectionStatus, { label: string; tone: string }> = {
  connected: { label: 'Connected', tone: 'success' },
  connecting: { label: 'Connecting…', tone: 'warning' },
  qr_pending: { label: 'Scan QR to connect', tone: 'warning' },
  disconnected: { label: 'Disconnected', tone: 'danger' }
}

function sessionPayload(snapshot: SessionSnapshot) {
  const presentation = STATUS_PRESENTATION[snapshot.status]
  return {
    id: snapshot.sessionId,
    label: snapshot.label,
    isPrimary: snapshot.isPrimary,
    status: snapshot.status,
    statusLabel: presentation.label,
    statusTone: presentation.tone,
    qrDataUrl: snapshot.qrDataUrl,
    maskedPhoneNumber: maskPhoneNumber(snapshot.phoneNumber),
    lastDisconnectReason: snapshot.lastDisconnectReason
  }
}

// A session belongs to req.user's own organization — never let one org
// connect/disconnect/remove another org's session.
async function requireOwnSession(organizationId: number, sessionId: number): Promise<boolean> {
  const row = await db
    .selectFrom('whatsapp_sessions')
    .select('id')
    .where('id', '=', sessionId)
    .where('organization_id', '=', organizationId)
    .executeTakeFirst()
  return Boolean(row)
}

// Small always-visible indicator (sidebar): reflects whether *some* session
// for this org is connected — the primary if there is one, otherwise
// whichever session has the most "active" status.
connectionRouter.get('/connection/badge', async (req, res) => {
  const organizationId = req.user?.organizationId
  if (!organizationId) {
    res.json({ status: { status: 'disconnected', statusLabel: 'No sessions', statusTone: 'neutral', qrDataUrl: null, maskedPhoneNumber: null, lastDisconnectReason: null } })
    return
  }

  const sessions = await listSessionsForOrganization(organizationId)
  const primary = sessions.find((s) => s.isPrimary) ?? sessions[0]

  if (!primary) {
    res.json({ status: { status: 'disconnected', statusLabel: 'No sessions yet', statusTone: 'neutral', qrDataUrl: null, maskedPhoneNumber: null, lastDisconnectReason: null } })
    return
  }

  res.json({ status: sessionPayload(primary) })
})

connectionRouter.get('/connection/sessions', async (req, res) => {
  const organizationId = req.user?.organizationId
  if (!organizationId) {
    res.json({ sessions: [], maxSessions: 0 })
    return
  }

  const [sessions, maxSessions] = await Promise.all([listSessionsForOrganization(organizationId), getMaxSessions(organizationId)])
  res.json({ sessions: sessions.map(sessionPayload), maxSessions })
})

connectionRouter.get('/connection/sessions/stream', (req, res) => {
  const organizationId = req.user?.organizationId

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.flushHeaders()

  const send = async () => {
    if (!organizationId) return
    const sessions = await listSessionsForOrganization(organizationId)
    res.write(`event: message\ndata: ${JSON.stringify(sessions.map(sessionPayload))}\n\n`)
  }

  void send()

  const listener = (snapshot: SessionSnapshot) => {
    if (snapshot.organizationId === organizationId) void send()
  }
  connectionEvents.on('update', listener)

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000)

  req.on('close', () => {
    clearInterval(heartbeat)
    connectionEvents.off('update', listener)
  })
})

connectionRouter.post('/connection/sessions', async (req, res) => {
  const organizationId = req.user?.organizationId
  if (!organizationId) {
    res.status(403).json({ error: 'No organization to add a session to.' })
    return
  }

  const label = typeof req.body?.label === 'string' ? req.body.label : undefined

  try {
    const snapshot = await createSession(organizationId, label)
    await requestConnect(snapshot.sessionId)
    res.status(201).json({ session: sessionPayload(snapshot) })
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Could not create a new session.' })
  }
})

connectionRouter.post('/connection/sessions/:id/connect', async (req, res) => {
  const organizationId = req.user?.organizationId
  const sessionId = Number(req.params.id)

  if (!organizationId || !(await requireOwnSession(organizationId, sessionId))) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  await requestConnect(sessionId)
  const sessions = await listSessionsForOrganization(organizationId)
  const updated = sessions.find((s) => s.sessionId === sessionId)
  res.json({ session: updated ? sessionPayload(updated) : null })
})

connectionRouter.post('/connection/sessions/:id/logout', async (req, res) => {
  const organizationId = req.user?.organizationId
  const sessionId = Number(req.params.id)

  if (!organizationId || !(await requireOwnSession(organizationId, sessionId))) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  await requestLogout(sessionId, req.user?.id ?? null)
  const sessions = await listSessionsForOrganization(organizationId)
  const updated = sessions.find((s) => s.sessionId === sessionId)
  res.json({ session: updated ? sessionPayload(updated) : null })
})

connectionRouter.delete('/connection/sessions/:id', async (req, res) => {
  const organizationId = req.user?.organizationId
  const sessionId = Number(req.params.id)

  if (!organizationId || !(await requireOwnSession(organizationId, sessionId))) {
    res.status(404).json({ error: 'Session not found.' })
    return
  }

  try {
    await deleteSession(sessionId)
    res.status(204).end()
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Could not remove this session.' })
  }
})

// Diagnostic only — confirms whether *any* organization currently has a
// connected primary session (the one reminders/auto-reports go through).
connectionRouter.get('/connection/primary-status', (_req, res) => {
  res.json({ connected: getPrimarySocket() !== null })
})
