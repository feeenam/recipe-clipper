import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash, timingSafeEqual } from 'node:crypto'

// NOTE: this hashing/cookie logic is duplicated in admin-logout.ts and admin-status.ts
// rather than shared from a helper file. Vercel's build for this project does not
// include any file in the deployed function bundle unless it's itself a top-level
// api/*.ts file with a default export - a shared _admin-auth.ts, a top-level lib/
// file, and an api/lib/ subdirectory file all failed with ERR_MODULE_NOT_FOUND at
// runtime (regardless of static vs dynamic import). Duplicating ~15 lines per file
// was more reliable than continuing to fight the bundler.
const ADMIN_COOKIE_NAME = 'admin_session'
const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

function checkPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) return false
  const a = Buffer.from(hashPassword(password))
  const b = Buffer.from(hashPassword(expected))
  return timingSafeEqual(a, b)
}

function buildSessionCookie(): string {
  const token = hashPassword(process.env.ADMIN_PASSWORD ?? '')
  return `${ADMIN_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' })
  }

  const { password } = req.body ?? {}
  if (typeof password !== 'string' || !checkPassword(password)) {
    return res.status(401).json({ error: 'Incorrect password' })
  }

  res.setHeader('Set-Cookie', buildSessionCookie())
  return res.status(200).json({ ok: true })
}
