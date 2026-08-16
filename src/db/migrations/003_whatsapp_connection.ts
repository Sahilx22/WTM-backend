import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('whatsapp_connection')
    .addColumn('id', 'smallint', (col) => col.primaryKey().check(sql`id = 1`))
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('disconnected'))
    .addColumn('phone_number', 'varchar(32)')
    .addColumn('wa_jid', 'varchar(64)')
    .addColumn('connected_at', 'timestamptz')
    .addColumn('last_disconnect_reason', 'text')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // Seed the single row this table will ever hold.
  await db
    .insertInto('whatsapp_connection')
    .values({ id: 1, status: 'disconnected' })
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('whatsapp_connection').execute()
}
