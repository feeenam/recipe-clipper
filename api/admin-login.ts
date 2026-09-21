import type { VercelRequest, VercelResponse } from '@vercel/node'
import { checkPassword, buildSessionCookie } from './lib/admin-auth'

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
