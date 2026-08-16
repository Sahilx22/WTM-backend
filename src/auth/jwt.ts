import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

const TOKEN_MAX_AGE = '12h' // matches the previous sliding session window

export interface AuthTokenPayload {
  id: number
  username: string
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TOKEN_MAX_AGE })
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET)
    if (typeof decoded === 'object' && decoded !== null && 'id' in decoded && 'username' in decoded) {
      return { id: Number((decoded as Record<string, unknown>).id), username: String((decoded as Record<string, unknown>).username) }
    }
    return null
  } catch {
    return null
  }
}
