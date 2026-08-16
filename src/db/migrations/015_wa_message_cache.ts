import { Kysely, sql } from 'kysely'

// Backs the Baileys `getMessage` callback (needed for send retries) — we only
// ever cache messages this app sent itself, not received messages.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('wa_message_cache')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('remote_jid', 'varchar(64)', (col) => col.notNull())
    .addColumn('message_id', 'varchar(100)', (col) => col.notNull())
    .addColumn('message_json', 'jsonb', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_wa_message_cache_jid_id', ['remote_jid', 'message_id'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('wa_message_cache').execute()
}
