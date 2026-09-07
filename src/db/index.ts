import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import type { Database } from './schema.js'
import { env } from '../config/env.js'

// Hosted Postgres (Supabase et al.) rejects unencrypted connections, unlike
// a bare local dev instance — enable SSL for anything that isn't localhost.
// `rejectUnauthorized: false` because these providers' certs commonly aren't
// in Node's default trust store; the connection is still encrypted, just not
// strictly cert-pinned.
const isLocalDb = /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)

// Kept deliberately small — this and pg-boss's own pool (queue/boss.ts) both
// draw from the same hosted Postgres connection cap (Supabase's session
// pooler in particular allows far fewer concurrent sessions than a raw
// Postgres instance would), so an oversized `max` here risks exhausting it
// under nothing more than ordinary concurrent traffic.
export const pool = new Pool({
  application_name: 'wa-automation-api',
  connectionString: env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false }
})

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err)
})

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool })
})
