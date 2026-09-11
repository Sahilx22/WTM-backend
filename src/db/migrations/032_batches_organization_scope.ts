import { Kysely } from 'kysely'

// Batches (and their members, via batch_id) were never organization-scoped —
// any organization could read, add members to, or delete any other
// organization's batch by id. Gives every organization its own independent
// batch list, matching the isolation contacts/tasks/groups already have.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('batches')
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .execute()

  // Every batch created before this migration came from the single shared
  // deployment this app has always had, which belongs to organization 1 (see
  // migration 026) — backfill them there so they don't silently vanish from
  // that organization's batch list now that queries scope by it.
  await db.updateTable('batches').set({ organization_id: 1 }).where('organization_id', 'is', null).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('batches').dropColumn('organization_id').execute()
}
