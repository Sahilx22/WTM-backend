import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FileMigrationProvider, Migrator } from 'kysely/migration'
import { db } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({
    fs,
    path,
    migrationFolder: path.join(__dirname, 'migrations'),
    // Kysely's default `import(filePath)` passes a raw filesystem path, which
    // Node's ESM loader rejects on Windows (drive letters aren't a valid URL
    // scheme) — importing via a proper file:// URL works on every platform.
    import: (filePath) => import(pathToFileURL(filePath).href)
  })
})

async function run() {
  const direction = process.argv[2]

  const { error, results } =
    direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest()

  for (const result of results ?? []) {
    if (result.status === 'Success') {
      console.log(`✓ migration "${result.migrationName}" executed (${result.direction})`)
    } else if (result.status === 'Error') {
      console.error(`✗ migration "${result.migrationName}" failed (${result.direction})`)
    }
  }

  if (error) {
    console.error('Migration run failed:', error)
    process.exit(1)
  }

  if (!results || results.length === 0) {
    console.log('No migrations to run.')
  }

  await db.destroy()
}

run()
