import { Kysely } from 'kysely'

// Message templates were never organization-scoped — any organization could
// read, edit, or delete any other organization's template (including its
// media). Gives every organization its own independent template list.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('message_templates')
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .execute()

  await db.updateTable('message_templates').set({ organization_id: 1 }).where('organization_id', 'is', null).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('message_templates').dropColumn('organization_id').execute()
}
