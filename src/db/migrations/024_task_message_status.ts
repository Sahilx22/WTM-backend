import { Kysely } from 'kysely'

// Records whether a task reminder actually went out or failed to send, so
// the dashboard can show a scheduled/sent/failed view instead of just
// "a reminder message exists". Existing rows (all successes so far — sends
// that failed were never recorded at all) default to 'sent'.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('task_messages')
    .addColumn('status', 'varchar(10)', (col) => col.notNull().defaultTo('sent'))
    .addColumn('error_message', 'text')
    .execute()

  // A failed send never got a real WhatsApp message id.
  await db.schema.alterTable('task_messages').alterColumn('wa_message_id', (col) => col.dropNotNull()).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('task_messages').dropColumn('status').dropColumn('error_message').execute()
  await db.schema.alterTable('task_messages').alterColumn('wa_message_id', (col) => col.setNotNull()).execute()
}
