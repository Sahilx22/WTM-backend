import { Kysely, sql } from 'kysely'

// Contacts were never organization-scoped — one global row per phone
// number, shared by every organization. That meant the *first* org to sync
// or save a contact (e.g. via a WhatsApp session's contacts.upsert) fixed
// that phone number's name for every other org forever, since the upsert
// logic deliberately never overwrites an existing display_name. This gives
// every organization its own independent contact for the same real phone
// number, with its own name — matching the isolation tasks/sessions already
// have (see 028/029).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('contacts')
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .execute()

  // Every contact synced/created before this migration came from the
  // single shared WhatsApp connection this deployment has always had,
  // which belongs to organization 1 (see migration 026) — backfill them
  // there so they don't silently vanish from that organization's contact
  // list/recipient pickers now that queries scope by it.
  await db.updateTable('contacts').set({ organization_id: 1 }).where('organization_id', 'is', null).execute()

  // Replace the global phone_number-only uniqueness with a per-organization
  // one — the same real phone number can now be a distinct contact (with
  // its own name) in more than one organization. Left nullable (not NOT
  // NULL) for the same reason tasks.organization_id is: a super admin
  // (no organization) can still technically reach these routes.
  await sql`ALTER TABLE contacts DROP CONSTRAINT contacts_phone_number_key`.execute(db)
  await db.schema
    .alterTable('contacts')
    .addUniqueConstraint('contacts_organization_id_phone_number_key', ['organization_id', 'phone_number'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('contacts').dropConstraint('contacts_organization_id_phone_number_key').execute()
  await sql`ALTER TABLE contacts ADD CONSTRAINT contacts_phone_number_key UNIQUE (phone_number)`.execute(db)
  await db.schema.alterTable('contacts').dropColumn('organization_id').execute()
}
