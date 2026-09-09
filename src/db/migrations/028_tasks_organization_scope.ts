import { Kysely } from 'kysely'

// Multi-session support (027) let more than one organization run its own
// WhatsApp session(s), but every task query (the /status, /report, /complete
// etc. commands, and the web Tasks/Reports pages) stayed completely
// unscoped — any connected session, from any organization, could see and
// modify every other organization's tasks. This closes that: tasks now
// belong to an organization, and every query that lists or mutates tasks
// filters by it (see whatsapp/commandEngine.ts, modules/tasks/routes.ts,
// reports/taskMetrics.ts).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('tasks')
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('set null'))
    .execute()

  // Every task created before this migration came from the single shared
  // WhatsApp connection this deployment has always had, which belongs to
  // organization 1 (see migration 026) — backfill them there so they don't
  // silently vanish from that organization's task list/reports now that
  // queries scope by it.
  await db.updateTable('tasks').set({ organization_id: 1 }).where('organization_id', 'is', null).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').dropColumn('organization_id').execute()
}
