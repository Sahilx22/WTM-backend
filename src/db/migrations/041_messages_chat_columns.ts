import { Kysely } from 'kysely'

// Two additions to the existing `messages` table for the Shared Access chat
// feature:
//
// - `source` labels where a message originated ('chat' for the new
//   per-contact Chat composer, 'bulk' — the default — for everything else:
//   Send/Schedule/Campaigns, unchanged). Outbound chat sends deliberately
//   stay ordinary `messages` rows rather than living in a separate table,
//   because queue/rateLimiter.ts's send-pacing counts `messages` rows to
//   throttle the organization's one WhatsApp number — a chat send that
//   bypassed `messages` would be invisible to that rate limiter.
//
// - `media_mimetype` fixes a pre-existing gap: modules/messages/shared.ts's
//   resolveMedia() already returns a mimetype, and whatsapp/send.ts's
//   buildMessageContent() already accepts one (falling back to a generic
//   default when absent), but nothing has ever stored it because this
//   column didn't exist. Chat-attached audio/document files should keep
//   their real mimetype; this also incidentally fixes the same gap for the
//   existing Send page.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('messages')
    .addColumn('source', 'varchar(20)', (col) => col.notNull().defaultTo('bulk'))
    .addColumn('media_mimetype', 'varchar(120)')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('messages').dropColumn('source').dropColumn('media_mimetype').execute()
}
