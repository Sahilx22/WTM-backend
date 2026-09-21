import { Kysely } from 'kysely'

// Which of the organization's linked WhatsApp numbers a campaign sends from.
// Null (every campaign created before this, or one whose session was later
// removed) keeps the old behavior: send through the organization's primary
// session. When set, the campaign only ever sends through that exact
// session — and if it isn't connected when a message comes due, the whole
// campaign is marked failed rather than silently falling back to a
// different number the admin didn't pick.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('campaigns')
    .addColumn('whatsapp_session_id', 'integer', (col) => col.references('whatsapp_sessions.id').onDelete('set null'))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('campaigns').dropColumn('whatsapp_session_id').execute()
}
