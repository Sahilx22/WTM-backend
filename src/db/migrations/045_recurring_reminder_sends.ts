import { Kysely, sql } from 'kysely'

// One row per attempt to send a recurring reminder — the log the portal's
// Recurring Reminders page reads to show how many times each one went out,
// how many attempts failed, and when. Deleting a reminder deletes its log.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('recurring_reminder_sends')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('reminder_id', 'integer', (col) => col.notNull().references('recurring_reminders.id').onDelete('cascade'))
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    // 'sent' or 'failed' — enforced at the application layer only.
    .addColumn('status', 'varchar(10)', (col) => col.notNull())
    .addColumn('error_message', 'text')
    .addColumn('wa_message_id', 'varchar(100)')
    .addColumn('sent_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_recurring_reminder_sends_reminder_id')
    .on('recurring_reminder_sends')
    .columns(['reminder_id', 'sent_at'])
    .execute()

  // Reminders sent before this log existed have a last_sent_at but no log
  // row — seed one so their sent count isn't zero.
  await sql`
    insert into recurring_reminder_sends (reminder_id, organization_id, status, sent_at)
    select id, organization_id, 'sent', last_sent_at
    from recurring_reminders
    where last_sent_at is not null
  `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('recurring_reminder_sends').execute()
}
