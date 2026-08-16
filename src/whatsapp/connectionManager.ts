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
import { AUTH_DIR } from '../config/paths.js'
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
import type { ConnectionStatus } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

export interface ConnectionSnapshot {
  status: ConnectionStatus
  qrDataUrl: string | null
  phoneNumber: string | null
  waJid: string | null
  lastDisconnectReason: string | null
}

let sock: WASocket | null = null
let snapshot: ConnectionSnapshot = {
  status: 'disconnected',
  qrDataUrl: null,
  phoneNumber: null,
  waJid: null,
  lastDisconnectReason: null
}
let starting = false
let reconnectTimer: NodeJS.Timeout | null = null

export const connectionEvents = new EventEmitter()
export const messageAckEvents = new EventEmitter()

export function getSnapshot(): ConnectionSnapshot {
  return snapshot
}

export function getSocket(): WASocket | null {
  return sock
}

async function persistSnapshot(): Promise<void> {
  await db
    .updateTable('whatsapp_connection')
    .set({
      status: snapshot.status,
      phone_number: snapshot.phoneNumber,
      wa_jid: snapshot.waJid,
      connected_at: snapshot.status === 'connected' ? new Date() : undefined,
      last_disconnect_reason: snapshot.lastDisconnectReason,
      updated_at: new Date()
    })
    .where('id', '=', 1)
    .execute()
}

function updateSnapshot(partial: Partial<ConnectionSnapshot>): void {
  snapshot = { ...snapshot, ...partial }
  connectionEvents.emit('update', snapshot)
  void persistSnapshot()
}

export async function startConnection(): Promise<void> {
  if (starting || snapshot.status === 'connected') return
  starting = true

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      // syncFullHistory is what unlocks a real contacts sync from WhatsApp.
      // Browsers.macOS('Desktop') is the officially-documented pairing for
      // "more history", but as of this WhatsApp server version it gets
      // rejected outright (428 Precondition Required, verified via a raw
      // debug connection) — Ubuntu works fine and still receives full
      // history with syncFullHistory: true, so we stick with it.
      browser: Browsers.ubuntu('WA Messenger'),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      msgRetryCounterCache,
      cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
      getMessage: async (key) => getCachedMessage(key)
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        const qrDataUrl = await qrcode.toDataURL(qr)
        updateSnapshot({ status: 'qr_pending', qrDataUrl })
      }

      if (connection === 'connecting') {
        updateSnapshot({ status: 'connecting' })
      } else if (connection === 'open') {
        const rawId = sock?.user?.id
        const decoded = rawId ? jidDecode(rawId) : null
        updateSnapshot({
          status: 'connected',
          qrDataUrl: null,
          phoneNumber: decoded?.user ?? null,
          waJid: rawId ? jidNormalizedUser(rawId) : null,
          lastDisconnectReason: null
        })
        await recordAuditLog({ userId: null, action: 'whatsapp_connected', entityType: 'whatsapp_connection' })
      } else if (connection === 'close') {
        const boomError = lastDisconnect?.error as Boom | undefined
        const statusCode = boomError?.output?.statusCode
        const loggedOut = statusCode === DisconnectReason.loggedOut

        updateSnapshot({
          status: 'disconnected',
          qrDataUrl: null,
          lastDisconnectReason: boomError?.message ?? 'Connection closed'
        })

        if (loggedOut) {
          await clearAuthState()
          await recordAuditLog({ userId: null, action: 'whatsapp_logged_out', entityType: 'whatsapp_connection' })
        } else {
          scheduleReconnect()
        }
      }
    })

    sock.ev.on('groups.upsert', async (groups) => {
      for (const group of groups) {
        await upsertGroupMetadata(group, snapshot.waJid ?? undefined)
      }
    })

    sock.ev.on('groups.update', async (updates) => {
      for (const update of updates) {
        if (!update.id || !sock) continue
        try {
          const metadata = await sock.groupMetadata(update.id)
          await upsertGroupMetadata(metadata, snapshot.waJid ?? undefined)
        } catch (err) {
          logger.warn({ err, jid: update.id }, 'failed to refresh group metadata after groups.update')
        }
      }
    })

    sock.ev.on('group-participants.update', async (event) => {
      if (!sock) return
      try {
        const metadata = await sock.groupMetadata(event.id)
        await upsertGroupMetadata(metadata, snapshot.waJid ?? undefined)
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
          if (sock) await handleMessageForTasks(sock, m)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for task engine')
        }
        try {
          if (sock) await handleCommandMessage(sock, snapshot.waJid, m)
        } catch (err) {
          logger.warn({ err, key: m.key }, 'failed processing message for command engine')
        }
      }
    })

    sock.ev.on('messaging-history.set', async ({ contacts }) => {
      if (contacts.length === 0) return
      try {
        const imported = await upsertContactsFromWhatsApp(contacts)
        logger.info({ received: contacts.length, imported }, 'synced contacts from WhatsApp history')
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
    starting = false
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void startConnection()
  }, 3000)
}

async function clearAuthState(): Promise<void> {
  await fs.promises.rm(AUTH_DIR, { recursive: true, force: true })
  await fs.promises.mkdir(AUTH_DIR, { recursive: true })
  updateSnapshot({ status: 'disconnected', qrDataUrl: null, phoneNumber: null, waJid: null })
}

export async function requestConnect(): Promise<void> {
  if (snapshot.status === 'connected' || snapshot.status === 'connecting' || starting) return
  await startConnection()
}

export async function requestLogout(userId: number | null): Promise<void> {
  if (sock) {
    try {
      await sock.logout()
    } catch {
      // Socket may already be closed; fall through to clearing local state regardless.
    }
  }
  sock = null
  await clearAuthState()
  await recordAuditLog({ userId, action: 'whatsapp_manual_disconnect', entityType: 'whatsapp_connection' })
}

export function maskPhoneNumber(phoneNumber: string | null): string | null {
  if (!phoneNumber) return null
  if (phoneNumber.length <= 4) return phoneNumber
  return `${'•'.repeat(phoneNumber.length - 4)}${phoneNumber.slice(-4)}`
}

// Ensures AUTH_DIR exists even before the first connection attempt.
fs.mkdirSync(path.dirname(AUTH_DIR), { recursive: true })
