import crypto from 'node:crypto'
import { downloadMediaMessage, type WASocket, type WAMessage } from '@whiskeysockets/baileys'
import pino from 'pino'
import { db } from '../db/index.js'
import { isProduction } from '../config/env.js'
import { uploadObject } from '../lib/s3.js'
import { resolveContactId } from './taskEngine.js'
import { chatMessageEvents } from './chatEvents.js'
import { normalizeInboundRow } from '../modules/chat/normalize.js'
import type { MessageType } from '../db/schema.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

interface MappedContent {
  messageType: MessageType
  messageText: string | null
  mediaBuffer: Buffer | null
  mediaMimetype: string | null
}

async function mapContent(sock: WASocket, m: WAMessage): Promise<MappedContent | null> {
  const msg = m.message
  if (!msg) return null

  const text = msg.conversation ?? msg.extendedTextMessage?.text
  if (text) return { messageType: 'text', messageText: text, mediaBuffer: null, mediaMimetype: null }

  const mediaByType: { type: MessageType; content: { caption?: string | null; mimetype?: string | null } | null | undefined }[] = [
    { type: 'image', content: msg.imageMessage },
    { type: 'video', content: msg.videoMessage },
    { type: 'audio', content: msg.audioMessage },
    { type: 'document', content: msg.documentMessage }
  ]

  for (const { type, content } of mediaByType) {
    if (!content) continue
    try {
      const buffer = await downloadMediaMessage(m, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage, logger })
      return { messageType: type, messageText: content.caption ?? null, mediaBuffer: buffer, mediaMimetype: content.mimetype ?? null }
    } catch (err) {
      logger.warn({ err, key: m.key, type }, 'failed downloading inbound chat media — persisting as a placeholder')
      return { messageType: 'text', messageText: '[Media could not be downloaded]', mediaBuffer: null, mediaMimetype: null }
    }
  }

  // Not a type this feature stores (reaction, protocol/system message,
  // sender-key distribution, etc.) — nothing to persist.
  return null
}

// Persists the inbound (and rare manually-sent-from-phone outbound) half of
// a contact's chat thread, and notifies any open Chat page via SSE. Called
// from connectionManager.ts's messages.upsert handler alongside (not
// instead of) the existing task/command engines — this never affects their
// behavior.
export async function persistChatMessage(sock: WASocket, m: WAMessage, organizationId: number | null): Promise<void> {
  if (!organizationId || !m.key.remoteJid || !m.key.id) return

  const contactId = await resolveContactId(sock, m.key.remoteJid, organizationId)
  // Grants are per-contact — a number with no saved contact can never be
  // granted or shown in Chats, so there is nothing useful to persist for it.
  if (!contactId) return

  if (m.key.fromMe) {
    // Already visible via the `messages` side of the thread if this app
    // queued it — only a fromMe message with no matching `messages` row
    // (sent manually from the linked phone, outside the portal) belongs here.
    const alreadyQueued = await db
      .selectFrom('messages')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('wa_message_id', '=', m.key.id)
      .executeTakeFirst()
    if (alreadyQueued) return
  }

  const existing = await db
    .selectFrom('chat_messages')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('wa_message_id', '=', m.key.id)
    .executeTakeFirst()
  if (existing) return

  const mapped = await mapContent(sock, m)
  if (!mapped) return

  let mediaPath: string | null = null
  if (mapped.mediaBuffer) {
    const key = crypto.randomUUID()
    await uploadObject(key, mapped.mediaBuffer, mapped.mediaMimetype ?? 'application/octet-stream')
    mediaPath = key
  }

  const inserted = await db
    .insertInto('chat_messages')
    .values({
      organization_id: organizationId,
      contact_id: contactId,
      direction: m.key.fromMe ? 'outbound' : 'inbound',
      message_type: mapped.messageType,
      message_text: mapped.messageText,
      media_path: mediaPath,
      media_mimetype: mapped.mediaMimetype,
      wa_message_id: m.key.id
    })
    .onConflict((oc) => oc.columns(['organization_id', 'wa_message_id']).doNothing())
    .returningAll()
    .executeTakeFirst()

  if (!inserted) return

  chatMessageEvents.emit('message', {
    organizationId,
    contactId,
    message: await normalizeInboundRow(inserted)
  })
}
