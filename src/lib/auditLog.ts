import { db } from '../db/index.js'

export interface AuditLogEntry {
  userId: number | null
  action: string
  entityType?: string | null
  entityId?: string | number | null
  metadata?: Record<string, unknown> | null
  ipAddress?: string | null
}

export async function recordAuditLog(entry: AuditLogEntry): Promise<void> {
  await db
    .insertInto('audit_logs')
    .values({
      user_id: entry.userId,
      action: entry.action,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId != null ? String(entry.entityId) : null,
      metadata: entry.metadata ?? null,
      ip_address: entry.ipAddress ?? null
    })
    .execute()
}
