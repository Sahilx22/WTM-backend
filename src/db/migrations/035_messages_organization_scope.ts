import { Kysely } from 'kysely'

// Messages (and message_attempts, via message_id) were never
// organization-scoped — the entire send history/dashboard/rate-limit
// counters were shared and readable across every organization. Gives every
// organization its own independent message history, and lets sends/rate
// limiting/dashboards be scoped per organization instead of globally.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('messages')
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .execute()

  await db.updateTable('messages').set({ organization_id: 1 }).where('organization_id', 'is', null).execute()

  await db.schema.createIndex('idx_messages_organization_id').on('messages').column('organization_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_messages_organization_id').execute()
  await db.schema.alterTable('messages').dropColumn('organization_id').execute()
}
