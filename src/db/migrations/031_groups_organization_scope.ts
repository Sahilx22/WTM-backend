import { Kysely, sql } from 'kysely'

// Groups were never organization-scoped — one global row per WhatsApp group,
// shared by every organization's sessions. Gives every organization its own
// independent group list, matching the isolation contacts/tasks/sessions
// already have (see 028/030).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('groups')
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .execute()

  // Every group synced before this migration came from the single shared
  // WhatsApp connection this deployment has always had, which belongs to
  // organization 1 (see migration 026) — backfill them there so they don't
  // silently vanish from that organization's group picker now that queries
  // scope by it.
  await db.updateTable('groups').set({ organization_id: 1 }).where('organization_id', 'is', null).execute()

  // Replace the global wa_jid-only uniqueness with a per-organization one —
  // two organizations can each have their own linked WhatsApp number in the
  // same external group, and each needs its own row for it.
  await sql`ALTER TABLE groups DROP CONSTRAINT groups_wa_jid_key`.execute(db)
  await db.schema.alterTable('groups').addUniqueConstraint('groups_organization_id_wa_jid_key', ['organization_id', 'wa_jid']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('groups').dropConstraint('groups_organization_id_wa_jid_key').execute()
  await sql`ALTER TABLE groups ADD CONSTRAINT groups_wa_jid_key UNIQUE (wa_jid)`.execute(db)
  await db.schema.alterTable('groups').dropColumn('organization_id').execute()
}
