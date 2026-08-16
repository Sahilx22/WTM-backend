import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('batches')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'varchar(120)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('contact_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('batches').execute()
}
