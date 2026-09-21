import { Kysely, sql } from 'kysely'

// Stores the half of a two-way chat thread the existing `messages` table
// structurally can't: inbound messages from a contact, plus the rare
// message sent manually from the linked phone's own WhatsApp app (fromMe,
// but never queued through this app, so it has no `messages` row).
// Outbound chat sends stay ordinary `messages` rows (see migration 041) —
// this table is deliberately not a general "all chat messages" table, only
// the inbound-side complement. The Chat feature's thread view merges both
// tables at query time.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('chat_messages')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('organization_id', 'integer', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('contact_id', 'integer', (col) => col.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('direction', 'varchar(10)', (col) => col.notNull())
    .addColumn('message_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('message_text', 'text')
    .addColumn('media_path', 'text')
    .addColumn('media_mimetype', 'varchar(120)')
    .addColumn('wa_message_id', 'varchar(100)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_chat_messages_contact_created')
    .on('chat_messages')
    .columns(['organization_id', 'contact_id', 'created_at'])
    .execute()

  // Partial unique index (Kysely's schema builder has no .where() for
  // createIndex) — Baileys can redeliver the same message on reconnect or
  // history sync, so this dedupes without penalizing rows with no
  // wa_message_id (there shouldn't be any, but the partial form is cheap
  // insurance against a future caller that omits it).
  await sql`
    CREATE UNIQUE INDEX uniq_chat_messages_org_wa_id
    ON chat_messages (organization_id, wa_message_id)
    WHERE wa_message_id IS NOT NULL
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uniq_chat_messages_org_wa_id`.execute(db)
  await db.schema.dropTable('chat_messages').execute()
}
