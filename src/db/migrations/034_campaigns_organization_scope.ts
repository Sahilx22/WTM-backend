import { Kysely } from 'kysely'

// Campaigns were never organization-scoped — any organization could read or
// cancel any other organization's campaign by id, and its progress stream
// leaked recipient/message data across tenants. Gives every organization its
// own independent campaign list.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('campaigns')
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .execute()

  await db.updateTable('campaigns').set({ organization_id: 1 }).where('organization_id', 'is', null).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('campaigns').dropColumn('organization_id').execute()
}
