import { Kysely } from 'kysely'

// Supports assigning a task to a specific employee mentioned inside a group
// #task message (e.g. "#task Update rate calculator @Priya @acc P1"),
// instead of only ever addressing the whole group. `assigned_jid` records
// that mentioned employee's own WhatsApp id — used to resolve their contact
// name for display, and (critically) to tell which of several tasks
// created from the *same* group message a later reaction/reply belongs to,
// so completing one employee's task never touches another's. Null for
// every task created without a mention (1:1 chats, or a plain group
// #task with nobody @mentioned) — unchanged, existing behavior.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').addColumn('assigned_jid', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('tasks').dropColumn('assigned_jid').execute()
}
