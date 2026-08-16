import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('contacts')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('phone_number', 'varchar(20)', (col) => col.notNull().unique())
    .addColumn('wa_jid', 'varchar(64)')
    .addColumn('display_name', 'varchar(120)')
    .addColumn('notes', 'text')
    .addColumn('is_valid_on_whatsapp', 'boolean')
    .addColumn('source', 'varchar(10)', (col) => col.notNull().defaultTo('manual'))
    .addColumn('created_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
  // phone_number already has a unique index from the constraint above.
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('contacts').execute()
}
