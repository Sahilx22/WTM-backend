import { Kysely } from 'kysely'

// Schema matches what connect-pg-simple expects (createTableIfMissing: false —
// we manage this table ourselves via migrations instead).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('session')
    .addColumn('sid', 'varchar', (col) => col.primaryKey())
    .addColumn('sess', 'json', (col) => col.notNull())
    .addColumn('expire', 'timestamp(6)', (col) => col.notNull())
    .execute()

  await db.schema.createIndex('idx_session_expire').on('session').column('expire').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('session').execute()
}
