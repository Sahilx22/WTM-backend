import { Kysely } from 'kysely'

// Free-form category tag (e.g. "acc", "pur") set via "@acc"/"@pur" in a
// #task message — no fixed list, whatever the team types becomes the tag.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').addColumn('category', 'varchar(20)').execute()
  await db.schema.createIndex('idx_tasks_category').on('tasks').column('category').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_tasks_category').execute()
  await db.schema.alterTable('tasks').dropColumn('category').execute()
}
