import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { isProduction } from '../config/env.js'

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found.' })
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  console.error(err)

  let status = 500

  if (err instanceof multer.MulterError) {
    // Multer's own limits (file too large, unexpected field, etc.) — the
    // message is always safe to show as-is.
    status = 400
  } else if (typeof err === 'object' && err !== null && 'status' in err && typeof (err as any).status === 'number') {
    status = (err as any).status
  }

  // Only truly unexpected (500) errors get sanitized — anything we
  // deliberately tagged with a 4xx status carries a message we wrote
  // ourselves and is safe to show regardless of environment.
  const message =
    status === 500
      ? isProduction
        ? 'Something went wrong. Please try again.'
        : String((err as Error)?.message ?? err)
      : String((err as Error)?.message ?? 'Request could not be processed.')

  res.status(status).json({ error: message })
}
