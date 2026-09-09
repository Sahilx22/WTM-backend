import path from 'node:path'
import fs from 'node:fs'

// process.cwd() is reliable here because both `npm run dev` (tsx, from src/)
// and `npm start` (node dist/server.js) are always launched with the project
// root as the working directory — unlike a relative __dirname walk, this
// doesn't break when the compiled output gains an extra `dist/` directory
// level that the dev (tsx-on-src) path never had.
export const ROOT_DIR = process.cwd()
export const DATA_DIR = path.join(ROOT_DIR, 'data')
// Legacy single-connection auth dir — unused now that each WhatsApp session
// gets its own subdirectory under AUTH_SESSIONS_DIR, kept only so old data
// isn't orphaned without explanation.
export const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys')
export const AUTH_SESSIONS_DIR = path.join(DATA_DIR, 'auth_sessions')
export const CSV_IMPORT_DIR = path.join(DATA_DIR, 'csv-imports')

for (const dir of [DATA_DIR, AUTH_DIR, AUTH_SESSIONS_DIR, CSV_IMPORT_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}
