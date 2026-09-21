import { Kysely, sql } from 'kysely'

// One row per (restricted employee, contact) pair an admin has granted
// chat access to — the access-control table behind the Shared Access
// feature. The unique constraint on (user_id, contact_id) is what makes a
// duplicate grant attempt a clean, detectable conflict in the route rather
// than a silent duplicate row.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('contact_access_grants')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('organization_id', 'integer', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('user_id', 'integer', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('contact_id', 'integer', (col) => col.notNull().references('contacts.id').onDelete('cascade'))
    // Which admin granted this access — kept for the audit trail shown on
    // the Shared Access page; null if that admin's account is later deleted.
    .addColumn('granted_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_contact_access_grants_user_contact', ['user_id', 'contact_id'])
    .execute()

  await db.schema.createIndex('idx_contact_access_grants_user_id').on('contact_access_grants').column('user_id').execute()
  await db.schema.createIndex('idx_contact_access_grants_contact_id').on('contact_access_grants').column('contact_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('contact_access_grants').execute()
}
