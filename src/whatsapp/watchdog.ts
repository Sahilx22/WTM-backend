import { sql } from 'kysely'
import { db } from '../db/index.js'
import { logger } from '../lib/logger.js'
import { recordAuditLog } from '../lib/auditLog.js'
import { health, recordIncident, errorMessage, listIncidents } from '../lib/systemHealth.js'
import { isBossStarted } from '../queue/boss.js'
import { ensureQueuesRunning } from '../queue/lifecycle.js'
import { hasSavedCreds, isAnySessionConnected, listRuntimeStates, reviveStalledSessions } from './connectionManager.js'

// Second line of defence behind the per-session reconnect backoff in
// connectionManager.ts. Every minute it:
//   1. pings the database and records outages/recoveries,
//   2. revives any linked session that isn't connected and has no retry
//      pending (i.e. fell out of its reconnect chain for any reason),
//   3. makes sure the reminder/report queues are actually running whenever
//      a session is connected (they can fail to start and stay off),
//   4. flags any organization whose PRIMARY session has been down for more
//      than PRIMARY_DOWN_ALERT_MS — reminders and auto-reports for that org
//      only ever go out through the primary, so this is the condition that
//      actually means "reminders are not being sent".
// Each problem is logged once when it starts and once when it clears, not
// every minute, so the logs stay readable.

const INTERVAL_MS = 60_000
const PRIMARY_DOWN_ALERT_MS = 10 * 60_000

let timer: NodeJS.Timeout | null = null
let running = false
const primaryAlerted = new Set<number>()

async function checkDatabase(): Promise<boolean> {
  const now = new Date().toISOString()
  try {
    await sql`select 1`.execute(db)
    health.db.lastCheckAt = now
    if (!health.db.ok) {
      logger.warn({ downSince: health.db.downSince }, 'database is reachable again')
      recordIncident('db_recovered', `Database reachable again (down since ${health.db.downSince})`)
    }
    health.db.ok = true
    health.db.lastError = null
    health.db.downSince = null
    return true
  } catch (err) {
    health.db.lastCheckAt = now
    health.db.lastError = errorMessage(err)
    if (health.db.ok) {
      health.db.downSince = now
      logger.error({ err }, 'database is unreachable')
      recordIncident('db_unreachable', `Database unreachable: ${errorMessage(err)}`)
    }
    health.db.ok = false
    return false
  }
}

function checkPrimarySessions(): void {
  const states = listRuntimeStates()
  const now = Date.now()
  for (const s of states.filter((x) => x.isPrimary)) {
    const live = s.status === 'connected' && s.hasSocket
    if (live) {
      if (primaryAlerted.delete(s.organizationId)) {
        logger.warn({ sessionId: s.sessionId, organizationId: s.organizationId }, 'primary WhatsApp session is connected again — reminders resume')
        recordIncident('primary_session_recovered', `Organization ${s.organizationId}'s primary session (${s.label ?? s.sessionId}) is connected again`)
      }
      continue
    }
    const downFor = s.disconnectedSince ? now - s.disconnectedSince : 0
    if (downFor < PRIMARY_DOWN_ALERT_MS || primaryAlerted.has(s.organizationId)) continue
    primaryAlerted.add(s.organizationId)
    const message =
      `Organization ${s.organizationId}'s primary session (${s.label ?? s.sessionId}) has not been connected for ` +
      `${Math.round(downFor / 60_000)} min (status: ${s.status}, reason: ${s.lastDisconnectReason ?? 'unknown'}) — ` +
      'reminders and auto-reports for this organization are NOT being sent'
    logger.error({ sessionId: s.sessionId, organizationId: s.organizationId, status: s.status }, message)
    recordIncident('primary_session_down', message, { sessionId: s.sessionId, organizationId: s.organizationId })
    recordAuditLog({
      userId: null,
      action: 'whatsapp_primary_down',
      entityType: 'whatsapp_connection',
      entityId: s.sessionId,
      metadata: { status: s.status, reason: s.lastDisconnectReason, downForMinutes: Math.round(downFor / 60_000) }
    }).catch((err) => logger.error({ err }, 'failed to write whatsapp_primary_down audit log'))
  }
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const dbOk = await checkDatabase()
    if (dbOk && health.sessionsBoot.ok) {
      const revived = await reviveStalledSessions()
      if (revived.length > 0) {
        logger.warn({ sessionIds: revived }, 'watchdog: linked WhatsApp sessions were not connected and had no retry pending — reconnecting')
        recordIncident('session_watchdog_restart', `Watchdog restarted stalled session(s): ${revived.join(', ')}`, { sessionIds: revived })
      }
    }
    if (isAnySessionConnected() && !isBossStarted()) {
      logger.warn('watchdog: a session is connected but the queue workers are not running — starting them')
      await ensureQueuesRunning()
    }
    checkPrimarySessions()
  } catch (err) {
    logger.error({ err }, 'watchdog tick failed')
  } finally {
    running = false
  }
}

const BOOT_GRACE_MS = 2 * 60_000

// `problems` is empty when everything that should be running is running.
// Public /api/health exposes only the summary (no names, numbers or error
// text); the full report is behind super-admin auth.
export function buildHealthReport() {
  const now = Date.now()
  const sessions = listRuntimeStates().map((s) => ({
    ...s,
    linked: hasSavedCreds(s.sessionId),
    live: s.status === 'connected' && s.hasSocket,
    disconnectedSince: s.disconnectedSince ? new Date(s.disconnectedSince).toISOString() : null
  }))
  const problems: string[] = []
  if (!health.db.ok) problems.push(`database unreachable since ${health.db.downSince}: ${health.db.lastError}`)
  if (!health.sessionsBoot.ok && now - Date.parse(health.startedAt) > BOOT_GRACE_MS) {
    problems.push(`WhatsApp sessions not booted after ${health.sessionsBoot.attempts} attempts: ${health.sessionsBoot.lastError}`)
  }
  for (const s of sessions) {
    if (!s.isPrimary || s.live) continue
    const downFor = s.disconnectedSince ? now - Date.parse(s.disconnectedSince) : 0
    if (downFor >= PRIMARY_DOWN_ALERT_MS) {
      problems.push(
        `organization ${s.organizationId} primary session ${s.sessionId} not connected for ${Math.round(downFor / 60_000)} min ` +
          `(status ${s.status}${s.linked ? '' : ', needs QR scan'}) — reminders for this org are not being sent`
      )
    }
  }
  if (sessions.some((s) => s.live) && !isBossStarted()) problems.push('a session is connected but queue workers are not running')

  return {
    status: problems.length === 0 ? ('ok' as const) : ('degraded' as const),
    problems,
    startedAt: health.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    db: health.db,
    sessionsBoot: health.sessionsBoot,
    queuesRunning: isBossStarted(),
    sessions,
    previousCrash: health.previousCrash,
    recentIncidents: listIncidents().slice(0, 50)
  }
}

export function startWatchdog(): void {
  if (timer) return
  timer = setInterval(() => void tick(), INTERVAL_MS)
  timer.unref()
}

export function stopWatchdog(): void {
  if (timer) clearInterval(timer)
  timer = null
}
