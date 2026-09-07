import { Kysely, sql } from 'kysely'

// Logs a task-related note whenever someone (admin or recipient) sends a
// WhatsApp quote-reply to that task's original message or one of its
// reminders — lets /chat <id> (and the dashboard) pull up exactly the
// conversation that happened around one task.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('task_notes')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('task_id', 'integer', (col) => col.references('tasks.id').onDelete('cascade').notNull())
    .addColumn('wa_message_id', 'varchar(100)', (col) => col.notNull())
    .addColumn('from_admin', 'boolean', (col) => col.notNull())
    .addColumn('body', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('idx_task_notes_task_id').on('task_notes').column('task_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('task_notes').execute()
}
