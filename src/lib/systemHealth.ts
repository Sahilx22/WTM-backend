import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config/paths.js'
import { logger } from './logger.js'

// In-memory record of what's gone wrong recently, plus a crash report that
// survives a process restart (written to the persistent data volume). This
// is what /api/health and /api/system/health report from — the point is
// that when something breaks, the *reason* is visible without having to dig
// through container logs, and a crash-and-restart is never silent.

export type IncidentType =
  | 'session_boot_failed'
  | 'session_boot_recovered'
  | 'session_disconnected'
  | 'session_logged_out'
  | 'session_reconnect_failed'
  | 'session_watchdog_restart'
  | 'primary_session_down'
  | 'primary_session_recovered'
  | 'db_unreachable'
  | 'db_recovered'
  | 'queue_start_failed'
  | 'queue_error'
  | 'transient_db_error'
  | 'unhandled_rejection'
  | 'process_crashed'

export interface Incident {
  at: string
  type: IncidentType
  message: string
  details?: Record<string, unknown>
}

export interface CrashReport {
  at: string
  message: string
  stack: string | null
  pid: number
  uptimeSeconds: number
}

const MAX_INCIDENTS = 100
const incidents: Incident[] = []

const CRASH_FILE = path.join(DATA_DIR, 'last-crash.json')
const CRASH_HISTORY_FILE = path.join(DATA_DIR, 'crash-history.jsonl')

export const health = {
  startedAt: new Date().toISOString(),
  sessionsBoot: {
    ok: false,
    attempts: 0,
    lastError: null as string | null,
    lastErrorAt: null as string | null,
    succeededAt: null as string | null
  },
  db: {
    ok: true,
    lastCheckAt: null as string | null,
    lastError: null as string | null,
    downSince: null as string | null
  },
  previousCrash: null as CrashReport | null
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

export function recordIncident(type: IncidentType, message: string, details?: Record<string, unknown>): void {
  incidents.push({ at: new Date().toISOString(), type, message, ...(details ? { details } : {}) })
  if (incidents.length > MAX_INCIDENTS) incidents.splice(0, incidents.length - MAX_INCIDENTS)
}

export function listIncidents(): Incident[] {
  return [...incidents].reverse()
}

// Synchronous on purpose — called from an uncaughtException handler right
// before the process exits, where nothing async is guaranteed to finish.
export function writeCrashReport(err: unknown): void {
  const report: CrashReport = {
    at: new Date().toISOString(),
    message: errorMessage(err),
    stack: err instanceof Error ? (err.stack ?? null) : null,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime())
  }
  try {
    fs.writeFileSync(CRASH_FILE, JSON.stringify(report, null, 2))
    fs.appendFileSync(CRASH_HISTORY_FILE, JSON.stringify(report) + '\n')
  } catch (writeErr) {
    logger.error({ err: writeErr }, 'failed to write crash report')
  }
}

// Called once at boot — if the previous process died from a crash, surface
// it loudly (logs + health endpoint + incident list) instead of letting the
// restart quietly paper over it.
export function loadPreviousCrash(): CrashReport | null {
  try {
    if (!fs.existsSync(CRASH_FILE)) return null
    const report = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8')) as CrashReport
    fs.rmSync(CRASH_FILE, { force: true })
    health.previousCrash = report
    recordIncident('process_crashed', `Previous server process crashed: ${report.message}`, {
      crashedAt: report.at,
      uptimeSeconds: report.uptimeSeconds
    })
    logger.error({ crash: report }, `previous server process crashed at ${report.at}: ${report.message}`)
    return report
  } catch (err) {
    logger.error({ err }, 'failed to read previous crash report')
    return null
  }
}
