import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('campaigns')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('name', 'varchar(150)', (col) => col.notNull())
    .addColumn('batch_id', 'integer', (col) => col.references('batches.id').onDelete('set null'))
    .addColumn('template_id', 'integer', (col) => col.references('message_templates.id').onDelete('set null'))
    .addColumn('message_type', 'varchar(20)', (col) => col.notNull())
    .addColumn('message_text', 'text')
    .addColumn('media_path', 'text')
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('draft'))
    .addColumn('scheduled_at', 'timestamptz')
    .addColumn('rate_limit_override', 'jsonb')
    .addColumn('total_recipients', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('processed_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('success_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('failed_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .execute()

  await db.schema.createIndex('idx_campaigns_status').on('campaigns').column('status').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('campaigns').execute()
}
