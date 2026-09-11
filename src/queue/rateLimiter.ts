import { sql } from 'kysely'
import { db } from '../db/index.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function loadConfig(organizationId: number) {
  return db.selectFrom('rate_limit_config').selectAll().where('organization_id', '=', organizationId).executeTakeFirstOrThrow()
}

export async function getRateLimitConfig(organizationId: number) {
  return loadConfig(organizationId)
}

export async function getRollingSendCounts(organizationId: number): Promise<{ perMinute: number; perHour: number }> {
  const row = await db
    .selectFrom('messages')
    .where('organization_id', '=', organizationId)
    .select((eb) => [
      eb.fn
        .count<number>('id')
        .filterWhere('sent_at', '>=', sql<Date>`now() - interval '60 seconds'`)
        .as('perMinute'),
      eb.fn
        .count<number>('id')
        .filterWhere('sent_at', '>=', sql<Date>`now() - interval '1 hour'`)
        .as('perHour')
    ])
    .executeTakeFirstOrThrow()

  return { perMinute: Number(row.perMinute), perHour: Number(row.perHour) }
}

export interface RateOverride {
  minDelayMs?: number
  maxDelayMs?: number
}

// Waits until this organization's own queue is unpaused and has rolling-
// window capacity, then applies a randomized inter-send delay. This is the
// one place send timing is controlled — Baileys itself imposes no documented
// rate, so this is our own safety margin against WhatsApp's anti-spam
// systems. Every organization has its own independent limits/pause state
// (see migration 036) — one org sending heavily, failing repeatedly, or
// being paused never throttles or pauses any other organization's sends.
//
// A campaign may narrow its own delay window (e.g. to go slower than the
// org's default for a sensitive audience), but never faster than the org's
// own floor — the override can only make sending more conservative.
export async function waitForSendSlot(organizationId: number, override?: RateOverride | null): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cfg = await loadConfig(organizationId)
    if (!cfg.is_paused) break
    await sleep(5000)
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cfg = await loadConfig(organizationId)
    if (cfg.is_paused) continue // dropped back into paused state while waiting for capacity

    const { perMinute, perHour } = await getRollingSendCounts(organizationId)

    if (perMinute < cfg.max_per_minute && perHour < cfg.max_per_hour) {
      const minDelay = Math.max(cfg.min_delay_ms, override?.minDelayMs ?? cfg.min_delay_ms)
      const maxDelay = Math.max(minDelay, Math.max(cfg.min_delay_ms, override?.maxDelayMs ?? cfg.max_delay_ms))
      const delay = randomInt(minDelay, maxDelay)
      await sleep(delay)
      return
    }

    await sleep(2000)
  }
}

const consecutiveFailuresByOrg = new Map<number, number>()

export async function recordSendOutcome(organizationId: number, success: boolean): Promise<void> {
  if (success) {
    consecutiveFailuresByOrg.set(organizationId, 0)
    return
  }

  const failures = (consecutiveFailuresByOrg.get(organizationId) ?? 0) + 1
  consecutiveFailuresByOrg.set(organizationId, failures)
  const cfg = await loadConfig(organizationId)

  if (failures >= cfg.pause_after_consecutive_failures && !cfg.is_paused) {
    await db
      .updateTable('rate_limit_config')
      .set({ is_paused: true, updated_at: new Date() })
      .where('organization_id', '=', organizationId)
      .execute()
  }
}

export function resetConsecutiveFailureCounter(organizationId: number): void {
  consecutiveFailuresByOrg.set(organizationId, 0)
}
