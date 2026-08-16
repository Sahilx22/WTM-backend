import { Router } from 'express'
import { sql } from 'kysely'
import { db } from '../../db/index.js'
import { getSnapshot, maskPhoneNumber } from '../../whatsapp/connectionManager.js'
import { getRateLimitConfig, getRollingSendCounts } from '../../queue/rateLimiter.js'

export const dashboardRouter = Router()

dashboardRouter.get('/dashboard', async (_req, res) => {
  const todayStart = sql<Date>`date_trunc('day', now())`

  const [
    sentToday,
    deliveredToday,
    failedToday,
    pending,
    totalContacts,
    activeBatches,
    recentActivity,
    lastSent,
    rateLimitConfig,
    rollingCounts
  ] = await Promise.all([
    db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('sent_at', '>=', todayStart)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('status', 'in', ['delivered', 'read'])
      .where('sent_at', '>=', todayStart)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('status', '=', 'failed')
      .where('updated_at', '>=', todayStart)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('status', 'in', ['scheduled', 'queued', 'sending'])
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
    getRateLimitConfig(),
    getRollingSendCounts()
  ])

  const snapshot = getSnapshot()

  res.json({
    stats: {
      sentToday: Number(sentToday.count),
      deliveredToday: Number(deliveredToday.count),
      failedToday: Number(failedToday.count),
      pending: Number(pending.count),
      totalContacts: Number(totalContacts.count),
      activeBatches: Number(activeBatches.count)
    },
    recentActivity,
    lastSent,
    connection: { ...snapshot, maskedPhoneNumber: maskPhoneNumber(snapshot.phoneNumber) },
    rateLimitConfig,
    rollingCounts
  })
})
