import { Kysely } from 'kysely'

// A "standing" task, marked with "rec" as the last word of its #task
// message — reminders keep firing on whatever cadence was already set
// (timesPerDay/intervalDays), but the task itself never leaves "pending":
// a thumbs-up, a "done" reply, /complete, and the portal's own completion/
// needs-review actions are all no-ops for it (see lib/taskCompletion.ts).
// Deliberately a separate concept from is_recurring/recurrence_* (added in
// migration 016 or nearby for /recur), which recreates a brand-new task
// some time after the current one IS completed — this is one task that
// simply never completes at all.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').addColumn('never_completes', 'boolean', (col) => col.notNull().defaultTo(false)).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').dropColumn('never_completes').execute()
}
