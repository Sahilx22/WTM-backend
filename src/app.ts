import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { env } from './config/env.js'
import { requireAuth } from './auth/middleware.js'
import { authRouter } from './auth/routes.js'
import { connectionRouter } from './modules/connection/routes.js'
import { contactsRouter } from './modules/contacts/routes.js'
import { groupsRouter } from './modules/groups/routes.js'
import { batchesRouter } from './modules/batches/routes.js'
import { templatesRouter } from './modules/templates/routes.js'
import { messagesRouter } from './modules/messages/routes.js'
import { scheduleRouter } from './modules/schedule/routes.js'
import { campaignsRouter } from './modules/campaigns/routes.js'
import { historyRouter } from './modules/history/routes.js'
import { dashboardRouter } from './modules/dashboard/routes.js'
import { settingsRouter } from './modules/settings/routes.js'
import { organizationsRouter } from './modules/organizations/routes.js'
import { tasksRouter } from './modules/tasks/routes.js'
import { reportsRouter } from './modules/reports/routes.js'
import { notFound, errorHandler } from './middleware/errorHandler.js'
import { writeRateLimit } from './middleware/writeRateLimit.js'

export const app = express()

app.disable('x-powered-by')

// Render (and most PaaS hosts) sit the app behind one reverse proxy that
// sets X-Forwarded-For — trusting exactly one hop lets Express (and
// express-rate-limit, which refuses to run otherwise) resolve the real
// client IP instead of the proxy's, without blindly trusting an arbitrary
// chain of forwarded headers a client could spoof.
app.set('trust proxy', 1)

app.use(
  helmet({
    contentSecurityPolicy: false
  })
)

app.use(cors({ origin: env.FRONTEND_ORIGIN }))

app.use(express.urlencoded({ extended: true, limit: '1mb' }))
app.use(express.json({ limit: '1mb' }))

// Unauthenticated — used by deployment platforms (e.g. Render) for health checks.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

const apiRouter = express.Router()

apiRouter.use(authRouter)

apiRouter.use(requireAuth)
apiRouter.use(writeRateLimit)

apiRouter.use(connectionRouter)
apiRouter.use(contactsRouter)
apiRouter.use(groupsRouter)
apiRouter.use(batchesRouter)
apiRouter.use(templatesRouter)
apiRouter.use(messagesRouter)
apiRouter.use(scheduleRouter)
apiRouter.use(campaignsRouter)
apiRouter.use(historyRouter)
apiRouter.use(dashboardRouter)
apiRouter.use(settingsRouter)
apiRouter.use(organizationsRouter)
apiRouter.use(tasksRouter)
apiRouter.use(reportsRouter)

app.use('/api', apiRouter)

app.use(notFound)
app.use(errorHandler)
