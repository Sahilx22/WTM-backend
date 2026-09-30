import { Kysely, sql } from 'kysely'

// Recurring reminders were daily-only — this lets one repeat every N days
// instead, the same "1IN<N>D" concept tasks already have. Default 1 keeps
// every existing reminder firing daily, exactly as before.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('recurring_reminders')
    .addColumn('interval_days', 'integer', (col) => col.notNull().defaultTo(1))
    .execute()

  await sql`alter table recurring_reminders add constraint recurring_reminders_interval_days_positive check (interval_days >= 1)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('recurring_reminders').dropColumn('interval_days').execute()
}
