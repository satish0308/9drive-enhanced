import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../config/prisma.js'
import { verifyAccessToken } from '../utils/jwt.js'

export type AuthRequest = Request & {
  user?: { id: string; sessionId: string }
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const header = req.header('Authorization')
    const queryToken = typeof req.query.token === 'string' && req.query.token ? req.query.token : undefined
    const rawToken = header?.startsWith('Bearer ') ? header.slice(7) : queryToken
    if (!rawToken) return res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Bearer token or token query parameter required.' })
    const payload = verifyAccessToken(rawToken)
    const session = await prisma.userSession.findUnique({ where: { id: payload.sid } })
    if (!session || session.revokedAt || session.expiresAt < new Date()) return res.status(401).json({ code: 'AUTH_SESSION_EXPIRED', message: 'Session expired.' })
    req.user = { id: payload.sub, sessionId: payload.sid }
    return next()
  } catch {
    return res.status(401).json({ code: 'AUTH_INVALID_TOKEN', message: 'Invalid token.' })
  }
}
