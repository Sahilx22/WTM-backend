import { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('tasks')
    .addColumn('is_recurring', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('recurrence_interval_value', 'integer')
    .addColumn('recurrence_interval_unit', 'varchar(10)')
    .addColumn('recurrence_time', 'varchar(5)')
    .addColumn('recurrence_parent_id', 'integer', (col) => col.references('tasks.id').onDelete('set null'))
    .addColumn('next_recurrence_job_id', 'uuid')
    .execute()

  await db.schema
    .alterTable('task_settings')
    .addColumn('reminder_daily_time', 'varchar(5)', (col) => col.notNull().defaultTo('09:30'))
    .addColumn('daily_overview_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('daily_overview_time', 'varchar(5)', (col) => col.notNull().defaultTo('18:00'))
    .addColumn('weekly_report_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('weekly_report_day', 'varchar(10)', (col) => col.notNull().defaultTo('monday'))
    .addColumn('weekly_report_time', 'varchar(5)', (col) => col.notNull().defaultTo('10:00'))
    .addColumn('review_digest_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('review_digest_time', 'varchar(5)', (col) => col.notNull().defaultTo('18:30'))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('tasks')
    .dropColumn('is_recurring')
    .dropColumn('recurrence_interval_value')
    .dropColumn('recurrence_interval_unit')
    .dropColumn('recurrence_time')
    .dropColumn('recurrence_parent_id')
    .dropColumn('next_recurrence_job_id')
    .execute()

  await db.schema
    .alterTable('task_settings')
    .dropColumn('reminder_daily_time')
    .dropColumn('daily_overview_enabled')
    .dropColumn('daily_overview_time')
    .dropColumn('weekly_report_enabled')
    .dropColumn('weekly_report_day')
    .dropColumn('weekly_report_time')
    .dropColumn('review_digest_enabled')
    .dropColumn('review_digest_time')
    .execute()
}
