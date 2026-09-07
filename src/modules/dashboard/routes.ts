import { Router } from 'express'
import { sql } from 'kysely'
import { db } from '../../db/index.js'
import { getSnapshot, maskPhoneNumber } from '../../whatsapp/connectionManager.js'
import { getRateLimitConfig } from '../../queue/rateLimiter.js'

export const dashboardRouter = Router()

dashboardRouter.get('/dashboard', async (_req, res) => {
  const todayStart = sql<Date>`date_trunc('day', now())`

  // One aggregate query covers every messages-table stat the dashboard needs
  // (today's counts, the pending queue depth, and the rolling send-rate
  // windows) instead of six separate round trips — each FILTER clause scans
  // the same result set Postgres already has to read once.
  const [messageStats, totalContacts, activeBatches, recentActivity, lastSent, rateLimitConfig] = await Promise.all([
    db
      .selectFrom('messages')
      .select((eb) => [
        eb.fn.count<number>('id').filterWhere('sent_at', '>=', todayStart).as('sentToday'),
        eb.fn
          .count<number>('id')
          .filterWhere((fb) => fb.and([fb('status', 'in', ['delivered', 'read']), fb('sent_at', '>=', todayStart)]))
          .as('deliveredToday'),
        eb.fn
          .count<number>('id')
          .filterWhere((fb) => fb.and([fb('status', '=', 'failed'), fb('updated_at', '>=', todayStart)]))
          .as('failedToday'),
        eb.fn.count<number>('id').filterWhere('status', 'in', ['scheduled', 'queued', 'sending']).as('pending'),
        eb.fn
          .count<number>('id')
          .filterWhere('sent_at', '>=', sql<Date>`now() - interval '60 seconds'`)
          .as('perMinute'),
        eb.fn
          .count<number>('id')
          .filterWhere('sent_at', '>=', sql<Date>`now() - interval '1 hour'`)
          .as('perHour')
      ])
      .executeTakeFirstOrThrow(),
    db.selectFrom('contacts').select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow(),
    db
      .selectFrom('campaigns')
      .select((eb) => eb.fn.count<number>('batch_id').distinct().as('count'))
      .where('status', 'in', ['scheduled', 'sending'])
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('messages')
      .leftJoin('campaigns', 'campaigns.id', 'messages.campaign_id')
      .select([
        'messages.id',
        'messages.recipient_jid',
        'messages.message_type',
        'messages.status',
        'messages.updated_at',
        'campaigns.name as campaignName'
      ])
      .orderBy('messages.updated_at', 'desc')
      .limit(10)
      .execute(),
    db
      .selectFrom('messages')
      .select(['recipient_jid', 'status', 'sent_at'])
      .where('sent_at', 'is not', null)
      .orderBy('sent_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst(),
    getRateLimitConfig()
  ])

  const snapshot = getSnapshot()

  res.json({
    stats: {
      sentToday: Number(messageStats.sentToday),
      deliveredToday: Number(messageStats.deliveredToday),
      failedToday: Number(messageStats.failedToday),
      pending: Number(messageStats.pending),
      totalContacts: Number(totalContacts.count),
      activeBatches: Number(activeBatches.count)
    },
    recentActivity,
    lastSent,
    connection: { ...snapshot, maskedPhoneNumber: maskPhoneNumber(snapshot.phoneNumber) },
    rateLimitConfig,
    rollingCounts: { perMinute: Number(messageStats.perMinute), perHour: Number(messageStats.perHour) }
  })
})
