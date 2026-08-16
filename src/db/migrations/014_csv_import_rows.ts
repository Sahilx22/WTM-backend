import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('csv_import_rows')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('import_id', 'uuid', (col) => col.notNull())
    .addColumn('raw_row', 'jsonb', (col) => col.notNull())
    .addColumn('phone_number', 'varchar(20)')
    .addColumn('display_name', 'varchar(120)')
    .addColumn('validity', 'varchar(10)', (col) => col.notNull())
    .addColumn('reason', 'text')
    .addColumn('created_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('idx_csv_import_rows_import_id').on('csv_import_rows').column('import_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('csv_import_rows').execute()
}
