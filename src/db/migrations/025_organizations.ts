import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('organizations')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('logo_url', 'text')
    // The one WhatsApp number this org is allowed to connect with — set by
    // the super admin at creation time, read-only to the org itself.
    // Enforcement against the live connection is a later phase; this column
    // just records the value for now.
    .addColumn('admin_wa_number', 'varchar(32)')
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('organizations').execute()
}
