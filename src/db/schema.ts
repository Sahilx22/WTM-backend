import type { Generated, Insertable, Selectable, Updateable } from 'kysely'

export type RecipientType = 'user' | 'group'
export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document'
export type MessageStatus =
  | 'scheduled'
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'cancelled'
export type CampaignStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr_pending' | 'connected'
export type ContactSource = 'manual' | 'csv' | 'whatsapp'
export type AttemptStatus = 'success' | 'failure'
export type CsvRowValidity = 'valid' | 'duplicate' | 'invalid'

export interface OrganizationsTable {
  id: Generated<number>
  name: string
  logo_url: string | null
  admin_wa_number: string | null
  is_active: Generated<boolean>
  // How many concurrent WhatsApp sessions (see WhatsappSessionsTable) this
  // org's admin can connect at once. Set by the super admin.
  max_sessions: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface WhatsappSessionsTable {
  id: Generated<number>
  organization_id: number
  label: string | null
  status: Generated<ConnectionStatus>
  phone_number: string | null
  wa_jid: string | null
  // The org's first-ever connected session; reminders/auto-reports always
  // send through whichever session has this set, regardless of which
  // session created the underlying task.
  is_primary: Generated<boolean>
  connected_at: Date | null
  last_disconnect_reason: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface UsersTable {
  id: Generated<number>
  username: string
  password_hash: string
  display_name: string
  is_active: Generated<boolean>
  last_login_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
  // Null for the super-admin account only — every regular org user has this set.
  organization_id: number | null
  is_super_admin: Generated<boolean>
}

export interface SessionTable {
  sid: string
  sess: object
  expire: Date
}

export interface WhatsappConnectionTable {
  id: Generated<number>
  status: Generated<ConnectionStatus>
  phone_number: string | null
  wa_jid: string | null
  connected_at: Date | null
  last_disconnect_reason: string | null
  updated_at: Generated<Date>
}

export interface ContactsTable {
  id: Generated<number>
  phone_number: string
  wa_jid: string | null
  display_name: string | null
  notes: string | null
  is_valid_on_whatsapp: boolean | null
  source: Generated<ContactSource>
  created_by: number | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface GroupsTable {
  id: Generated<number>
  wa_jid: string
  subject: string
  participant_count: Generated<number>
  is_admin: Generated<boolean>
  last_synced_at: Date | null
  created_at: Generated<Date>
}

export interface BatchesTable {
  id: Generated<number>
  name: string
  description: string | null
  contact_count: Generated<number>
  created_by: number | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface BatchMembersTable {
  id: Generated<number>
  batch_id: number
  contact_id: number
  added_at: Generated<Date>
}

export interface MessageTemplatesTable {
  id: Generated<number>
  name: string
  body_text: string | null
  message_type: MessageType
  media_path: string | null
  media_mimetype: string | null
  created_by: number | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface CampaignsTable {
  id: Generated<number>
  name: string
  batch_id: number | null
  template_id: number | null
  message_type: MessageType
  message_text: string | null
  media_path: string | null
  status: Generated<CampaignStatus>
  scheduled_at: Date | null
  rate_limit_override: object | null
  total_recipients: Generated<number>
  processed_count: Generated<number>
  success_count: Generated<number>
  failed_count: Generated<number>
  created_by: number | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
  started_at: Date | null
  completed_at: Date | null
}

export interface MessagesTable {
  id: Generated<number>
  campaign_id: number | null
  recipient_type: RecipientType
  recipient_contact_id: number | null
  recipient_group_id: number | null
  recipient_jid: string
  message_type: MessageType
  message_text: string | null
  media_path: string | null
  template_id: number | null
  status: Generated<MessageStatus>
  wa_message_id: string | null
  failure_reason: string | null
  retry_count: Generated<number>
  scheduled_at: Date | null
  sent_at: Date | null
  delivered_at: Date | null
  read_at: Date | null
  pg_boss_job_id: string | null
  created_by: number | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface MessageAttemptsTable {
  id: Generated<number>
  message_id: number
  attempt_number: number
  status: AttemptStatus
  error_message: string | null
  attempted_at: Generated<Date>
}

export interface RateLimitConfigTable {
  id: Generated<number>
  max_per_minute: Generated<number>
  max_per_hour: Generated<number>
  min_delay_ms: Generated<number>
  max_delay_ms: Generated<number>
  concurrency: Generated<number>
  pause_after_consecutive_failures: Generated<number>
  is_paused: Generated<boolean>
  updated_at: Generated<Date>
  updated_by: number | null
}

export interface AuditLogsTable {
  id: Generated<number>
  user_id: number | null
  action: string
  entity_type: string | null
  entity_id: string | null
  metadata: object | null
  ip_address: string | null
  created_at: Generated<Date>
}

export interface CsvImportRowsTable {
  id: Generated<number>
  import_id: string
  raw_row: object
  phone_number: string | null
  display_name: string | null
  validity: CsvRowValidity
  reason: string | null
  created_by: number | null
  created_at: Generated<Date>
}

export interface WaMessageCacheTable {
  id: Generated<number>
  remote_jid: string
  message_id: string
  message_json: object
  created_at: Generated<Date>
}

export type TaskStatus = 'pending' | 'needs_review' | 'completed'
export type TaskPriority = 'P1' | 'P2' | 'P3' | 'P4'
export type TaskMessageKind = 'original' | 'reminder'
export type TaskMessageStatus = 'sent' | 'failed'
export type RecurrenceUnit = 'days' | 'weeks'

export interface TasksTable {
  id: Generated<number>
  recipient_jid: string
  contact_id: number | null
  name: string
  category: string | null
  priority: Generated<TaskPriority>
  // Mutually exclusive reminder modes: N times a day (1TAD/2TAD/3TAD, spread
  // across working hours), or once every N days (1IN2D/1IN3D). Neither set
  // means no repeating reminder.
  reminder_times_per_day: number | null
  reminder_interval_days: number | null
  target_date: Date | null
  status: Generated<TaskStatus>
  reminders_enabled: Generated<boolean>
  last_reminder_sent_at: Date | null
  next_reminder_at: Date | null
  next_reminder_job_id: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
  completed_at: Date | null
  is_recurring: Generated<boolean>
  recurrence_interval_value: number | null
  recurrence_interval_unit: RecurrenceUnit | null
  recurrence_time: string | null
  recurrence_parent_id: number | null
  next_recurrence_job_id: string | null
  // Which session's #task message created this task — null for tasks
  // created before multi-session support, or if that session was deleted.
  created_by_session_id: number | null
  // Which organization this task belongs to — every task query filters by
  // it so one organization's sessions never see another's tasks. Null only
  // for pre-multi-tenant tasks that couldn't be backfilled.
  organization_id: number | null
}

export interface TaskMessagesTable {
  id: Generated<number>
  task_id: number
  wa_message_id: string | null
  kind: TaskMessageKind
  status: Generated<TaskMessageStatus>
  error_message: string | null
  sent_at: Generated<Date>
}

export interface TaskNotesTable {
  id: Generated<number>
  task_id: number
  wa_message_id: string
  from_admin: boolean
  body: string
  created_at: Generated<Date>
}

export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'

export interface TaskSettingsTable {
  id: Generated<number>
  working_hours_start: Generated<string>
  working_hours_end: Generated<string>
  auto_report_daily_enabled: Generated<boolean>
  auto_report_daily_time: Generated<string>
  auto_report_weekly_enabled: Generated<boolean>
  auto_report_weekly_day: Generated<WeekDay>
  auto_report_weekly_time: Generated<string>
  auto_report_monthly_enabled: Generated<boolean>
  auto_report_monthly_day: Generated<number>
  auto_report_monthly_time: Generated<string>
  reminder_daily_time: Generated<string>
  daily_overview_enabled: Generated<boolean>
  daily_overview_time: Generated<string>
  weekly_report_enabled: Generated<boolean>
  weekly_report_day: Generated<WeekDay>
  weekly_report_time: Generated<string>
  review_digest_enabled: Generated<boolean>
  review_digest_time: Generated<string>
  updated_at: Generated<Date>
  updated_by: number | null
}

export interface Database {
  organizations: OrganizationsTable
  users: UsersTable
  session: SessionTable
  whatsapp_connection: WhatsappConnectionTable
  whatsapp_sessions: WhatsappSessionsTable
  wa_message_cache: WaMessageCacheTable
  contacts: ContactsTable
  groups: GroupsTable
  batches: BatchesTable
  batch_members: BatchMembersTable
  message_templates: MessageTemplatesTable
  campaigns: CampaignsTable
  messages: MessagesTable
  message_attempts: MessageAttemptsTable
  rate_limit_config: RateLimitConfigTable
  audit_logs: AuditLogsTable
  csv_import_rows: CsvImportRowsTable
  tasks: TasksTable
  task_messages: TaskMessagesTable
  task_notes: TaskNotesTable
  task_settings: TaskSettingsTable
}

export type Organization = Selectable<OrganizationsTable>
export type NewOrganization = Insertable<OrganizationsTable>
export type OrganizationUpdate = Updateable<OrganizationsTable>

export type WhatsappSession = Selectable<WhatsappSessionsTable>
export type NewWhatsappSession = Insertable<WhatsappSessionsTable>
export type WhatsappSessionUpdate = Updateable<WhatsappSessionsTable>

export type User = Selectable<UsersTable>
export type NewUser = Insertable<UsersTable>
export type UserUpdate = Updateable<UsersTable>

export type Contact = Selectable<ContactsTable>
export type NewContact = Insertable<ContactsTable>
export type ContactUpdate = Updateable<ContactsTable>

export type Group = Selectable<GroupsTable>
export type NewGroup = Insertable<GroupsTable>

export type Batch = Selectable<BatchesTable>
export type NewBatch = Insertable<BatchesTable>

export type BatchMember = Selectable<BatchMembersTable>

export type MessageTemplate = Selectable<MessageTemplatesTable>
export type NewMessageTemplate = Insertable<MessageTemplatesTable>
export type MessageTemplateUpdate = Updateable<MessageTemplatesTable>

export type Campaign = Selectable<CampaignsTable>
export type NewCampaign = Insertable<CampaignsTable>
export type CampaignUpdate = Updateable<CampaignsTable>

export type Message = Selectable<MessagesTable>
export type NewMessage = Insertable<MessagesTable>
export type MessageUpdate = Updateable<MessagesTable>

export type MessageAttempt = Selectable<MessageAttemptsTable>
export type NewMessageAttempt = Insertable<MessageAttemptsTable>

export type RateLimitConfig = Selectable<RateLimitConfigTable>
export type RateLimitConfigUpdate = Updateable<RateLimitConfigTable>

export type AuditLog = Selectable<AuditLogsTable>
export type NewAuditLog = Insertable<AuditLogsTable>

export type CsvImportRow = Selectable<CsvImportRowsTable>
export type NewCsvImportRow = Insertable<CsvImportRowsTable>
export type WhatsappConnectionRow = Selectable<WhatsappConnectionTable>

export type Task = Selectable<TasksTable>
export type NewTask = Insertable<TasksTable>
export type TaskUpdate = Updateable<TasksTable>

export type TaskMessage = Selectable<TaskMessagesTable>
export type NewTaskMessage = Insertable<TaskMessagesTable>

export type TaskNote = Selectable<TaskNotesTable>
export type NewTaskNote = Insertable<TaskNotesTable>

export type TaskSettings = Selectable<TaskSettingsTable>
export type TaskSettingsUpdate = Updateable<TaskSettingsTable>
