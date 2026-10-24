import { env } from '../config/env.js'

// Per-organization hourly cap on AI requests, shared by WhatsApp "@ai"
// messages and the portal's AI Assistant page so both draw on one budget.
// In memory: it resets on restart, which is fine for a cost guard.
const requestTimes = new Map<number, number[]>()

export function takeAiRateLimitSlot(organizationId: number): boolean {
  const cutoff = Date.now() - 60 * 60_000
  const times = (requestTimes.get(organizationId) ?? []).filter((t) => t > cutoff)
  if (times.length >= env.AI_MAX_REQUESTS_PER_HOUR) {
    requestTimes.set(organizationId, times)
    return false
  }
  times.push(Date.now())
  requestTimes.set(organizationId, times)
  return true
}
