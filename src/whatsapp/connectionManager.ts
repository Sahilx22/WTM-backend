import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import pino from 'pino'
import { AUTH_SESSIONS_DIR } from '../config/paths.js'
import { isProduction } from '../config/env.js'
import { db } from '../db/index.js'
import { recordAuditLog } from '../lib/auditLog.js'
import {
  groupMetadataCache,
  msgRetryCounterCache,
  getCachedMessage,
  upsertGroupMetadata,
  upsertContactsFromWhatsApp
} from './store.js'
import { handleMessageForTasks } from './taskEngine.js'
import { handleCommandMessage } from './commandEngine.js'
import type { ConnectionStatus, WhatsappSession } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

// A single organization can now have more than one linked WhatsApp number
// ("session") — the org's own number plus, optionally, one per employee who
// should be able to delegate tasks by texting "#task" from their own phone.
// Whichever session an org connects *first* becomes that org's permanent
// primary session: every reminder and auto-report always goes out through
// the primary session's number, no matter which session's message created
// the underlying task. Every connected session (primary or not) can still
// be messaged directly with the bot commands (/status, /report, etc.) in
// its own self-chat — those keep working exactly as before, against the one
// shared task pool.
export interface SessionSnapshot {
  sessionId: number
  organizationId: number
  label: string | null
  isPrimary: boolean
  status: ConnectionStatus
  qrDataUrl: string | null
  phoneNumber: string | null
  waJid: string | null
  lastDisconnectReason: string | null
}

interface SessionRuntime {
  sock: WASocket | null
  snapshot: SessionSnapshot
  starting: boolean
  reconnectTimer: NodeJS.Timeout | null
}

const runtimes = new Map<number, SessionRuntime>()

export const connectionEvents = new EventEmitter()
export const messageAckEvents = new EventEmitter()

function authDirFor(sessionId: number): string {
  return path.join(AUTH_SESSIONS_DIR, String(sessionId))
}

function snapshotFromRow(row: WhatsappSession): SessionSnapshot {
  return {
    sessionId: row.id,
    organizationId: row.organization_id,
    label: row.label,
    isPrimary: row.is_primary,
    status: row.status,
    qrDataUrl: null,
    phoneNumber: row.phone_number,
    waJid: row.wa_jid,
    lastDisconnectReason: row.last_disconnect_reason
  }
}

function ensureRuntime(row: WhatsappSession): SessionRuntime {
  let runtime = runtimes.get(row.id)
  if (!runtime) {
    runtime = { sock: null, snapshot: snapshotFromRow(row), starting: false, reconnectTimer: null }
    runtimes.set(row.id, runtime)
  }
  return runtime
}

export function getSnapshot(sessionId: number): SessionSnapshot | null {
  return runtimes.get(sessionId)?.snapshot ?? null
}

export function getSocketForSession(sessionId: number): WASocket | null {
  return runtimes.get(sessionId)?.sock ?? null
}

// Resolves the socket every reminder/auto-report goes out through: whichever
// session is flagged primary *and* currently connected. In the (unusual)
// case where more than one organization has a connected primary session at
// once, the lowest session id wins — deterministic, though this app is
// built around one actively-used organization at a time.
export function getPrimarySocket(): WASocket | null {
  const candidates = [...runtimes.values()]
    .filter((r) => r.snapshot.isPrimary && r.snapshot.status === 'connected' && r.sock)
    .sort((a, b) => a.snapshot.sessionId - b.snapshot.sessionId)
  return candidates[0]?.sock ?? null
}

export function isPrimaryConnected(): boolean {
  return getPrimarySocket() !== null
}

// The connected primary session's own snapshot — used wherever a job needs
// to send *to* the admin's own number (auto-reports), not just through it.
export function getPrimarySnapshot(): SessionSnapshot | null {
  const candidates = [...runtimes.values()]
    .filter((r) => r.snapshot.isPrimary && r.snapshot.status === 'connected' && r.sock)
    .sort((a, b) => a.snapshot.sessionId - b.snapshot.sessionId)
  return candidates[0]?.snapshot ?? null
}

export async function listSessionsForOrganization(organizationId: number): Promise<SessionSnapshot[]> {
  const rows = await db
    .selectFrom('whatsapp_sessions')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .orderBy('id', 'asc')
    .execute()
  return rows.map((row) => runtimes.get(row.id)?.snapshot ?? snapshotFromRow(row))
}

export async function getMaxSessions(organizationId: number): Promise<number> {
  const org = await db
    .selectFrom('organizations')
    .select('max_sessions')
    .where('id', '=', organizationId)
    .executeTakeFirstOrThrow()
  return org.max_sessions
}

async function persistSnapshot(sessionId: number): Promise<void> {
  const snapshot = runtimes.get(sessionId)?.snapshot
  if (!snapshot) return
  await db
    .updateTable('whatsapp_sessions')
    .set({
      status: snapshot.status,
      phone_number: snapshot.phoneNumber,
      wa_jid: snapshot.waJid,
      connected_at: snapshot.status === 'connected' ? new Date() : undefined,
      last_disconnect_reason: snapshot.lastDisconnectReason,
      is_primary: snapshot.isPrimary,
      updated_at: new Date()
    })
    .where('id', '=', sessionId)
    .execute()
}

function updateSnapshot(sessionId: number, partial: Partial<SessionSnapshot>): void {
  const runtime = runtimes.get(sessionId)
  if (!runtime) return
  runtime.snapshot = { ...runtime.snapshot, ...partial }
  connectionEvents.emit('update', runtime.snapshot)
  void persistSnapshot(sessionId)
}

export async function createSession(organizationId: number, label?: string): Promise<SessionSnapshot> {
  const maxSessions = await getMaxSessions(organizationId)
  const existing = await db
    .selectFrom('whatsapp_sessions')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('organization_id', '=', organizationId)
    .executeTakeFirstOrThrow()

  if (Number(existing.count) >= maxSessions) {
    throw new Error(`This organization is limited to ${maxSessions} WhatsApp session${maxSessions === 1 ? '' : 's'}.`)
  }

  const row = await db
    .insertInto('whatsapp_sessions')
    .values({ organization_id: organizationId, label: label?.trim() || null })
    .returningAll()
    .executeTakeFirstOrThrow()

  ensureRuntime(row)
  return snapshotFromRow(row)
}

export async function startConnection(sessionId: number): Promise<void> {
  const row = await db.selectFrom('whatsapp_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst()
  if (!row) return

  const runtime = ensureRuntime(row)
  if (runtime.starting || runtime.snapshot.status === 'connected') return
  runtime.starting = true

  try {
    const authDir = authDirFor(sessionId)
    fs.mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: Browsers.ubuntu('WA Messenger'),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      msgRetryCounterCache,
      cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
      getMessage: async (key) => getCachedMessage(key)
    })
    runtime.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        const qrDataUrl = await qrcode.toDataURL(qr)
        updateSnapshot(sessionId, { status: 'qr_pending', qrDataUrl })
      }

      if (connection === 'connecting') {
        updateSnapshot(sessionId, { status: 'connecting' })
      } else if (connection === 'open') {
        const rawId = sock.user?.id
        const decoded = rawId ? jidDecode(rawId) : null

        // First session this organization has ever successfully connected
        // becomes (and permanently stays) primary.
        const existingPrimary = await db
          .selectFrom('whatsapp_sessions')
          .select('id')
          .where('organization_id', '=', runtime.snapshot.organizationId)
          .where('is_primary', '=', true)
          .executeTakeFirst()
        const isPrimary = runtime.snapshot.isPrimary || !existingPrimary

        updateSnapshot(sessionId, {
          status: 'connected',
          qrDataUrl: null,
          phoneNumber: decoded?.user ?? null,
          waJid: rawId ? jidNormalizedUser(rawId) : null,
          lastDisconnectReason: null,
          isPrimary
        })
        await recordAuditLog({ userId: null, action: 'whatsapp_connected', entityType: 'whatsapp_connection', entityId: sessionId })
      } else if (connection === 'close') {
        const boomError = lastDisconnect?.error as Boom | undefined
        const statusCode = boomError?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut

        updateSnapshot(sessionId, {
          status: 'disconnected',
          qrDataUrl: null,
          lastDisconnectReason: boomError?.message ?? 'Connection closed'
        })

        if (loggedOut) {
          await clearAuthState(sessionId)
          await recordAuditLog({ userId: null, action: 'whatsapp_logged_out', entityType: 'whatsapp_connection', entityId: sessionId })
        } else {
          scheduleReconnect(sessionId)
        }
      }
    })

    sock.ev.on('groups.upsert', async (groups) => {
      for (const group of groups) {
        await upsertGroupMetadata(group, runtime.snapshot.waJid ?? undefined)
      }
    })

    sock.ev.on('groups.update', async (updates) => {
      for (const update of updates) {
        if (!update.id) continue
        try {
          const metadata = await sock.groupMetadata(update.id)
          await upsertGroupMetadata(metadata, runtime.snapshot.waJid ?? undefined)
        } catch (err) {
          logger.warn({ err, jid: update.id }, 'failed to refresh group metadata after groups.update')
        }
      }
    })

    sock.ev.on('group-participants.update', async (event) => {
      try {
        const metadata = await sock.groupMetadata(event.id)
        await upsertGroupMetadata(metadata, runtime.snapshot.waJid ?? undefined)
      } catch (err) {
        logger.warn({ err, jid: event.id }, 'failed to refresh group metadata after participants update')
      }
    })

    sock.ev.on('messages.update', (updates) => {
      messageAckEvents.emit('updates', updates)
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const m of messages) {
        try {
          await handleMessageForTasks(sock, m, sessionId, runtime.snapshot.organizationId)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for task engine')
        }
        try {
          await handleCommandMessage(sock, runtime.snapshot.waJid, m, runtime.snapshot.organizationId)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for command engine')
        }
      }
    })

    sock.ev.on('messaging-history.set', async ({ contacts }) => {
      if (contacts.length === 0) return
      try {
        const imported = await upsertContactsFromWhatsApp(contacts)
        logger.info({ sessionId, received: contacts.length, imported }, 'synced contacts from WhatsApp history')
      } catch (err) {
        logger.warn({ err }, 'failed to sync contacts from history batch')
      }
    })

    sock.ev.on('contacts.upsert', async (contacts) => {
      try {
        await upsertContactsFromWhatsApp(contacts)
      } catch (err) {
        logger.warn({ err }, 'failed to sync contacts.upsert')
      }
    })

    sock.ev.on('contacts.update', async (updates) => {
      const complete = updates.filter((u): u is typeof u & { id: string } => Boolean(u.id))
      if (complete.length === 0) return
      try {
        await upsertContactsFromWhatsApp(complete)
      } catch (err) {
        logger.warn({ err }, 'failed to sync contacts.update')
      }
    })
  } finally {
    runtime.starting = false
  }
}

function scheduleReconnect(sessionId: number): void {
  const runtime = runtimes.get(sessionId)
  if (!runtime || runtime.reconnectTimer) return
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null
    void startConnection(sessionId)
  }, 3000)
}

async function clearAuthState(sessionId: number): Promise<void> {
  const authDir = authDirFor(sessionId)
  await fs.promises.rm(authDir, { recursive: true, force: true })
  await fs.promises.mkdir(authDir, { recursive: true })
  updateSnapshot(sessionId, { status: 'disconnected', qrDataUrl: null, phoneNumber: null, waJid: null })
}

export async function requestConnect(sessionId: number): Promise<void> {
  const runtime = runtimes.get(sessionId)
  if (runtime && (runtime.snapshot.status === 'connected' || runtime.snapshot.status === 'connecting' || runtime.starting)) return
  await startConnection(sessionId)
}

export async function requestLogout(sessionId: number, userId: number | null): Promise<void> {
  const runtime = runtimes.get(sessionId)
  if (runtime?.sock) {
    try {
      await runtime.sock.logout()
    } catch {
      // Socket may already be closed; fall through to clearing local state regardless.
    }
    runtime.sock = null
  }
  await clearAuthState(sessionId)
  await recordAuditLog({ userId, action: 'whatsapp_manual_disconnect', entityType: 'whatsapp_connection', entityId: sessionId })
}

// Only allowed once a session is fully disconnected — removes its DB row
// and local auth state entirely. Tasks it created keep their
// created_by_session_id pointing at nothing (set null), never deleted.
export async function deleteSession(sessionId: number): Promise<void> {
  const runtime = runtimes.get(sessionId)
  if (runtime && runtime.snapshot.status !== 'disconnected') {
    throw new Error('Disconnect this session before removing it.')
  }
  runtimes.delete(sessionId)
  await fs.promises.rm(authDirFor(sessionId), { recursive: true, force: true })
  await db.deleteFrom('whatsapp_sessions').where('id', '=', sessionId).execute()
}

export function maskPhoneNumber(phoneNumber: string | null): string | null {
  if (!phoneNumber) return null
  if (phoneNumber.length <= 4) return phoneNumber
  return `${'•'.repeat(phoneNumber.length - 4)}${phoneNumber.slice(-4)}`
}

// Called once at boot to resume every previously-created session (across
// every organization) using whatever auth state it already saved to disk —
// a session with no saved creds yet just comes up at qr_pending.
export async function bootAllSessions(): Promise<void> {
  const rows = await db.selectFrom('whatsapp_sessions').selectAll().execute()
  for (const row of rows) {
    ensureRuntime(row)
  }
  for (const row of rows) {
    void startConnection(row.id).catch((err) => {
      logger.error({ err, sessionId: row.id }, 'failed to start WhatsApp session on boot')
    })
  }
}
