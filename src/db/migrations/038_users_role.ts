import { Kysely } from 'kysely'

// Introduces a restricted login kind, used by the Shared Access feature: an
// org admin can create a 'restricted' user who only gets per-contact chat
// access (see contact_access_grants, migration 039) rather than full access
// to everything in their organization. Enforced at the application layer
// only, no DB constraint — same convention migration 026 used for
// organization_id being null meaning "super admin". Every existing user
// becomes 'admin' (the one user created per org today already acts as one).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('role', 'varchar(20)', (col) => col.notNull().defaultTo('admin'))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('role').execute()
}
