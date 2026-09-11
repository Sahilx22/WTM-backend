import type { WASocket } from '@whiskeysockets/baileys'
import { db } from '../../db/index.js'
import { normalizePhoneDigits, isValidPhoneDigits, phoneToJid } from '../../lib/phone.js'
import { validateMediaFile, copyUploadedFile, uploadMediaToS3 } from '../../lib/mediaUpload.js'
import type { MessageType } from '../../db/schema.js'

export interface Recipient {
  jid: string
  recipientType: 'user' | 'group'
  contactId: number | null
  groupId: number | null
}

export interface ResolveRecipientsInput {
  recipientType: 'user' | 'group'
  contactIds: number[]
  rawNumbers: string
  groupIds: number[]
}

export interface ResolveRecipientsResult {
  recipients: Recipient[]
  skipped: string[]
}

// Resolves the selected contacts/raw numbers/groups from a Send or Schedule
// form into concrete WhatsApp JIDs, verifying unknown phone numbers against
// WhatsApp via onWhatsApp() (per the JID guidance: never trust a
// hand-constructed JID — always use the one WhatsApp returns).
// `organizationId` constrains contact/group ids to the caller's own
// organization — never trust a contact_id/group_id from the request body at
// face value, since it may reference another organization's record.
export async function resolveRecipients(
  sock: WASocket,
  input: ResolveRecipientsInput,
  organizationId: number
): Promise<ResolveRecipientsResult> {
  const recipients: Recipient[] = []
  const skipped: string[] = []

  if (input.recipientType === 'user') {
    if (input.contactIds.length > 0) {
      const contacts = await db
        .selectFrom('contacts')
        .selectAll()
        .where('id', 'in', input.contactIds)
        .where('organization_id', '=', organizationId)
        .execute()
      for (const contact of contacts) {
        if (contact.wa_jid) {
          recipients.push({ jid: contact.wa_jid, recipientType: 'user', contactId: contact.id, groupId: null })
          continue
        }
        const results = await sock.onWhatsApp(phoneToJid(contact.phone_number))
        const result = results?.[0]
        if (result?.exists && result.jid) {
          await db
            .updateTable('contacts')
            .set({ wa_jid: result.jid, is_valid_on_whatsapp: true, updated_at: new Date() })
            .where('id', '=', contact.id)
            .execute()
          recipients.push({ jid: result.jid, recipientType: 'user', contactId: contact.id, groupId: null })
        } else {
          await db
            .updateTable('contacts')
            .set({ is_valid_on_whatsapp: false, updated_at: new Date() })
            .where('id', '=', contact.id)
            .execute()
          skipped.push(`${contact.phone_number} (not on WhatsApp)`)
        }
      }
    }

    const seenJids = new Set(recipients.map((r) => r.jid))
    const rawEntries = input.rawNumbers
      .split(/[\n,]/)
      .map((s) => normalizePhoneDigits(s))
      .filter((s) => s.length > 0)

    for (const digits of [...new Set(rawEntries)]) {
      if (!isValidPhoneDigits(digits)) {
        skipped.push(`${digits || '(blank)'} (invalid format)`)
        continue
      }
      const candidateJid = phoneToJid(digits)
      if (seenJids.has(candidateJid)) continue

      const results = await sock.onWhatsApp(candidateJid)
      const result = results?.[0]
      if (result?.exists && result.jid) {
        recipients.push({ jid: result.jid, recipientType: 'user', contactId: null, groupId: null })
        seenJids.add(result.jid)
      } else {
        skipped.push(`${digits} (not on WhatsApp)`)
      }
    }
  } else if (input.groupIds.length > 0) {
    const groups = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', 'in', input.groupIds)
      .where('organization_id', '=', organizationId)
      .execute()
    for (const group of groups) {
      recipients.push({ jid: group.wa_jid, recipientType: 'group', contactId: null, groupId: group.id })
    }
  }

  return { recipients, skipped }
}

// Resolves every contact in a batch to a JID, verifying via onWhatsApp()
// wherever a contact doesn't already have one on file. `organizationId`
// constrains the batch to the caller's own organization — a batch id from
// another organization resolves to zero recipients rather than trusting the
// id alone.
export async function resolveBatchRecipients(
  sock: WASocket,
  batchId: number,
  organizationId: number
): Promise<ResolveRecipientsResult> {
  const members = await db
    .selectFrom('batch_members')
    .innerJoin('contacts', 'contacts.id', 'batch_members.contact_id')
    .innerJoin('batches', 'batches.id', 'batch_members.batch_id')
    .select(['contacts.id', 'contacts.phone_number', 'contacts.wa_jid'])
    .where('batch_id', '=', batchId)
    .where('batches.organization_id', '=', organizationId)
    .execute()

  const recipients: Recipient[] = []
  const skipped: string[] = []

  for (const contact of members) {
    if (contact.wa_jid) {
      recipients.push({ jid: contact.wa_jid, recipientType: 'user', contactId: contact.id, groupId: null })
      continue
    }
    const results = await sock.onWhatsApp(phoneToJid(contact.phone_number))
    const result = results?.[0]
    if (result?.exists && result.jid) {
      await db
        .updateTable('contacts')
        .set({ wa_jid: result.jid, is_valid_on_whatsapp: true, updated_at: new Date() })
        .where('id', '=', contact.id)
        .execute()
      recipients.push({ jid: result.jid, recipientType: 'user', contactId: contact.id, groupId: null })
    } else {
      await db
        .updateTable('contacts')
        .set({ is_valid_on_whatsapp: false, updated_at: new Date() })
        .where('id', '=', contact.id)
        .execute()
      skipped.push(`${contact.phone_number} (not on WhatsApp)`)
    }
  }

  return { recipients, skipped }
}

export interface ResolvedMedia {
  mediaPath: string | null
  mediaMimetype: string | null
}

export type ResolveMediaResult = { ok: true; media: ResolvedMedia } | { ok: false; error: string }

// Determines the media file (or lack thereof) for a message being composed:
// a freshly uploaded file takes priority, falling back to copying a
// template's media so the send has its own independent file.
// `organizationId` constrains `templateId` to the caller's own organization
// — never trust a template_id from the request body at face value.
export async function resolveMedia(
  messageType: MessageType,
  file: Express.Multer.File | undefined,
  templateId: number | null,
  organizationId: number | undefined
): Promise<ResolveMediaResult> {
  if (messageType === 'text') {
    return { ok: true, media: { mediaPath: null, mediaMimetype: null } }
  }

  if (file) {
    const mediaError = validateMediaFile(messageType, file)
    if (mediaError) return { ok: false, error: mediaError }
    const key = await uploadMediaToS3(file)
    return { ok: true, media: { mediaPath: key, mediaMimetype: file.mimetype } }
  }

  if (templateId) {
    let templateQuery = db.selectFrom('message_templates').selectAll().where('id', '=', templateId)
    if (organizationId !== undefined) templateQuery = templateQuery.where('organization_id', '=', organizationId)
    const template = await templateQuery.executeTakeFirst()
    if (!template || template.message_type !== messageType || !template.media_path) {
      return { ok: false, error: 'The selected template has no matching media for this message type.' }
    }
    const key = await copyUploadedFile(template.media_path)
    return {
      ok: true,
      media: { mediaPath: key, mediaMimetype: template.media_mimetype }
    }
  }

  return { ok: false, error: `Attach a ${messageType} file, or choose a template that has one.` }
}
