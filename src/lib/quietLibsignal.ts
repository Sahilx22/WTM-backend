// libsignal (used inside Baileys) prints a full SessionEntry dump — dozens
// of lines of key buffers — via console.* on every routine session rotation.
// That noise is what buried the one line that explained a multi-day
// production outage. These are normal, harmless events; drop just them and
// let every other console message through untouched.
const NOISY_PREFIXES = [
  'Closing session',
  'Closing open session',
  'Removing old closed session',
  'Session already closed',
  'Session already open',
  'Migrating session to',
  'Opening session',
  'Decrypted message with closed session'
]

function isNoise(args: unknown[]): boolean {
  const first = args[0]
  return typeof first === 'string' && NOISY_PREFIXES.some((p) => first.startsWith(p))
}

for (const method of ['log', 'info', 'warn'] as const) {
  const original = console[method].bind(console)
  console[method] = (...args: unknown[]) => {
    if (!isNoise(args)) original(...args)
  }
}
