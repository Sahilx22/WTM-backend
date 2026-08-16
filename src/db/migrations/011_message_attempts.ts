import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('message_attempts')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('message_id', 'bigint', (col) => col.notNull().references('messages.id').onDelete('cascade'))
    .addColumn('attempt_number', 'integer', (col) => col.notNull())
    .addColumn('status', 'varchar(10)', (col) => col.notNull())
    .addColumn('error_message', 'text')
    .addColumn('attempted_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_message_attempts_message_id')
    .on('message_attempts')
    .column('message_id')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('message_attempts').execute()
}
