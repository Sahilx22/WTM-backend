import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('batch_members')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('batch_id', 'integer', (col) => col.notNull().references('batches.id').onDelete('cascade'))
    .addColumn('contact_id', 'integer', (col) => col.notNull().references('contacts.id').onDelete('cascade'))
    .addColumn('added_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_batch_members_batch_contact', ['batch_id', 'contact_id'])
    .execute()

  await db.schema.createIndex('idx_batch_members_batch_id').on('batch_members').column('batch_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('batch_members').execute()
}
