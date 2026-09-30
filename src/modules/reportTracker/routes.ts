import { Router } from 'express'
import { db } from '../../db/index.js'
import { reportDefinitionSchema } from './schemas.js'
import { recordAuditLog } from '../../lib/auditLog.js'
import { normalizePhoneDigits, isValidPhoneDigits, phoneToJid } from '../../lib/phone.js'
import { getMediaSignedUrl } from '../../lib/mediaUpload.js'
import { getConnectedSessionsForOrganization, maskPhoneNumber } from '../../whatsapp/connectionManager.js'
import { scheduleNextReportOccurrence, nextWeeklyOccurrence } from '../../queue/reportSubmissions.js'
import { nextIntervalDaysTime } from '../../queue/taskReminders.js'

export const reportTrackerRouter = Router()

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function scheduleLabel(def: { schedule_type: string; day_of_week: number | null; interval_days: number | null; due_time: string }): string {
  if (def.schedule_type === 'weekly') return `Every ${DAY_NAMES[def.day_of_week ?? 0]} · ${def.due_time}`
  return `Every ${def.interval_days} day${def.interval_days === 1 ? '' : 's'} · ${def.due_time}`
}

// The count of consecutive MISSED occurrences counting back from the most
// recently resolved one (submitted or missed) — the currently-open pending
// occurrence, if any, is excluded since it hasn't been resolved yet. This
// is exactly the "missed the last two reports" signal an admin wants at a
// glance, without digging into the full history.
function missedStreak(resolvedDesc: { status: string }[]): number {
  let streak = 0
  for (const s of resolvedDesc) {
    if (s.status !== 'missed') break
    streak++
  }
  return streak
}

reportTrackerRouter.get('/report-tracker/definitions', async (req, res) => {
  const organizationId = req.user?.organizationId ?? undefined

  let query = db
    .selectFrom('report_definitions')
    .leftJoin('contacts', 'contacts.id', 'report_definitions.contact_id')
    .select([
      'report_definitions.id',
      'report_definitions.name',
      'report_definitions.description',
      'report_definitions.recipient_jid',
      'report_definitions.schedule_type',
      'report_definitions.day_of_week',
      'report_definitions.interval_days',
      'report_definitions.due_time',
      'report_definitions.enabled',
      'report_definitions.next_due_at',
      'report_definitions.created_at',
      'contacts.display_name as contactName'
    ])
    .orderBy('report_definitions.created_at', 'desc')

  if (organizationId !== undefined) query = query.where('report_definitions.organization_id', '=', organizationId)

  const rows = await query.execute()

  const definitions = await Promise.all(
    rows.map(async (r) => {
      const recent = await db
        .selectFrom('report_submissions')
        .select(['id', 'status', 'due_at'])
        .where('report_definition_id', '=', r.id)
        .orderBy('due_at', 'desc')
        .limit(10)
        .execute()

      const current = recent.find((s) => s.status === 'pending') ?? null
      const resolved = recent.filter((s) => s.status !== 'pending')
      const totalCounts = await db
        .selectFrom('report_submissions')
        .select((eb) => [
          eb.fn.count<number>('id').filterWhere('status', '=', 'submitted').as('submitted'),
          eb.fn.count<number>('id').filterWhere('status', '=', 'missed').as('missed')
        ])
        .where('report_definition_id', '=', r.id)
        .executeTakeFirst()

      return {
        ...r,
        recipientName: r.contactName ?? r.recipient_jid.split('@')[0],
        scheduleLabel: scheduleLabel(r),
        currentStatus: current?.status ?? null,
        currentDueAt: current?.due_at ?? null,
        missedStreak: missedStreak(resolved),
        totalSubmitted: Number(totalCounts?.submitted ?? 0),
        totalMissed: Number(totalCounts?.missed ?? 0)
      }
    })
  )

  let contactsQuery = db.selectFrom('contacts').select(['id', 'phone_number', 'display_name']).orderBy('display_name', 'asc').limit(500)
  if (organizationId !== undefined) contactsQuery = contactsQuery.where('organization_id', '=', organizationId)
  const contacts = await contactsQuery.execute()

  const sessions =
    organizationId === undefined
      ? []
      : getConnectedSessionsForOrganization(organizationId).map((s) => ({
          id: s.sessionId,
          label: s.label,
          phoneNumber: maskPhoneNumber(s.phoneNumber),
          isPrimary: s.isPrimary
        }))

  res.json({ definitions, contacts, sessions })
})

reportTrackerRouter.post('/report-tracker/definitions', async (req, res) => {
  const parsed = reportDefinitionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' })
    return
  }

  const organizationId = req.user?.organizationId
  if (!organizationId) {
    res.status(400).json({ error: 'Only an organization account can create a report schedule.' })
    return
  }

  const { name, description, contact_id, phone_number, schedule_type, day_of_week, interval_days, due_time, whatsapp_session_id } = parsed.data

  let resolvedContactId: number | null = null
  let recipientJid: string

  if (contact_id !== null) {
    const contact = await db
      .selectFrom('contacts')
      .select(['id', 'phone_number', 'wa_jid'])
      .where('id', '=', contact_id)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst()
    if (!contact) {
      res.status(400).json({ error: 'Choose a valid contact.' })
      return
    }
    resolvedContactId = contact.id
    recipientJid = contact.wa_jid ?? phoneToJid(contact.phone_number)
  } else {
    const digits = normalizePhoneDigits(phone_number)
    if (!isValidPhoneDigits(digits)) {
      res.status(400).json({ error: 'Enter a valid phone number including country code (8-15 digits).' })
      return
    }
    const contact = await db
      .insertInto('contacts')
      .values({ phone_number: digits, display_name: null, source: 'manual', created_by: req.user?.id ?? null, organization_id: organizationId })
      .onConflict((oc) => oc.columns(['organization_id', 'phone_number']).doUpdateSet({ updated_at: new Date() }))
      .returning(['id', 'wa_jid'])
      .executeTakeFirstOrThrow()
    resolvedContactId = contact.id
    recipientJid = contact.wa_jid ?? phoneToJid(digits)
  }

  // Never trust whatsapp_session_id at face value — it must be one of this
  // organization's own currently-connected sessions if given at all (null
  // is valid too: falls back to the primary session at send time).
  if (whatsapp_session_id !== null) {
    const connected = getConnectedSessionsForOrganization(organizationId)
    if (!connected.some((s) => s.sessionId === whatsapp_session_id)) {
      res.status(400).json({ error: 'The selected WhatsApp is not connected right now.' })
      return
    }
  }

  const created = await db
    .insertInto('report_definitions')
    .values({
      organization_id: organizationId,
      name,
      description: description || null,
      recipient_jid: recipientJid,
      contact_id: resolvedContactId,
      schedule_type,
      day_of_week: schedule_type === 'weekly' ? day_of_week : null,
      interval_days: schedule_type === 'interval' ? interval_days : null,
      due_time,
      whatsapp_session_id,
      created_by_session_id: null,
      created_by: req.user?.id ?? null
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  await scheduleNextReportOccurrence(created.id)

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: 'report_definition_created',
    entityType: 'report_definition',
    entityId: created.id,
    metadata: { name, scheduleType: schedule_type, dayOfWeek: day_of_week, intervalDays: interval_days, dueTime: due_time },
    ipAddress: req.ip
  })

  res.status(201).json({ id: created.id })
})

reportTrackerRouter.post('/report-tracker/definitions/:id/toggle', async (req, res) => {
  const id = Number(req.params.id)
  let query = db.selectFrom('report_definitions').selectAll().where('id', '=', id)
  if (req.user?.organizationId) query = query.where('organization_id', '=', req.user.organizationId)
  const def = await query.executeTakeFirst()
  if (!def) {
    res.status(404).json({ error: 'Report not found.' })
    return
  }

  const nextEnabled = !def.enabled
  await db.updateTable('report_definitions').set({ enabled: nextEnabled, updated_at: new Date() }).where('id', '=', id).execute()

  if (nextEnabled) await scheduleNextReportOccurrence(id)

  await recordAuditLog({
    userId: req.user?.id ?? null,
    action: nextEnabled ? 'report_definition_enabled' : 'report_definition_disabled',
    entityType: 'report_definition',
    entityId: id,
    ipAddress: req.ip
  })

  res.status(204).end()
})

reportTrackerRouter.delete('/report-tracker/definitions/:id', async (req, res) => {
  const id = Number(req.params.id)
  let query = db.selectFrom('report_definitions').select('id').where('id', '=', id)
  if (req.user?.organizationId) query = query.where('organization_id', '=', req.user.organizationId)
  const def = await query.executeTakeFirst()

  if (def) {
    await db.deleteFrom('report_definitions').where('id', '=', id).execute()
    await recordAuditLog({
      userId: req.user?.id ?? null,
      action: 'report_definition_deleted',
      entityType: 'report_definition',
      entityId: id,
      ipAddress: req.ip
    })
  }

  res.status(204).end()
})

reportTrackerRouter.get('/report-tracker/definitions/:id/submissions', async (req, res) => {
  const id = Number(req.params.id)
  let owned = db.selectFrom('report_definitions').select('id').where('id', '=', id)
  if (req.user?.organizationId) owned = owned.where('organization_id', '=', req.user.organizationId)
  if (!(await owned.executeTakeFirst())) {
    res.status(404).json({ error: 'Report not found.' })
    return
  }

  const rows = await db
    .selectFrom('report_submissions')
    .select(['id', 'due_at', 'status', 'submitted_at', 'submission_text', 'submission_media_path', 'submission_media_mimetype'])
    .where('report_definition_id', '=', id)
    .orderBy('due_at', 'desc')
    .limit(100)
    .execute()

  const submissions = await Promise.all(
    rows.map(async (s) => ({
      ...s,
      mediaUrl: s.submission_media_path ? await getMediaSignedUrl(s.submission_media_path) : null
    }))
  )

  res.json({ submissions })
})

// Exposed for the create form's "next due" preview — same computation the
// scheduler itself uses, so what the admin sees while picking a schedule
// matches exactly what actually gets scheduled.
reportTrackerRouter.get('/report-tracker/preview-next-due', (req, res) => {
  const scheduleType = typeof req.query.schedule_type === 'string' ? req.query.schedule_type : ''
  const dueTime = typeof req.query.due_time === 'string' ? req.query.due_time : ''
  if (!dueTime || !/^\d{2}:\d{2}$/.test(dueTime)) {
    res.status(400).json({ error: 'Invalid due time.' })
    return
  }

  if (scheduleType === 'weekly') {
    const dayOfWeek = Number(req.query.day_of_week)
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      res.status(400).json({ error: 'Invalid day of week.' })
      return
    }
    res.json({ nextDueAt: nextWeeklyOccurrence(dayOfWeek, dueTime).toISOString() })
    return
  }

  if (scheduleType === 'interval') {
    const intervalDays = Number(req.query.interval_days)
    if (!Number.isInteger(intervalDays) || intervalDays < 1) {
      res.status(400).json({ error: 'Invalid interval.' })
      return
    }
    res.json({ nextDueAt: nextIntervalDaysTime(intervalDays, dueTime).toISOString() })
    return
  }

  res.status(400).json({ error: 'Invalid schedule type.' })
})
