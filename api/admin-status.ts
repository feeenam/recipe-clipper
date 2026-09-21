import type { VercelRequest, VercelResponse } from '@vercel/node'

const TEST_ARTICLE = `
Ingredients:
- 1 cup flour
- 1 egg

Instructions:
Mix the flour and egg together. Bake at 350F for 20 minutes.
`

interface ProviderStatus {
  configured: boolean
  ok: boolean
  latencyMs: number | null
  error: string | null
}

async function probe(fn: (() => Promise<unknown>) | null): Promise<ProviderStatus> {
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
  try {
    const { isAuthedRequest } = await import('./_admin-auth')
    const { callGemini, callGroq } = await import('./extract-recipe')

    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' })
    }

    if (!isAuthedRequest(req)) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const geminiKey = process.env.GEMINI_API_KEY
    const groqKey = process.env.GROQ_API_KEY

    const [gemini, groq] = await Promise.all([
      probe(geminiKey ? () => callGemini(TEST_ARTICLE, geminiKey) : null),
      probe(groqKey ? () => callGroq(TEST_ARTICLE, groqKey) : null),
    ])

    return res.status(200).json({
      primary: { name: 'Gemini (gemini-flash-lite-latest)', ...gemini },
      backup: { name: 'Groq (openai/gpt-oss-120b)', ...groq },
    })
  } catch (err) {
    console.error('admin-status crashed:', err)
    return res.status(500).json({
      error: 'DEBUG: admin-status crashed',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  }
}
