import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('tasks')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('recipient_jid', 'varchar(64)', (col) => col.notNull())
    .addColumn('contact_id', 'integer', (col) => col.references('contacts.id').onDelete('set null'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('reminder_frequency', 'varchar(10)')
    .addColumn('target_date', 'timestamptz')
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('last_reminder_sent_at', 'timestamptz')
    .addColumn('next_reminder_job_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('completed_at', 'timestamptz')
    .execute()

  await db.schema.createIndex('idx_tasks_status').on('tasks').column('status').execute()
  await db.schema.createIndex('idx_tasks_recipient_jid').on('tasks').column('recipient_jid').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('tasks').execute()
}
