import pino from 'pino'
import { isProduction } from '../config/env.js'

// The app's own operational logger — connection lifecycle, boot/retry,
// watchdog, queue start/stop, crashes. Deliberately 'info' in production
// (override with LOG_LEVEL): the previous 'error'-only level hid every
// connect/disconnect/retry event, which is exactly how a session bootstrap
// failure once left production silently dead for days with nothing in the
// logs to explain it. Baileys' own (very chatty) internal logger is kept
// separate and stays at 'error' — see whatsapp/connectionManager.ts.
export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  base: { app: 'wa-automation' },
  timestamp: pino.stdTimeFunctions.isoTime
})
