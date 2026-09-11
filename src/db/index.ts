import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import pino from 'pino'
import type { Database } from './schema.js'
import { env, isProduction } from '../config/env.js'

const logger = pino({ level: isProduction ? 'error' : 'warn' })

// Hosted Postgres (Supabase et al.) rejects unencrypted connections, unlike
// a bare local dev instance — enable SSL for anything that isn't localhost.
// `rejectUnauthorized: false` because these providers' certs commonly aren't
// in Node's default trust store; the connection is still encrypted, just not
// strictly cert-pinned.
const isLocalDb = /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)

// This is the ONE PostgreSQL pool for the whole process — every query in
// this codebase goes through Kysely (`db`, below), which in turn draws
// exclusively from this pool. Nothing else in the app ever calls `new
// Pool()`; nothing acquires a raw client and holds it beyond a single
// query/transaction (see db.transaction().execute(...) call sites, which
// Kysely itself guarantees to acquire-use-release/rollback safely).
//
// Kept deliberately small — this and pg-boss's own pool (queue/boss.ts) both
// draw from the same hosted Postgres connection cap (Supabase's session
// pooler in particular allows far fewer concurrent sessions than a raw
// Postgres instance would — 15 total on this project's tier). Two things
// can be connected to that same database at once in practice (the always-on
// production instance, plus a local dev instance during active work), each
// running this pool AND pg-boss's own pool — so the real budget to reason
// about is (this pool's max + boss's max) × number of concurrently-running
// instances, not just this number in isolation. 3 here + 2 for pg-boss = 5
// per instance, comfortably leaving room for two instances (10) under the
// 15-connection ceiling with margin for Supabase's own platform connections.
export const pool = new Pool({
  application_name: 'wa-automation-api',
  connectionString: env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 10_000,
  // Fail fast with a clear error when the pool is already at `max` and every
  // connection is busy, instead of a query hanging indefinitely — this is
  // the pool's backpressure: callers see a timeout, not a silent stall.
  connectionTimeoutMillis: 10_000,
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false }
})

// Never logs the connection string/credentials — only counts.
export function getPoolStats(): { total: number; idle: number; waiting: number } {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
}

pool.on('error', (err) => {
  logger.error({ err, pool: getPoolStats() }, 'unexpected error on an idle Postgres client')
})

// Surfaces pool exhaustion specifically (vs. any other query error) with the
// live pool stats attached, since "why did this fail" is otherwise opaque —
// this is the one thing worth calling out beyond the generic pool.on(...)
// above, without adding an always-on polling/interval logger.
export function logIfPoolExhausted(err: unknown): void {
  const code = (err as { code?: string } | null)?.code
  if (code === '53300' /* too_many_connections */ || code === 'XX000') {
    logger.error({ err, pool: getPoolStats() }, 'query failed — Postgres connection pool likely exhausted')
  }
}

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool })
})
