import { Router } from 'express'
import { db } from '../../db/index.js'

export const historyRouter = Router()

const PAGE_SIZE = 50

historyRouter.get('/history', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : ''
  const messageType = typeof req.query.message_type === 'string' ? req.query.message_type : ''
  const recipientType = typeof req.query.recipient_type === 'string' ? req.query.recipient_type : ''
  const search = typeof req.query.search === 'string' ? req.query.search : ''
  const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : ''
  const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : ''
  const page = Math.max(1, Number(req.query.page) || 1)
  const organizationId = req.user?.organizationId ?? undefined

  let query = db
    .selectFrom('messages')
    .leftJoin('campaigns', 'campaigns.id', 'messages.campaign_id')
    .leftJoin('message_templates', 'message_templates.id', 'messages.template_id')
    .select([
      'messages.id',
      'messages.recipient_type',
      'messages.recipient_jid',
      'messages.message_type',
      'messages.status',
      'messages.failure_reason',
      'messages.retry_count',
      'messages.scheduled_at',
      'messages.sent_at',
      'messages.delivered_at',
      'messages.read_at',
      'messages.created_at',
      'campaigns.name as campaignName',
      'message_templates.name as templateName'
    ])

  let countQuery = db.selectFrom('messages')

  // Regular org users only ever see their own organization's message
  // history; the super admin (no organization) gets the unscoped, cross-org
  // view, same convention as tasks/contacts.
  if (organizationId !== undefined) {
    query = query.where('messages.organization_id', '=', organizationId)
    countQuery = countQuery.where('organization_id', '=', organizationId)
  }

  if (status) {
    query = query.where('messages.status', '=', status as never)
    countQuery = countQuery.where('status', '=', status as never)
  }
  if (messageType) {
    query = query.where('messages.message_type', '=', messageType as never)
    countQuery = countQuery.where('message_type', '=', messageType as never)
  }
  if (recipientType) {
    query = query.where('messages.recipient_type', '=', recipientType as never)
    countQuery = countQuery.where('recipient_type', '=', recipientType as never)
  }
  if (search.trim()) {
    const like = `%${search.trim()}%`
    query = query.where((eb) => eb.or([eb('messages.recipient_jid', 'ilike', like), eb('messages.message_text', 'ilike', like)]))
    countQuery = countQuery.where((eb) => eb.or([eb('recipient_jid', 'ilike', like), eb('message_text', 'ilike', like)]))
  }
  if (dateFrom) {
    query = query.where('messages.created_at', '>=', new Date(dateFrom))
    countQuery = countQuery.where('created_at', '>=', new Date(dateFrom))
  }
  if (dateTo) {
    const to = new Date(dateTo)
    to.setDate(to.getDate() + 1)
    query = query.where('messages.created_at', '<', to)
    countQuery = countQuery.where('created_at', '<', to)
  }

  const { count } = await countQuery.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirstOrThrow()
  const totalPages = Math.max(1, Math.ceil(Number(count) / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)

  const messages = await query
    .orderBy('messages.created_at', 'desc')
    .limit(PAGE_SIZE)
    .offset((currentPage - 1) * PAGE_SIZE)
    .execute()

  res.json({
    messages,
    pagination: {
      page: currentPage,
      pageSize: PAGE_SIZE,
      total: Number(count),
      totalPages
    },
    filters: { status, message_type: messageType, recipient_type: recipientType, search, date_from: dateFrom, date_to: dateTo }
  })
})

historyRouter.get('/history/:id/attempts', async (req, res) => {
  const id = Number(req.params.id)
  const organizationId = req.user?.organizationId ?? undefined

  // Fold the org check into the message lookup itself — a wrong-org id just
  // returns an empty list, same as the tasks/contacts pattern, rather than
  // trusting the id alone.
  let messageQuery = db.selectFrom('messages').select('id').where('id', '=', id)
  if (organizationId !== undefined) {
    messageQuery = messageQuery.where('organization_id', '=', organizationId)
  }
  const message = await messageQuery.executeTakeFirst()
  if (!message) {
    res.json({ messageId: id, attempts: [] })
    return
  }

  const attempts = await db
    .selectFrom('message_attempts')
    .selectAll()
    .where('message_id', '=', id)
    .orderBy('attempt_number', 'asc')
    .execute()

  res.json({ messageId: id, attempts })
})
