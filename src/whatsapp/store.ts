import NodeCache from '@cacheable/node-cache'
import {
  areJidsSameUser,
  isLidUser,
  isPnUser,
  jidDecode,
  type CacheStore,
  type Contact,
  type GroupMetadata,
  type GroupParticipant,
  type WAMessageKey,
  type proto
} from '@whiskeysockets/baileys'
import { db } from '../db/index.js'

export const groupMetadataCache = new NodeCache<GroupMetadata>({ stdTTL: 5 * 60, useClones: false })
export const msgRetryCounterCache = new NodeCache() as unknown as CacheStore

export async function cacheOwnMessage(key: WAMessageKey, message: proto.IMessage): Promise<void> {
  if (!key.remoteJid || !key.id) return

  await db
    .insertInto('wa_message_cache')
    .values({
      remote_jid: key.remoteJid,
      message_id: key.id,
      message_json: message as object
    })
    .onConflict((oc) =>
      oc.columns(['remote_jid', 'message_id']).doUpdateSet({ message_json: message as object })
    )
    .execute()
}

export async function getCachedMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
  if (!key.remoteJid || !key.id) return undefined

  const row = await db
    .selectFrom('wa_message_cache')
    .select('message_json')
    .where('remote_jid', '=', key.remoteJid)
    .where('message_id', '=', key.id)
    .executeTakeFirst()

  return row?.message_json as proto.IMessage | undefined
}

// Same PN/LID caveat as self-chat matching: a participant's `id` may be in
// either form depending on the group's addressing mode, and it won't
// string-match `ownJid` if the forms differ — check the paired
// `phoneNumber` field too (device-suffix-safe via areJidsSameUser).
function isOwnParticipant(p: GroupParticipant, ownJid: string): boolean {
  if (areJidsSameUser(p.id, ownJid)) return true
  if (p.phoneNumber && areJidsSameUser(p.phoneNumber, ownJid)) return true
  return false
}

export async function upsertGroupMetadata(metadata: GroupMetadata, ownJid?: string): Promise<void> {
  groupMetadataCache.set(metadata.id, metadata)

  const isAdmin = ownJid
    ? (metadata.participants?.some((p) => isOwnParticipant(p, ownJid) && p.admin != null) ?? false)
    : undefined

  await db
    .insertInto('groups')
    .values({
      wa_jid: metadata.id,
      subject: metadata.subject,
      participant_count: metadata.participants?.length ?? 0,
      is_admin: isAdmin ?? false,
      last_synced_at: new Date()
    })
    .onConflict((oc) =>
      oc.column('wa_jid').doUpdateSet({
        subject: metadata.subject,
        participant_count: metadata.participants?.length ?? 0,
        // Only overwrite is_admin when we actually know our own JID; otherwise leave it as-is.
        ...(isAdmin !== undefined ? { is_admin: isAdmin } : {}),
        last_synced_at: new Date()
      })
    )
    .execute()
}

function resolveContactPhone(contact: Contact): { phoneNumber: string; waJid: string } | null {
  if (!isPnUser(contact.id) && !isLidUser(contact.id)) return null

  // Prefer a phone-number-form JID for the actual digits — either the
  // contact's own id (if it's already PN form) or its paired phoneNumber
  // (when id is a LID). The wa_jid we store is always contact.id itself,
  // since that's the canonical form Baileys expects for sending.
  const pnSource = isPnUser(contact.id) ? contact.id : contact.phoneNumber

  if (!pnSource || !isPnUser(pnSource)) return null

  const decoded = jidDecode(pnSource)
  if (!decoded?.user) return null

  return { phoneNumber: decoded.user, waJid: contact.id }
}

// Contacts arrive passively from Baileys (history sync + incremental
// upsert/update events) — there's no on-demand "fetch all contacts" call
// the way there is for groups. Only contacts we can resolve to an actual
// phone number are imported; a bare LID with no paired PN yet is skipped
// since our contacts table is keyed on phone_number.
export async function upsertContactsFromWhatsApp(contacts: Contact[]): Promise<number> {
  // A single batch can contain more than one Contact entry resolving to the
  // same phone number (e.g. a LID-form and PN-form record for the same
  // person) — Postgres's ON CONFLICT DO UPDATE errors if a multi-row INSERT
  // would touch the same conflict target twice, so dedupe by phone number
  // before building the statement. Later entries win (they're more likely
  // to carry a resolved display name).
  const byPhone = new Map<
    string,
    { phone_number: string; wa_jid: string; display_name: string | null; is_valid_on_whatsapp: true; source: 'whatsapp' }
  >()

  for (const c of contacts) {
    const resolved = resolveContactPhone(c)
    if (!resolved) continue
    const displayName = c.name || c.notify || c.verifiedName || null
    const existing = byPhone.get(resolved.phoneNumber)
    byPhone.set(resolved.phoneNumber, {
      phone_number: resolved.phoneNumber,
      wa_jid: resolved.waJid,
      display_name: displayName ?? existing?.display_name ?? null,
      is_valid_on_whatsapp: true,
      source: 'whatsapp'
    })
  }

  const rows = [...byPhone.values()]

  if (rows.length === 0) return 0

  await db
    .insertInto('contacts')
    .values(rows)
    .onConflict((oc) =>
      oc.column('phone_number').doUpdateSet((eb) => ({
        wa_jid: eb.ref('excluded.wa_jid'),
        is_valid_on_whatsapp: true,
        // Only fill in a name if we didn't already have one — never clobber
        // a name someone entered manually or imported from a CSV.
        display_name: eb.fn.coalesce('contacts.display_name', 'excluded.display_name'),
        updated_at: new Date()
      }))
    )
    .execute()

  return rows.length
}
