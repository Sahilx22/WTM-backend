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

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  ssl: isLocalDb ? undefined : { rejectUnauthorized: false }
})

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err)
})

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool })
})
