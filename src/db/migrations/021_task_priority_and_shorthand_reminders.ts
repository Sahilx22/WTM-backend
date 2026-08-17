import { Kysely } from 'kysely'

// Replaces the old hourly/daily/weekly reminder_frequency model with the
// shorthand codes the team already uses day-to-day (1TAD/2TAD/3TAD = N times
// a day, 1IN2D/1IN3D = once every N days), plus a task priority (P1-P4).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('tasks')
    .addColumn('priority', 'varchar(2)', (col) => col.notNull().defaultTo('P3'))
    .addColumn('reminder_times_per_day', 'integer')
    .addColumn('reminder_interval_days', 'integer')
    .execute()

  await db.schema.alterTable('tasks').dropColumn('reminder_frequency').execute()

  await db.schema
    .alterTable('task_settings')
    .addColumn('working_hours_start', 'varchar(5)', (col) => col.notNull().defaultTo('09:00'))
    .addColumn('working_hours_end', 'varchar(5)', (col) => col.notNull().defaultTo('18:30'))
    .execute()

  await db.schema
    .alterTable('task_settings')
    .dropColumn('reminder_hourly_minutes')
    .dropColumn('reminder_daily_minutes')
    .dropColumn('reminder_weekly_minutes')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').addColumn('reminder_frequency', 'varchar(10)').execute()

  await db.schema
    .alterTable('tasks')
    .dropColumn('priority')
    .dropColumn('reminder_times_per_day')
    .dropColumn('reminder_interval_days')
    .execute()

  await db.schema
    .alterTable('task_settings')
    .addColumn('reminder_hourly_minutes', 'integer', (col) => col.notNull().defaultTo(60))
    .addColumn('reminder_daily_minutes', 'integer', (col) => col.notNull().defaultTo(1440))
    .addColumn('reminder_weekly_minutes', 'integer', (col) => col.notNull().defaultTo(10080))
    .execute()

  await db.schema
    .alterTable('task_settings')
    .dropColumn('working_hours_start')
    .dropColumn('working_hours_end')
    .execute()
}
