import { sql } from 'kysely'
import { db } from '../db/index.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function loadConfig() {
  return db.selectFrom('rate_limit_config').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
}

export async function getRateLimitConfig() {
  return loadConfig()
}

export async function getRollingSendCounts(): Promise<{ perMinute: number; perHour: number }> {
  const perMinute = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('sent_at', '>=', sql<Date>`now() - interval '60 seconds'`)
    .executeTakeFirstOrThrow()

  const perHour = await db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('sent_at', '>=', sql<Date>`now() - interval '1 hour'`)
    .executeTakeFirstOrThrow()

  return { perMinute: Number(perMinute.count), perHour: Number(perHour.count) }
}

export interface RateOverride {
  minDelayMs?: number
  maxDelayMs?: number
}

// Waits until the queue is unpaused and there's rolling-window capacity, then
// applies a randomized inter-send delay. This is the one place send timing is
// controlled — Baileys itself imposes no documented rate, so this is our own
// safety margin against WhatsApp's anti-spam systems.
//
// A campaign may narrow its own delay window (e.g. to go slower than the
// global default for a sensitive audience), but never faster than the global
// floor — the override can only make sending more conservative.
export async function waitForSendSlot(override?: RateOverride | null): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cfg = await loadConfig()
    if (!cfg.is_paused) break
    await sleep(5000)
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cfg = await loadConfig()
    if (cfg.is_paused) continue // dropped back into paused state while waiting for capacity

    const perMinute = await db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('sent_at', '>=', sql<Date>`now() - interval '60 seconds'`)
      .executeTakeFirstOrThrow()

    const perHour = await db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('sent_at', '>=', sql<Date>`now() - interval '1 hour'`)
      .executeTakeFirstOrThrow()

    if (Number(perMinute.count) < cfg.max_per_minute && Number(perHour.count) < cfg.max_per_hour) {
      const minDelay = Math.max(cfg.min_delay_ms, override?.minDelayMs ?? cfg.min_delay_ms)
      const maxDelay = Math.max(minDelay, Math.max(cfg.min_delay_ms, override?.maxDelayMs ?? cfg.max_delay_ms))
      const delay = randomInt(minDelay, maxDelay)
      await sleep(delay)
      return
    }

    await sleep(2000)
  }
}

let consecutiveFailures = 0

export async function recordSendOutcome(success: boolean): Promise<void> {
  if (success) {
    consecutiveFailures = 0
    return
  }

  consecutiveFailures += 1
  const cfg = await loadConfig()

  if (consecutiveFailures >= cfg.pause_after_consecutive_failures && !cfg.is_paused) {
    await db
      .updateTable('rate_limit_config')
      .set({ is_paused: true, updated_at: new Date() })
      .where('id', '=', 1)
      .execute()
  }
}

export function resetConsecutiveFailureCounter(): void {
  consecutiveFailures = 0
}
