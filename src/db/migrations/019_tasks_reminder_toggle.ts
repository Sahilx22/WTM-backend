import { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('tasks')
    .addColumn('reminders_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .execute()

  await db.schema.alterTable('tasks').addColumn('next_reminder_at', 'timestamptz').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').dropColumn('reminders_enabled').execute()
  await db.schema.alterTable('tasks').dropColumn('next_reminder_at').execute()
}
