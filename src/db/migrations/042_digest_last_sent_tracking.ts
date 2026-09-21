import { Kysely } from 'kysely'

// Tracks the last time each of an organization's three digest sends (daily
// task overview, weekly report, review digest) actually went out, so
// queue/scheduledDigests.ts can treat "already sent today" as a hard stop.
// A WhatsApp session disconnecting and reconnecting re-applies every
// organization's digest schedule (see applyDigestSchedule's callers in
// queue/lifecycle.ts) — if a previously-scheduled job for that same digest
// is still pending when that happens, a second, independent self-
// perpetuating chain can end up running alongside it, each unaware of the
// other, resulting in the same digest going out more than once a day.
// This column makes the actual send idempotent per calendar day regardless
// of how many redundant chains exist upstream.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('task_settings')
    .addColumn('daily_overview_last_sent_at', 'timestamptz')
    .addColumn('weekly_report_last_sent_at', 'timestamptz')
    .addColumn('review_digest_last_sent_at', 'timestamptz')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('task_settings')
    .dropColumn('daily_overview_last_sent_at')
    .dropColumn('weekly_report_last_sent_at')
    .dropColumn('review_digest_last_sent_at')
    .execute()
}
