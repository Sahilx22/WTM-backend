import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('messages')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('campaign_id', 'integer', (col) => col.references('campaigns.id').onDelete('set null'))
    .addColumn('recipient_type', 'varchar(10)', (col) => col.notNull())
    .addColumn('recipient_contact_id', 'integer', (col) => col.references('contacts.id').onDelete('set null'))
    .addColumn('recipient_group_id', 'integer', (col) => col.references('groups.id').onDelete('set null'))
    .addColumn('recipient_jid', 'varchar(64)', (col) => col.notNull())
    .addColumn('message_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('message_text', 'text')
    .addColumn('media_path', 'text')
    .addColumn('template_id', 'integer', (col) => col.references('message_templates.id').onDelete('set null'))
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('queued'))
    .addColumn('wa_message_id', 'varchar(100)')
    .addColumn('failure_reason', 'text')
    .addColumn('retry_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('scheduled_at', 'timestamptz')
    .addColumn('sent_at', 'timestamptz')
    .addColumn('delivered_at', 'timestamptz')
    .addColumn('read_at', 'timestamptz')
    .addColumn('pg_boss_job_id', 'uuid')
    .addColumn('created_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('idx_messages_status').on('messages').column('status').execute()
  await db.schema.createIndex('idx_messages_scheduled_at').on('messages').column('scheduled_at').execute()
  await db.schema.createIndex('idx_messages_campaign_id').on('messages').column('campaign_id').execute()
  await db.schema.createIndex('idx_messages_recipient_jid').on('messages').column('recipient_jid').execute()
  await db.schema.createIndex('idx_messages_created_at').on('messages').column('created_at').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('messages').execute()
}
