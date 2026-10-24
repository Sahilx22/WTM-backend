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
import { logger } from '../lib/logger.js'
import { health, recordIncident, errorMessage } from '../lib/systemHealth.js'
import {
  groupMetadataCache,
  msgRetryCounterCache,
  getCachedMessage,
  upsertGroupMetadata,
  upsertContactsFromWhatsApp
} from './store.js'
import { handleMessageForTasks } from './taskEngine.js'
import { handleCommandMessage } from './commandEngine.js'
import { persistChatMessage } from './chatMessages.js'
import { handleRecurringReminderMessage } from './recurringReminderEngine.js'
import { handleReportSubmissionMessage } from './reportSubmissionEngine.js'
import { handleAiMessage, isAiRequest } from './aiEngine.js'
import type { ConnectionStatus, WhatsappSession } from '../db/schema.js'

// Handed to Baileys itself only — its internals log constantly at info/warn
// (every decrypt retry, every prekey upload), so it stays at 'error'. Our
// own connection-lifecycle events go through the shared app `logger`.
const baileysLogger = pino({ level: isProduction ? 'error' : 'warn' })

// Reconnect backoff after an unexpected close: 3s, 6s, 12s … capped at 60s,
// reset on every successful open. Never gives up — the session watchdog
// (whatsapp/watchdog.ts) is the second line of defence if this chain is
// ever broken.
const RECONNECT_BASE_DELAY_MS = 3_000
const RECONNECT_MAX_DELAY_MS = 60_000

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
  reconnectAttempts: number
  // When this session last left 'connected' in this process — used by the
  // watchdog to tell a brief blip apart from a real outage.
  disconnectedSince: number | null
}

const runtimes = new Map<number, SessionRuntime>()

export const connectionEvents = new EventEmitter()
export const messageAckEvents = new EventEmitter()

function authDirFor(sessionId: number): string {
  return path.join(AUTH_SESSIONS_DIR, String(sessionId))
}

// A row's persisted 'connected' only means "connected as of the last
// process that touched it" — no socket exists in THIS process until
// startConnection() opens one. Reporting that stale status is how the UI
// once showed "connected" for days while nothing was actually running, so
// it's downgraded here until a live socket really opens.
function snapshotFromRow(row: WhatsappSession): SessionSnapshot {
  const stale = row.status === 'connected' || row.status === 'connecting'
  return {
    sessionId: row.id,
    organizationId: row.organization_id,
    label: row.label,
    isPrimary: row.is_primary,
    status: stale ? 'disconnected' : row.status,
    qrDataUrl: null,
    phoneNumber: row.phone_number,
    waJid: row.wa_jid,
    lastDisconnectReason: stale ? 'Not reconnected since the server restarted' : row.last_disconnect_reason
  }
}

function ensureRuntime(row: WhatsappSession): SessionRuntime {
  let runtime = runtimes.get(row.id)
  if (!runtime) {
    runtime = {
      sock: null,
      snapshot: snapshotFromRow(row),
      starting: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      disconnectedSince: Date.now()
    }
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

// Resolves the socket every reminder/auto-report/send for a *specific*
// organization goes out through: whichever of that org's own sessions is
// flagged primary *and* currently connected. Every outgoing-send call site
// must pass the organization the message/task/report actually belongs to —
// never falls back to some other organization's session, even if that one
// happens to be connected and this one isn't (see the former getPrimarySocket()
// this replaced, which scanned every organization's runtimes and could
// route one org's outgoing message through a completely different org's
// WhatsApp number).
export function getPrimarySocketForOrganization(organizationId: number): WASocket | null {
  for (const r of runtimes.values()) {
    if (r.snapshot.organizationId === organizationId && r.snapshot.isPrimary && r.snapshot.status === 'connected' && r.sock) {
      return r.sock
    }
  }
  return null
}

// Every session of one organization that is *actually* connected right now
// — judged by the live runtime (a real socket, status 'connected'), never
// by the last status persisted in the database, which can say "connected"
// for a session this process hasn't (re)connected. Primary first.
export function getConnectedSessionsForOrganization(organizationId: number): SessionSnapshot[] {
  const connected: SessionSnapshot[] = []
  for (const r of runtimes.values()) {
    if (r.snapshot.organizationId === organizationId && r.snapshot.status === 'connected' && r.sock) {
      connected.push(r.snapshot)
    }
  }
  return connected.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sessionId - b.sessionId)
}

// The live socket for one *specific* session, only if that session belongs
// to `organizationId` and is connected right now — null otherwise. Used
// where a send must go out through exactly the number the admin picked
// (campaigns), with no silent fallback to a different session.
export function getConnectedSocketForSession(sessionId: number, organizationId: number): WASocket | null {
  const r = runtimes.get(sessionId)
  if (!r || r.snapshot.organizationId !== organizationId || r.snapshot.status !== 'connected' || !r.sock) return null
  return r.sock
}

// The connected primary session's own snapshot for one organization — used
// wherever a job needs to send *to* the admin's own number (auto-reports),
// not just through it.
export function getPrimarySnapshotForOrganization(organizationId: number): SessionSnapshot | null {
  for (const r of runtimes.values()) {
    if (r.snapshot.organizationId === organizationId && r.snapshot.isPrimary && r.snapshot.status === 'connected' && r.sock) {
      return r.snapshot
    }
  }
  return null
}

// Whether *any* session, for any organization, is currently connected — used
// by queue/lifecycle.ts to decide whether pg-boss (reminders, auto-reports,
// digests, the outgoing-message queue) has anything to do at all right now.
export function isAnySessionConnected(): boolean {
  return [...runtimes.values()].some((r) => r.snapshot.status === 'connected' && r.sock)
}

// Every organization that currently has a connected primary session — used
// by jobs that must sweep every tenant (auto-reports/digests at boot, and
// after any settings change) rather than act on just one.
export function listConnectedPrimaryOrganizationIds(): number[] {
  const ids = new Set<number>()
  for (const r of runtimes.values()) {
    if (r.snapshot.isPrimary && r.snapshot.status === 'connected' && r.sock) ids.add(r.snapshot.organizationId)
  }
  return [...ids]
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
  const wasConnected = runtime.snapshot.status === 'connected'
  runtime.snapshot = { ...runtime.snapshot, ...partial }
  if (runtime.snapshot.status === 'connected') {
    runtime.disconnectedSince = null
  } else if (wasConnected || runtime.disconnectedSince === null) {
    runtime.disconnectedSince = Date.now()
  }
  connectionEvents.emit('update', runtime.snapshot)
  persistSnapshot(sessionId).catch((err) => {
    logger.error({ err, sessionId }, 'failed to persist WhatsApp session status')
  })
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
  // On a fresh process boot, ensureRuntime() seeds the snapshot straight
  // from the DB row (snapshotFromRow) — which can still say 'connected'
  // from before this process started, even though `runtime.sock` is null
  // and no socket has ever been created in THIS process. Trusting that
  // stale status alone used to skip reconnecting entirely, leaving every
  // session that was connected at the last restart permanently zombied
  // (DB says "connected" forever, but nothing is ever sent or received)
  // until something else forced a reconnect. Requiring a real, live
  // `runtime.sock` alongside the 'connected' status is what actually makes
  // this "don't reconnect, we're already connected" — not just "the last
  // process to touch this row happened to leave it saying connected".
  if (runtime.starting || (runtime.snapshot.status === 'connected' && runtime.sock)) return
  runtime.starting = true

  try {
    const authDir = authDirFor(sessionId)
    fs.mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      logger: baileysLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
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

    // Every branch below is wrapped so a failing DB write (audit log,
    // primary lookup) can never stop the in-memory status from updating —
    // previously a rejected query here could leave an open socket stuck at
    // 'connecting', which keeps the reminder/report queues paused.
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      const label = runtime.snapshot.label
      const organizationId = runtime.snapshot.organizationId

      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr)
          updateSnapshot(sessionId, { status: 'qr_pending', qrDataUrl })
        } catch (err) {
          logger.error({ err, sessionId }, 'failed to render WhatsApp QR code')
        }
        logger.info({ sessionId, organizationId, label }, 'WhatsApp session is waiting for a QR scan')
      }

      if (connection === 'connecting') {
        updateSnapshot(sessionId, { status: 'connecting' })
      } else if (connection === 'open') {
        const rawId = sock.user?.id
        const decoded = rawId ? jidDecode(rawId) : null

        // First session this organization has ever successfully connected
        // becomes (and permanently stays) primary. If the lookup fails, keep
        // whatever primary flag we already had rather than blocking connect.
        let isPrimary = runtime.snapshot.isPrimary
        try {
          const existingPrimary = await db
            .selectFrom('whatsapp_sessions')
            .select('id')
            .where('organization_id', '=', organizationId)
            .where('is_primary', '=', true)
            .executeTakeFirst()
          isPrimary = runtime.snapshot.isPrimary || !existingPrimary
        } catch (err) {
          logger.error({ err, sessionId }, 'failed to look up primary session on connect — keeping existing primary flag')
        }

        runtime.reconnectAttempts = 0
        updateSnapshot(sessionId, {
          status: 'connected',
          qrDataUrl: null,
          phoneNumber: decoded?.user ?? null,
          waJid: rawId ? jidNormalizedUser(rawId) : null,
          lastDisconnectReason: null,
          isPrimary
        })
        logger.info({ sessionId, organizationId, label, isPrimary }, 'WhatsApp session connected')
        recordAuditLog({ userId: null, action: 'whatsapp_connected', entityType: 'whatsapp_connection', entityId: sessionId }).catch(
          (err) => logger.error({ err, sessionId }, 'failed to write whatsapp_connected audit log')
        )
      } else if (connection === 'close') {
        const boomError = lastDisconnect?.error as Boom | undefined
        const statusCode = boomError?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut
        const reason = boomError?.message ?? 'Connection closed'
        if (runtime.sock === sock) runtime.sock = null

        updateSnapshot(sessionId, {
          status: 'disconnected',
          qrDataUrl: null,
          lastDisconnectReason: reason
        })

        if (loggedOut) {
          logger.warn({ sessionId, organizationId, label, statusCode, reason }, 'WhatsApp session was logged out — it must be re-linked by scanning a new QR code')
          recordIncident('session_logged_out', `Session ${sessionId} (${label ?? 'unlabelled'}) was logged out by WhatsApp — needs a new QR scan`, {
            sessionId,
            organizationId,
            statusCode,
            reason
          })
          try {
            await clearAuthState(sessionId)
            await recordAuditLog({ userId: null, action: 'whatsapp_logged_out', entityType: 'whatsapp_connection', entityId: sessionId, metadata: { statusCode, reason } })
          } catch (err) {
            logger.error({ err, sessionId }, 'failed to clean up after WhatsApp logout')
          }
        } else {
          logger.warn({ sessionId, organizationId, label, statusCode, reason }, 'WhatsApp session disconnected — scheduling reconnect')
          recordIncident('session_disconnected', `Session ${sessionId} (${label ?? 'unlabelled'}) disconnected: ${reason}`, {
            sessionId,
            organizationId,
            statusCode
          })
          scheduleReconnect(sessionId)
        }
      }
    })

    sock.ev.on('groups.upsert', async (groups) => {
      for (const group of groups) {
        await upsertGroupMetadata(group, runtime.snapshot.organizationId, runtime.snapshot.waJid ?? undefined)
      }
    })

    sock.ev.on('groups.update', async (updates) => {
      for (const update of updates) {
        if (!update.id) continue
        try {
          const metadata = await sock.groupMetadata(update.id)
          await upsertGroupMetadata(metadata, runtime.snapshot.organizationId, runtime.snapshot.waJid ?? undefined)
        } catch (err) {
          logger.warn({ err, jid: update.id }, 'failed to refresh group metadata after groups.update')
        }
      }
    })

    sock.ev.on('group-participants.update', async (event) => {
      try {
        const metadata = await sock.groupMetadata(event.id)
        await upsertGroupMetadata(metadata, runtime.snapshot.organizationId, runtime.snapshot.waJid ?? undefined)
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
        // An "@ai" message is handled only by the assistant (in the
        // background — see handleAiMessage), never also as a #task, #sced
        // or command, so one message can't create something twice.
        if (runtime.snapshot.waJid && isAiRequest(m, runtime.snapshot.waJid)) {
          handleAiMessage(sock, m, sessionId, runtime.snapshot.organizationId, runtime.snapshot.waJid)
          try {
            await persistChatMessage(sock, m, runtime.snapshot.organizationId)
          } catch (err) {
            logger.warn({ err, key: m.key }, 'failed persisting chat message')
          }
          continue
        }
        try {
          await handleMessageForTasks(sock, m, sessionId, runtime.snapshot.organizationId)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for task engine')
        }
        try {
          await handleRecurringReminderMessage(sock, m, sessionId, runtime.snapshot.organizationId)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for recurring reminder engine')
        }
        try {
          await handleCommandMessage(sock, runtime.snapshot.waJid, m, runtime.snapshot.organizationId)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for command engine')
        }
        try {
          await handleReportSubmissionMessage(sock, m, runtime.snapshot.organizationId)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for report submission engine')
        }
        try {
          await persistChatMessage(sock, m, runtime.snapshot.organizationId)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed persisting chat message')
        }
      }
    })

    sock.ev.on('messaging-history.set', async ({ contacts }) => {
      if (contacts.length === 0) return
      try {
        const imported = await upsertContactsFromWhatsApp(contacts, runtime.snapshot.organizationId)
        logger.info({ sessionId, received: contacts.length, imported }, 'synced contacts from WhatsApp history')
      } catch (err) {
        logger.warn({ err }, 'failed to sync contacts from history batch')
      }
    })

    sock.ev.on('contacts.upsert', async (contacts) => {
      try {
        await upsertContactsFromWhatsApp(contacts, runtime.snapshot.organizationId)
      } catch (err) {
        logger.warn({ err }, 'failed to sync contacts.upsert')
      }
    })

    sock.ev.on('contacts.update', async (updates) => {
      const complete = updates.filter((u): u is typeof u & { id: string } => Boolean(u.id))
      if (complete.length === 0) return
      try {
        await upsertContactsFromWhatsApp(complete, runtime.snapshot.organizationId)
      } catch (err) {
        logger.warn({ err }, 'failed to sync contacts.update')
      }
    })
  } finally {
    runtime.starting = false
  }
}

// Retries with exponential backoff until a connection attempt succeeds. A
// failed attempt (e.g. the database is briefly unreachable, so
// startConnection()'s first query rejects) used to be an unhandled
// rejection that silently ended the reconnect chain for good — now it's
// logged and simply retried.
function scheduleReconnect(sessionId: number): void {
  const runtime = runtimes.get(sessionId)
  if (!runtime || runtime.reconnectTimer || shuttingDownSockets) return
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** runtime.reconnectAttempts, RECONNECT_MAX_DELAY_MS)
  runtime.reconnectAttempts += 1
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null
    startConnection(sessionId).catch((err) => {
      logger.error({ err, sessionId, attempt: runtime.reconnectAttempts }, 'WhatsApp reconnect attempt failed — retrying')
      recordIncident('session_reconnect_failed', `Session ${sessionId} reconnect attempt ${runtime.reconnectAttempts} failed: ${errorMessage(err)}`, {
        sessionId
      })
      scheduleReconnect(sessionId)
    })
  }, delay)
}

// Used by the watchdog — true once this session has ever completed QR
// linking (Baileys has written its creds). A session without them can only
// be fixed by a human scanning a QR, so there's nothing to auto-retry.
export function hasSavedCreds(sessionId: number): boolean {
  return fs.existsSync(path.join(authDirFor(sessionId), 'creds.json'))
}

export interface RuntimeState {
  sessionId: number
  organizationId: number
  label: string | null
  isPrimary: boolean
  status: ConnectionStatus
  hasSocket: boolean
  starting: boolean
  reconnectPending: boolean
  reconnectAttempts: number
  disconnectedSince: number | null
  lastDisconnectReason: string | null
}

export function listRuntimeStates(): RuntimeState[] {
  return [...runtimes.values()].map((r) => ({
    sessionId: r.snapshot.sessionId,
    organizationId: r.snapshot.organizationId,
    label: r.snapshot.label,
    isPrimary: r.snapshot.isPrimary,
    status: r.snapshot.status,
    hasSocket: Boolean(r.sock),
    starting: r.starting,
    reconnectPending: Boolean(r.reconnectTimer),
    reconnectAttempts: r.reconnectAttempts,
    disconnectedSince: r.disconnectedSince,
    lastDisconnectReason: r.snapshot.lastDisconnectReason
  }))
}

// Watchdog entry point: picks up sessions this process doesn't know about
// yet (e.g. created while boot was still retrying) and kicks a reconnect
// for any linked session that has silently fallen out of its retry chain.
export async function reviveStalledSessions(): Promise<number[]> {
  const rows = await db.selectFrom('whatsapp_sessions').selectAll().execute()
  const revived: number[] = []
  for (const row of rows) {
    const runtime = ensureRuntime(row)
    const live = runtime.snapshot.status === 'connected' && runtime.sock
    const busy = runtime.starting || runtime.reconnectTimer || runtime.snapshot.status === 'connecting'
    if (live || busy || !hasSavedCreds(row.id)) continue
    revived.push(row.id)
    scheduleReconnect(row.id)
  }
  return revived
}

async function clearAuthState(sessionId: number): Promise<void> {
  const authDir = authDirFor(sessionId)
  await fs.promises.rm(authDir, { recursive: true, force: true })
  await fs.promises.mkdir(authDir, { recursive: true })
  updateSnapshot(sessionId, { status: 'disconnected', qrDataUrl: null, phoneNumber: null, waJid: null })
}

export async function requestConnect(sessionId: number): Promise<void> {
  const runtime = runtimes.get(sessionId)
  // Same stale-status caveat as startConnection() above: only a 'connected'
  // status backed by an actual live socket should block a manual reconnect.
  if (runtime && ((runtime.snapshot.status === 'connected' && runtime.sock) || runtime.snapshot.status === 'connecting' || runtime.starting)) return
  await startConnection(sessionId)
}

export async function requestLogout(sessionId: number, userId: number | null): Promise<void> {
  // Make sure a runtime exists even if this process never booted the
  // session — otherwise clearAuthState()'s status update is a silent no-op
  // and the database keeps reporting a stale 'connected'.
  const row = await db.selectFrom('whatsapp_sessions').selectAll().where('id', '=', sessionId).executeTakeFirst()
  const runtime = row ? ensureRuntime(row) : runtimes.get(sessionId)
  if (runtime?.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer)
    runtime.reconnectTimer = null
  }
  logger.warn({ sessionId, userId }, 'WhatsApp session manually disconnected — saved login cleared, needs a new QR scan')
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
  logger.info({ sessions: rows.map((r) => ({ id: r.id, org: r.organization_id, label: r.label, linked: hasSavedCreds(r.id) })) }, 'booting WhatsApp sessions')
  for (const row of rows) {
    startConnection(row.id).catch((err) => {
      logger.error({ err, sessionId: row.id }, 'failed to start WhatsApp session on boot — scheduling retry')
      scheduleReconnect(row.id)
    })
  }
}

const BOOT_RETRY_BASE_DELAY_MS = 5_000
const BOOT_RETRY_MAX_DELAY_MS = 60_000

// The production outage this guards against: the process crashed on a
// dropped database connection, Docker restarted it while the database was
// still refusing connections, and the one-shot bootAllSessions() call
// failed — leaving the HTTP server up and "healthy" but with zero WhatsApp
// sockets for days. This keeps retrying (5s, 10s, 20s … capped at 60s)
// until the boot query succeeds, recording every failure where
// /api/health and the logs can show it.
export async function bootAllSessionsWithRetry(): Promise<void> {
  for (;;) {
    if (shuttingDownSockets) return
    health.sessionsBoot.attempts += 1
    try {
      await bootAllSessions()
      health.sessionsBoot.ok = true
      health.sessionsBoot.succeededAt = new Date().toISOString()
      if (health.sessionsBoot.attempts > 1) {
        logger.warn({ attempts: health.sessionsBoot.attempts }, 'WhatsApp session boot succeeded after retrying')
        recordIncident('session_boot_recovered', `WhatsApp session boot succeeded after ${health.sessionsBoot.attempts} attempts`, {
          lastError: health.sessionsBoot.lastError
        })
      }
      return
    } catch (err) {
      const attempt = health.sessionsBoot.attempts
      const delay = Math.min(BOOT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), BOOT_RETRY_MAX_DELAY_MS)
      health.sessionsBoot.lastError = errorMessage(err)
      health.sessionsBoot.lastErrorAt = new Date().toISOString()
      logger.error({ err, attempt, retryInMs: delay }, 'WhatsApp session boot failed — retrying')
      recordIncident('session_boot_failed', `WhatsApp session boot attempt ${attempt} failed: ${errorMessage(err)}`, { retryInMs: delay })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

// Called once, from server.ts's graceful shutdown, before the Postgres pool
// closes. Cancels any pending reconnect timers first (so a timer firing
// mid-shutdown can't kick off a fresh connection attempt — and a fresh DB
// query — after the pool is already gone), then best-effort closes every
// live socket. Never throws: a socket that won't close cleanly shouldn't
// block process exit, and this intentionally does NOT touch the database —
// no session status is persisted here, since bootAllSessions() will just
// resume from saved auth state on the next boot regardless.
let shuttingDownSockets = false

export function shutdownAllSockets(): void {
  shuttingDownSockets = true
  for (const runtime of runtimes.values()) {
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer)
      runtime.reconnectTimer = null
    }
    if (runtime.sock) {
      try {
        runtime.sock.end(undefined)
      } catch (err) {
        logger.warn({ err, sessionId: runtime.snapshot.sessionId }, 'error closing WhatsApp socket during shutdown')
      }
    }
  }
}
