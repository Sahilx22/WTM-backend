import { Kysely, sql } from 'kysely'

// A standing "report submission" schedule an admin sets up from the
// portal: one employee must submit a named report (text, or a document/
// image/PDF) on a recurring schedule — a specific weekday (e.g. every
// Monday) or every N days — by a given time. Deliberately its own concept,
// separate from tasks/recurring reminders: unlike those, each occurrence
// has a real outcome the admin needs to see (submitted vs missed), and the
// employee submits by sending it back, not by reacting/replying "done".
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('report_definitions')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('recipient_jid', 'varchar(64)', (col) => col.notNull())
    .addColumn('contact_id', 'integer', (col) => col.references('contacts.id').onDelete('set null'))
    // 'weekly' uses day_of_week (0=Sunday..6=Saturday); 'interval' uses
    // interval_days — exactly one of the two is set, enforced at the
    // application layer (same convention as tasks' reminder_times_per_day
    // vs reminder_interval_days).
    .addColumn('schedule_type', 'varchar(10)', (col) => col.notNull())
    .addColumn('day_of_week', 'integer')
    .addColumn('interval_days', 'integer')
    // "HH:MM" — the wall-clock time each occurrence is due by.
    .addColumn('due_time', 'varchar(5)', (col) => col.notNull())
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('next_due_at', 'timestamptz')
    .addColumn('next_due_job_id', 'uuid')
    .addColumn('whatsapp_session_id', 'integer', (col) => col.references('whatsapp_sessions.id').onDelete('set null'))
    .addColumn('created_by_session_id', 'integer', (col) => col.references('whatsapp_sessions.id').onDelete('set null'))
    .addColumn('created_by', 'integer', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema.createIndex('idx_report_definitions_organization_id').on('report_definitions').column('organization_id').execute()

  // One row per scheduled occurrence — created when the previous occurrence
  // resolves (submitted or missed), or when the definition is first
  // created/re-enabled. This is the actual tracking history an admin reads:
  // "submitted on time", "missed", or "still open".
  await db.schema
    .createTable('report_submissions')
    .addColumn('id', 'serial', (col) => col.primaryKey())
    .addColumn('report_definition_id', 'integer', (col) => col.notNull().references('report_definitions.id').onDelete('cascade'))
    .addColumn('organization_id', 'integer', (col) => col.references('organizations.id').onDelete('cascade'))
    .addColumn('due_at', 'timestamptz', (col) => col.notNull())
    // 'pending' | 'submitted' | 'missed' — enforced at the application layer.
    .addColumn('status', 'varchar(10)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('reminder_sent_at', 'timestamptz')
    .addColumn('submitted_at', 'timestamptz')
    .addColumn('submission_text', 'text')
    .addColumn('submission_media_path', 'text')
    .addColumn('submission_media_mimetype', 'varchar(120)')
    .addColumn('wa_message_id', 'varchar(100)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  await db.schema
    .createIndex('idx_report_submissions_definition_due')
    .on('report_submissions')
    .columns(['report_definition_id', 'due_at'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('report_submissions').execute()
  await db.schema.dropTable('report_definitions').execute()
}
