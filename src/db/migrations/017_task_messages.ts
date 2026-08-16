import { Kysely, sql } from 'kysely'

// Tracks every WhatsApp message tied to a task (the original #task message
// plus every reminder sent) so an incoming thumbs-up reaction on ANY of them
// can be matched back to the task it belongs to.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('task_messages')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('task_id', 'integer', (col) => col.notNull().references('tasks.id').onDelete('cascade'))
    .addColumn('wa_message_id', 'varchar(100)', (col) => col.notNull())
    .addColumn('kind', 'varchar(10)', (col) => col.notNull())
    .addColumn('sent_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('idx_task_messages_wa_message_id').on('task_messages').column('wa_message_id').execute()
  await db.schema.createIndex('idx_task_messages_task_id').on('task_messages').column('task_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('task_messages').execute()
}
