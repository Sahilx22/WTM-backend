import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('groups')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('wa_jid', 'varchar(64)', (col) => col.notNull().unique())
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('participant_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('is_admin', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('last_synced_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('groups').execute()
}
