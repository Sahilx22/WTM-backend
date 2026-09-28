import { Kysely } from 'kysely'

// Lets a one-off/scheduled message (Send, Schedule) and a recurring reminder
// each be pinned to a specific connected WhatsApp, the same choice campaigns
// already got in migration 044 — null keeps today's behavior (send through
// the organization's primary session).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('messages')
    .addColumn('whatsapp_session_id', 'integer', (col) => col.references('whatsapp_sessions.id').onDelete('set null'))
    .execute()

  await db.schema
    .alterTable('recurring_reminders')
    .addColumn('whatsapp_session_id', 'integer', (col) => col.references('whatsapp_sessions.id').onDelete('set null'))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('messages').dropColumn('whatsapp_session_id').execute()
  await db.schema.alterTable('recurring_reminders').dropColumn('whatsapp_session_id').execute()
}
