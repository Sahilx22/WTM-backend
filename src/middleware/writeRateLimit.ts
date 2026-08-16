import rateLimit from 'express-rate-limit'
import type { NextFunction, Request, Response } from 'express'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// A generous ceiling on state-changing requests per session/IP — not meant to
// throttle normal use, just to blunt scripted abuse of any authenticated
// write endpoint (contacts, sends, campaigns, etc.).
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' }
})

export function writeRateLimit(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next()
    return
  }
  limiter(req, res, next)
}
