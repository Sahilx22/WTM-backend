import path from 'node:path'
import fs from 'node:fs'

// process.cwd() is reliable here because both `npm run dev` (tsx, from src/)
// and `npm start` (node dist/server.js) are always launched with the project
// root as the working directory — unlike a relative __dirname walk, this
// doesn't break when the compiled output gains an extra `dist/` directory
// level that the dev (tsx-on-src) path never had.
export const ROOT_DIR = process.cwd()
export const DATA_DIR = path.join(ROOT_DIR, 'data')
export const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys')
export const CSV_IMPORT_DIR = path.join(DATA_DIR, 'csv-imports')

for (const dir of [DATA_DIR, AUTH_DIR, CSV_IMPORT_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}
