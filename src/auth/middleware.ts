import type { NextFunction, Request, Response } from 'express'
import { verifyToken, type AuthTokenPayload } from './jwt.js'

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload
    }
  }
}

// SSE endpoints use a native browser EventSource, which cannot attach an
// Authorization header — those routes pass the token as `?token=` instead.
function extractToken(req: Request): string | null {
  const header = req.get('authorization')
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length)
  }
  if (typeof req.query.token === 'string') {
    return req.query.token
  }
  return null
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req)
  const payload = token ? verifyToken(token) : null

  if (!payload) {
    res.status(401).json({ error: 'Authentication required.' })
    return
  }

  req.user = payload
  next()
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isSuperAdmin) {
    res.status(403).json({ error: 'Super admin access required.' })
    return
  }

  next()
}

// Gates the Shared Access module (managing restricted employees and their
// contact grants) — a restricted user must never reach it, regardless of
// which organization they belong to.
export function requireOrgAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.organizationId || req.user.role === 'restricted') {
    res.status(403).json({ error: 'Admin access required.' })
    return
  }

  next()
}
