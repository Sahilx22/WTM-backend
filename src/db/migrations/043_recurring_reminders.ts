import { Kysely, sql } from 'kysely'

// A standalone recurring-message feature, deliberately separate from tasks:
// typing "<message> #sced" (optionally "#sced till dd-mm-yy") in any
// WhatsApp chat schedules that exact message to repeat daily, at whatever
// time of day it was created, to that same chat — forever if no "till" date
// is given, or through that date if one is. `enabled` lets the portal turn
// one off without deleting it (deleting cancels the queued job outright).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('recurring_reminders')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .addColumn('recipient_jid', 'varchar(64)', (col) => col.notNull())
    .addColumn('contact_id', 'integer', (col) => col.references('contacts.id').onDelete('set null'))
    .addColumn('message_text', 'text', (col) => col.notNull())
    // "HH:MM", the wall-clock time this reminder fires daily — fixed at
    // creation time (whenever the #sced message was sent), never
    // separately configurable, per the feature's own "no other time option".
    .addColumn('scheduled_time', 'varchar(5)', (col) => col.notNull())
    // Null means "repeat forever until turned off" — the "till dd-mm-yy"
    // clause is the only way to give it an end date.
    .addColumn('end_date', 'timestamptz')
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    // Idempotency guard, same reasoning as task_settings' *_last_sent_at
    // columns (migration 042) — lets the send worker refuse to send the same
    // calendar day's occurrence twice, regardless of how the job got queued.
    .addColumn('last_sent_at', 'timestamptz')
    .addColumn('next_send_job_id', 'uuid')
    .addColumn('next_send_at', 'timestamptz')
    .addColumn('wa_message_id', 'varchar(100)')
    .addColumn('created_by_session_id', 'integer', (col) => col.references('whatsapp_sessions.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('idx_recurring_reminders_organization_id').on('recurring_reminders').column('organization_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('recurring_reminders').execute()
}
