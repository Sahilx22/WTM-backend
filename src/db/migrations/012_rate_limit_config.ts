import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('rate_limit_config')
    .addColumn('id', 'smallint', (col) => col.primaryKey().check(sql`id = 1`))
    .addColumn('max_per_minute', 'integer', (col) => col.notNull().defaultTo(10))
    .addColumn('max_per_hour', 'integer', (col) => col.notNull().defaultTo(200))
    .addColumn('min_delay_ms', 'integer', (col) => col.notNull().defaultTo(3000))
    .addColumn('max_delay_ms', 'integer', (col) => col.notNull().defaultTo(8000))
    .addColumn('concurrency', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('pause_after_consecutive_failures', 'integer', (col) => col.notNull().defaultTo(5))
    .addColumn('is_paused', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .execute()

  await db.insertInto('rate_limit_config').values({ id: 1 }).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('rate_limit_config').execute()
}
