import { Kysely, sql } from 'kysely'

// Moves the WhatsApp connection from one global singleton (whatsapp_connection,
// a single row) to N connections per organization ("sessions") — one org's
// admin can now link their own number plus additional employee numbers so
// those employees can delegate tasks via #task from their own phone. The old
// whatsapp_connection table is left untouched (still read by any
// not-yet-updated deployment of this backend) — this is purely additive.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('organizations')
    // How many concurrent WhatsApp sessions this org's admin is allowed to
    // connect at once. Set by the super admin; existing orgs default to 1
    // (today's single-connection behavior).
    .addColumn('max_sessions', 'integer', (col) => col.notNull().defaultTo(1))
    .execute()

  await db.schema
    .createTable('whatsapp_sessions')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('organization_id', 'integer', (col) => col.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('label', 'text')
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('disconnected'))
    .addColumn('phone_number', 'text')
    .addColumn('wa_jid', 'text')
    // The first session an org ever successfully connects becomes primary
    // and stays primary — every task reminder and auto-report goes out
    // through the primary session's number only, no matter which session's
    // #task message created the task. Later sessions for the same org are
    // "delegator" sessions: they can create tasks and answer commands in
    // their own self-chat, but never send reminders themselves.
    .addColumn('is_primary', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('connected_at', 'timestamptz')
    .addColumn('last_disconnect_reason', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .alterTable('tasks')
    // Which session's #task message created this task — null for tasks
    // created before this migration, or if the creating session was later
    // deleted. Purely informational (task visibility/commands stay
    // unscoped/global, as before) — this is what lets /status, /chat, the
    // web Tasks page and reports show "delegated by" per task.
    .addColumn('created_by_session_id', 'integer', (col) => col.references('whatsapp_sessions.id').onDelete('set null'))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').dropColumn('created_by_session_id').execute()
  await db.schema.dropTable('whatsapp_sessions').execute()
  await db.schema.alterTable('organizations').dropColumn('max_sessions').execute()
}
