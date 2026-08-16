import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('audit_logs')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('user_id', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('action', 'varchar(80)', (col) => col.notNull())
    .addColumn('entity_type', 'varchar(50)')
    .addColumn('entity_id', 'varchar(50)')
    .addColumn('metadata', 'jsonb')
    .addColumn('ip_address', 'varchar(64)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('idx_audit_logs_created_at').on('audit_logs').column('created_at').execute()
  await db.schema.createIndex('idx_audit_logs_user_id').on('audit_logs').column('user_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('audit_logs').execute()
}
