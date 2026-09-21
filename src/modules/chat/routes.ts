import { Router } from 'express'
import type { WASocket } from '@whiskeysockets/baileys'
import { db } from '../../db/index.js'
import { requireContactAccess } from '../../auth/contactAccess.js'
import { chatSendMessageSchema } from './schemas.js'
import { normalizeOutboundRow, normalizeInboundRow } from './normalize.js'
import { resolveMedia } from '../messages/shared.js'
import { mediaUpload } from '../../lib/mediaUpload.js'
import { phoneToJid } from '../../lib/phone.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { getPrimarySocketForOrganization } from '../../whatsapp/connectionManager.js'
import { chatMessageEvents } from '../../whatsapp/chatEvents.js'
import { enqueueSendJob } from '../../queue/boss.js'
import { isDoneReply } from '../../whatsapp/taskParser.js'
import { completeTask } from '../../lib/taskCompletion.js'

export const chatRouter = Router()

const THREAD_PAGE_SIZE = 100

// Resolves the contact's WhatsApp JID, verifying via onWhatsApp() and
// persisting it back onto the contact the same way resolveRecipients()
// (modules/messages/shared.ts) already does for the Send page — a chat
// contact may never have had a message sent to it before and so may not
// have a wa_jid on file yet.
async function resolveChatJid(sock: WASocket, contact: { id: number; wa_jid: string | null; phone_number: string }): Promise<string | null> {
  if (contact.wa_jid) return contact.wa_jid

  const results = await sock.onWhatsApp(phoneToJid(contact.phone_number))
  const result = results?.[0]
  if (!result?.exists || !result.jid) return null

  await db.updateTable('contacts').set({ wa_jid: result.jid, is_valid_on_whatsapp: true, updated_at: new Date() }).where('id', '=', contact.id).execute()
  return result.jid
}

// Contacts the caller may open a chat with: for a restricted user, only
// ones they've been granted (see contact_access_grants); for an admin, the
// whole organization's contact list, same as every other admin-facing page.
chatRouter.get('/chat/contacts', async (req, res) => {
  const organizationId = req.user?.organizationId
  if (!organizationId) {
    res.json({ contacts: [] })
    return
  }

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : ''
  const like = search ? `%${search}%` : null

  if (req.user?.role === 'restricted') {
    let query = db
      .selectFrom('contact_access_grants')
      .innerJoin('contacts', 'contacts.id', 'contact_access_grants.contact_id')
      .select(['contacts.id', 'contacts.display_name', 'contacts.phone_number'])
      .where('contact_access_grants.organization_id', '=', organizationId)
      .where('contact_access_grants.user_id', '=', req.user.id)
      .orderBy('contacts.display_name', 'asc')
      .orderBy('contacts.phone_number', 'asc')

    if (like) {
      query = query.where((eb) => eb.or([eb('contacts.display_name', 'ilike', like), eb('contacts.phone_number', 'ilike', like)]))
    }

    const rows = await query.execute()
    res.json({ contacts: rows.map((r) => ({ id: r.id, displayName: r.display_name, phoneNumber: r.phone_number })) })
    return
  }

  let query = db
    .selectFrom('contacts')
    .select(['id', 'display_name', 'phone_number'])
    .where('organization_id', '=', organizationId)
    .orderBy('display_name', 'asc')
    .orderBy('phone_number', 'asc')
    .limit(200)

  if (like) {
    query = query.where((eb) => eb.or([eb('display_name', 'ilike', like), eb('phone_number', 'ilike', like)]))
  }

  const rows = await query.execute()
  res.json({ contacts: rows.map((r) => ({ id: r.id, displayName: r.display_name, phoneNumber: r.phone_number })) })
})

chatRouter.get('/chat/contacts/:contactId/messages', requireContactAccess, async (req, res) => {
  const organizationId = req.user!.organizationId!
  const contactId = Number(req.params.contactId)
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : null

  let outboundQuery = db
    .selectFrom('messages')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('recipient_contact_id', '=', contactId)
    .where('status', '!=', 'cancelled')
    .orderBy('created_at', 'desc')
    .limit(THREAD_PAGE_SIZE)

  let inboundQuery = db
    .selectFrom('chat_messages')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('contact_id', '=', contactId)
    .orderBy('created_at', 'desc')
    .limit(THREAD_PAGE_SIZE)

  if (before && !Number.isNaN(before.getTime())) {
    outboundQuery = outboundQuery.where('created_at', '<', before)
    inboundQuery = inboundQuery.where('created_at', '<', before)
  }

  const [outboundRows, inboundRows] = await Promise.all([outboundQuery.execute(), inboundQuery.execute()])

  const normalized = await Promise.all([...outboundRows.map(normalizeOutboundRow), ...inboundRows.map(normalizeInboundRow)])
  normalized.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  // A full page from either side suggests there may be more/older messages
  // beyond what was fetched — a conservative "maybe more" signal, not exact.
  const hasMore = outboundRows.length === THREAD_PAGE_SIZE || inboundRows.length === THREAD_PAGE_SIZE

  const contact = req.chatContact!
  res.json({
    contact: { id: contact.id, displayName: contact.display_name, phoneNumber: contact.phone_number },
    messages: normalized,
    hasMore
  })
})

chatRouter.post('/chat/contacts/:contactId/messages', requireContactAccess, mediaUpload.single('file'), async (req, res) => {
  const parsed = chatSendMessageSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const { message_type, message_text } = parsed.data
  const organizationId = req.user!.organizationId!
  const contact = req.chatContact!

  if (message_type === 'text' && !message_text) {
    res.status(400).json({ error: 'Enter a message.' })
    return
  }

  const sock = getPrimarySocketForOrganization(organizationId)
  if (!sock) {
    res.status(409).json({ error: 'WhatsApp is not connected. Connect it from the WhatsApp Connection page first.' })
    return
  }

  const jid = await resolveChatJid(sock, contact)
  if (!jid) {
    res.status(400).json({ error: 'This contact does not appear to be on WhatsApp.' })
    return
  }

  const mediaResult = await resolveMedia(message_type, req.file, null, organizationId)
  if (!mediaResult.ok) {
    res.status(400).json({ error: mediaResult.error })
    return
  }

  const inserted = await db
    .insertInto('messages')
    .values({
      recipient_type: 'user',
      recipient_contact_id: contact.id,
      recipient_jid: jid,
      message_type,
      message_text,
      media_path: mediaResult.media.mediaPath,
      media_mimetype: mediaResult.media.mediaMimetype,
      template_id: null,
      status: 'queued',
      source: 'chat',
      created_by: req.user!.id,
      organization_id: organizationId
    })
    .returningAll()
    .executeTakeFirstOrThrow()

  const jobId = await enqueueSendJob(inserted.id)
  if (jobId) {
    await db.updateTable('messages').set({ pg_boss_job_id: jobId }).where('id', '=', inserted.id).execute()
  }

  await recordAuditLog({
    userId: req.user!.id,
    action: 'chat_message_sent',
    entityType: 'contact',
    entityId: contact.id,
    metadata: { messageType: message_type },
    ipAddress: req.ip
  })

  // A message that's just "done" (or a close variant — see isDoneReply)
  // sent from this contact's chat is the portal equivalent of quote-replying
  // "done" to a task on WhatsApp itself (see taskEngine.ts's
  // logTaskNoteIfReply) — the composer here has no quote/reply UI, but since
  // the whole thread is already scoped to one contact there's no ambiguity
  // about who it's for. Only acts when exactly one active task exists for
  // this contact; with more than one there's no way to tell which was
  // meant, and completing the wrong one would be worse than completing none.
  if (message_type === 'text' && message_text && isDoneReply(message_text)) {
    const activeTasks = await db
      .selectFrom('tasks')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('contact_id', '=', contact.id)
      .where('status', 'in', ['pending', 'needs_review'])
      .execute()

    if (activeTasks.length === 1) {
      await completeTask(activeTasks[0]!, { userId: req.user!.id, via: 'chat_message_done', ipAddress: req.ip })
    }
  }

  res.status(201).json({ message: await normalizeOutboundRow(inserted) })
})

chatRouter.get('/chat/contacts/:contactId/stream', requireContactAccess, (req, res) => {
  const organizationId = req.user!.organizationId!
  const contactId = Number(req.params.contactId)

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.flushHeaders()

  const listener = (evt: { organizationId: number; contactId: number; message: unknown }) => {
    if (evt.organizationId === organizationId && evt.contactId === contactId) {
      res.write(`event: message\ndata: ${JSON.stringify(evt.message)}\n\n`)
    }
  }
  chatMessageEvents.on('message', listener)

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000)

  req.on('close', () => {
    clearInterval(heartbeat)
    chatMessageEvents.off('message', listener)
  })
})
