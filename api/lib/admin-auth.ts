import { createHash, timingSafeEqual } from 'node:crypto'
import type { VercelRequest } from '@vercel/node'

const ADMIN_COOKIE_NAME = 'admin_session'
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

export function checkPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) return false
  const a = Buffer.from(hashPassword(password))
  const b = Buffer.from(hashPassword(expected))
  return timingSafeEqual(a, b)
}

export function buildSessionCookie(): string {
  const token = hashPassword(process.env.ADMIN_PASSWORD ?? '')
  return `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`
}

export function buildClearSessionCookie(): string {
  return `${ADMIN_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=')
      return [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())]
    })
  )
}

export function isAuthedRequest(req: VercelRequest): boolean {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) return false
  const cookies = parseCookies(req.headers.cookie)
  const sessionToken = cookies[ADMIN_COOKIE_NAME]
  if (!sessionToken) return false
  const a = Buffer.from(sessionToken)
  const b = Buffer.from(hashPassword(expected))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
