import { Router } from 'express'
import { db } from '../../db/index.js'
import {
  connectionEvents,
  getSnapshot,
  maskPhoneNumber,
  requestConnect,
  requestLogout,
  type ConnectionSnapshot
} from '../../whatsapp/connectionManager.js'
import type { ConnectionStatus } from '../../db/schema.js'

export const connectionRouter = Router()

const STATUS_PRESENTATION: Record<ConnectionStatus, { label: string; tone: string }> = {
  connected: { label: 'WhatsApp connected', tone: 'success' },
  connecting: { label: 'Connecting…', tone: 'warning' },
  qr_pending: { label: 'Scan QR to connect', tone: 'warning' },
  disconnected: { label: 'WhatsApp disconnected', tone: 'danger' }
}

function statusPayload(snapshot: ConnectionSnapshot) {
  const presentation = STATUS_PRESENTATION[snapshot.status]
  return {
    status: snapshot.status,
    statusLabel: presentation.label,
    statusTone: presentation.tone,
    qrDataUrl: snapshot.qrDataUrl,
    maskedPhoneNumber: maskPhoneNumber(snapshot.phoneNumber),
    lastDisconnectReason: snapshot.lastDisconnectReason
  }
}

connectionRouter.get('/connection/badge', async (_req, res) => {
  const row = await db
    .selectFrom('whatsapp_connection')
    .select(['status'])
    .where('id', '=', 1)
    .executeTakeFirst()

  const snapshot = getSnapshot()
  const liveStatus = snapshot.status
  const status = liveStatus ?? row?.status ?? 'disconnected'

  res.json({ status: statusPayload({ ...snapshot, status }) })
})

connectionRouter.get('/connection', (_req, res) => {
  res.json({ status: statusPayload(getSnapshot()) })
})

connectionRouter.get('/connection/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.flushHeaders()

  const send = (snapshot: ConnectionSnapshot) => {
    res.write(`event: message\ndata: ${JSON.stringify(statusPayload(snapshot))}\n\n`)
  }

  send(getSnapshot())

  const listener = (snapshot: ConnectionSnapshot) => send(snapshot)
  connectionEvents.on('update', listener)

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000)

  req.on('close', () => {
    clearInterval(heartbeat)
    connectionEvents.off('update', listener)
  })
})

connectionRouter.post('/connection/connect', async (_req, res) => {
  await requestConnect()
  res.json({ status: statusPayload(getSnapshot()) })
})

connectionRouter.post('/connection/logout', async (req, res) => {
  await requestLogout(req.user?.id ?? null)
  res.json({ status: statusPayload(getSnapshot()) })
})
