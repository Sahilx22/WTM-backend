// Fully resets the database: drops the entire `public` schema (every table,
// including Kysely's own migration-tracking tables) and recreates it empty.
// After this, `npm run migrate` rebuilds everything from scratch — tables
// AND their seed rows (rate_limit_config/task_settings/whatsapp_connection),
// since seeding happens inside the migrations themselves.
//
// This is NOT the same as TRUNCATE: truncating empties rows but leaves the
// tables (and Kysely's tracking table) in place, so a subsequent `migrate`
// fails with "relation already exists" instead of rebuilding cleanly.
//
// Destructive and irreversible. Requires --yes to actually run.
import { Pool } from 'pg'
import { env } from '../src/config/env.js'

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('This deletes EVERY table and ALL data in the database this app is configured to use.')
    console.error(`Target: ${env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`)
    console.error('Re-run with --yes to confirm: npm run db:reset -- --yes')
    process.exit(1)
  }

  const isLocalDb = /localhost|127\.0\.0\.1/.test(env.DATABASE_URL)
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: isLocalDb ? undefined : { rejectUnauthorized: false }
  })

  console.log('Dropping and recreating the public schema...')
  await pool.query('DROP SCHEMA public CASCADE')
  await pool.query('CREATE SCHEMA public')
  await pool.end()

  console.log('Done. The database is now empty — run `npm run migrate` to rebuild it.')
}

main().catch((err) => {
  console.error('Reset failed:', err)
  process.exit(1)
})
