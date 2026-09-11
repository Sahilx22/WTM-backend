import './config/paths.js'
import { env } from './config/env.js'
import { app } from './app.js'
import { pool, getPoolStats } from './db/index.js'
import { bootAllSessions, shutdownAllSockets } from './whatsapp/connectionManager.js'
import { stopBoss } from './queue/boss.js'
import { initQueueLifecycle } from './queue/lifecycle.js'

const server = app.listen(env.PORT, () => {
  console.log(`WA Messenger listening on http://localhost:${env.PORT}`)
})

// Render (and most PaaS hosts) send SIGTERM to the old instance on every
// deploy. Without this, the process dies with its Postgres connections still
// open — Supabase's pooler only reclaims those once its own timeout notices
// the socket is dead, so repeated deploys can silently pile up idle
// connections until unrelated requests start failing with pool-exhaustion
// errors. A 10s hard-exit fallback guards against any one step hanging.
let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, shutting down gracefully…`)

  const forceExit = setTimeout(() => {
    console.warn('Graceful shutdown timed out — forcing exit.')
    process.exit(1)
  }, 10_000)
  forceExit.unref()

  try {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    console.error('Error closing HTTP server:', err)
  }

  // Best-effort — never blocks the rest of shutdown on a socket that won't
  // close cleanly. Also cancels pending reconnect timers, so nothing tries
  // to open a fresh DB query after the pool below is gone.
  shutdownAllSockets()

  try {
    await stopBoss()
  } catch (err) {
    console.error('Error stopping pg-boss:', err)
  }

  // pool.end() is only ever called here, on process shutdown — never after
  // a request, message, or job. Logged so a stuck shutdown (something still
  // holding a connection) is visible instead of silently hanging until the
  // 10s force-exit fallback below fires.
  console.log('Postgres pool before close:', getPoolStats())
  try {
    await pool.end()
  } catch (err) {
    console.error('Error closing Postgres pool:', err)
  }

  clearTimeout(forceExit)
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

// Starts/stops pg-boss (reminders, auto-reports, digests, the outgoing
// queue) in step with whether any WhatsApp session is connected anywhere —
// see queue/lifecycle.ts. Registered before bootAllSessions() so it's ready
// to react the moment any resumed session reconnects.
initQueueLifecycle()

// Resume every organization's previously-created WhatsApp session(s) on
// boot. A session with no saved creds yet just comes up at qr_pending.
void bootAllSessions().catch((err) => {
  console.error('Initial WhatsApp session bootstrap failed:', err)
})
