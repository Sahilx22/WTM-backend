import { Kysely } from 'kysely'
import { hashPassword } from '../../auth/passwords.js'

// Sets up the first organization from whatever's already in this database
// (so existing logins/data keep working exactly as before), and seeds the
// one fixed super-admin account that provisions new organizations.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    // Null means "not tied to any org" — that's what the super-admin
    // account uses; every regular org user has this set (enforced at the
    // application layer, not a DB constraint, to keep this migration simple).
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id'))
    .addColumn('is_super_admin', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute()

  const existingConnection = await db
    .selectFrom('whatsapp_connection')
    .select('phone_number')
    .where('id', '=', 1)
    .executeTakeFirst()

  const org = await db
    .insertInto('organizations')
    .values({
      id: 1,
      name: 'Icon Interiors',
      admin_wa_number: existingConnection?.phone_number ?? null
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await db.updateTable('users').set({ organization_id: org.id }).where('organization_id', 'is', null).execute()

  const superAdminPasswordHash = await hashPassword('sahil!@#123')
  await db
    .insertInto('users')
    .values({
      username: 'sahilx22',
      password_hash: superAdminPasswordHash,
      display_name: 'Super Admin',
      organization_id: null,
      is_super_admin: true
    })
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('users').where('username', '=', 'sahilx22').where('is_super_admin', '=', true).execute()
  await db.schema.alterTable('users').dropColumn('organization_id').dropColumn('is_super_admin').execute()
}
