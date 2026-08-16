import { Kysely, sql } from 'kysely'

// Singleton row (like rate_limit_config) holding admin-editable timing for
// task reminders and for the auto-sent PDF reports.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('task_settings')
    .addColumn('id', 'smallint', (col) => col.primaryKey().check(sql`id = 1`))
    .addColumn('reminder_hourly_minutes', 'integer', (col) => col.notNull().defaultTo(60))
    .addColumn('reminder_daily_minutes', 'integer', (col) => col.notNull().defaultTo(1440))
    .addColumn('reminder_weekly_minutes', 'integer', (col) => col.notNull().defaultTo(10080))
    .addColumn('auto_report_daily_enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('auto_report_daily_time', 'varchar(5)', (col) => col.notNull().defaultTo('09:00'))
    .addColumn('auto_report_weekly_enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('auto_report_weekly_day', 'varchar(10)', (col) => col.notNull().defaultTo('monday'))
    .addColumn('auto_report_weekly_time', 'varchar(5)', (col) => col.notNull().defaultTo('09:00'))
    .addColumn('auto_report_monthly_enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('auto_report_monthly_day', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('auto_report_monthly_time', 'varchar(5)', (col) => col.notNull().defaultTo('09:00'))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .execute()

  await db.insertInto('task_settings').values({ id: 1 }).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('task_settings').execute()
}
