import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHash, timingSafeEqual } from 'node:crypto'

// See the NOTE in admin-login.ts on why this file is fully self-contained rather
// than sharing auth/probe logic with extract-recipe.ts or a helper file.
const ADMIN_COOKIE_NAME = 'admin_session'
const PROBE_TIMEOUT_MS = 15000
const TEST_ARTICLE = `
Ingredients:
- 1 cup flour
- 1 egg

Instructions:
Mix the flour and egg together. Bake at 350F for 20 minutes.
`
const TEST_PROMPT = `You are extracting a recipe from an article's text. Return ONLY strict JSON, no markdown fences, in this exact shape:
{"title": "...", "ingredients": ["..."], "steps": ["..."]}

Article text:
${TEST_ARTICLE}`

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
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

function isAuthedRequest(req: VercelRequest): boolean {
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

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function probeGemini(apiKey: string): Promise<void> {
  const resp = await fetchWithTimeout(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent',
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: TEST_PROMPT }] }] }),
    }
  )
  if (!resp.ok) throw new Error(`Gemini request failed: ${resp.status}`)
}

async function probeGroq(apiKey: string): Promise<void> {
  const resp = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: TEST_PROMPT }] }),
  })
  if (!resp.ok) throw new Error(`Groq request failed: ${resp.status}`)
}

interface ProviderStatus {
  configured: boolean
  ok: boolean
  latencyMs: number | null
  error: string | null
}

async function probe(fn: (() => Promise<void>) | null): Promise<ProviderStatus> {
  if (!fn) {
    return { configured: false, ok: false, latencyMs: null, error: 'API key not configured' }
  }
  const start = Date.now()
  try {
    await fn()
    return { configured: true, ok: true, latencyMs: Date.now() - start, error: null }
  } catch (err) {
    return {
      configured: true,
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!isAuthedRequest(req)) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const geminiKey = process.env.GEMINI_API_KEY
  const groqKey = process.env.GROQ_API_KEY

  const [gemini, groq] = await Promise.all([
    probe(geminiKey ? () => probeGemini(geminiKey) : null),
    probe(groqKey ? () => probeGroq(groqKey) : null),
  ])

  return res.status(200).json({
    primary: { name: 'Gemini (gemini-flash-lite-latest)', ...gemini },
    backup: { name: 'Groq (openai/gpt-oss-120b)', ...groq },
  })
}
