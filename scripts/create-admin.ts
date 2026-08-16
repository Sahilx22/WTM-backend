import { parseArgs } from 'node:util'
import { db } from '../src/db/index.js'
import { hashPassword } from '../src/auth/passwords.js'

function printUsageAndExit(message?: string): never {
  if (message) console.error(`Error: ${message}\n`)
  console.error(
    'Usage: npm run create-admin -- --username <username> --password <password> [--name "Display Name"]'
  )
  process.exit(1)
}

async function main() {
  const { values } = parseArgs({
    options: {
      username: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string' }
    }
  })

  const username = values.username?.trim()
  const password = values.password
  const displayName = values.name?.trim() || username

  if (!username || username.length < 3) {
    printUsageAndExit('--username is required and must be at least 3 characters.')
  }
  if (!password || password.length < 8) {
    printUsageAndExit('--password is required and must be at least 8 characters.')
  }

  const existing = await db.selectFrom('users').select('id').where('username', '=', username).executeTakeFirst()
  if (existing) {
    console.error(`A user named "${username}" already exists.`)
    process.exit(1)
  }

  const passwordHash = await hashPassword(password)

  const created = await db
    .insertInto('users')
    .values({
      username,
      password_hash: passwordHash,
      display_name: displayName ?? username,
      is_active: true
    })
    .returning(['id', 'username'])
    .executeTakeFirstOrThrow()

  console.log(`Created user "${created.username}" (id ${created.id}). They can now log in at /login.`)
  await db.destroy()
}

main().catch((err) => {
  console.error('Failed to create admin user:', err)
  process.exit(1)
})
