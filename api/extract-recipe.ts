import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

interface ExtractedRecipe {
  title: string
  ingredients: string[]
  steps: string[]
}

function extractJson(text: string): ExtractedRecipe | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    if (
      typeof parsed.title === 'string' &&
      Array.isArray(parsed.ingredients) &&
      Array.isArray(parsed.steps)
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function callGemini(articleText: string, apiKey: string): Promise<ExtractedRecipe> {
  const prompt = `You are extracting a recipe from an article's text. Return ONLY strict JSON, no markdown fences, in this exact shape:
{"title": "...", "ingredients": ["2 cups flour", "1 tsp salt", ...], "steps": ["Preheat oven to 350F.", "Mix dry ingredients.", ...]}

Rules:
- ingredients: each item folds the amount and unit into the string, one ingredient per entry.
- steps: plain imperative sentences only, one action per step.
- Exclude entirely: personal stories/anecdotes, blog intro text, tips, variations, nutrition info, serving suggestions, ads, comments.
- If the amount for an ingredient isn't stated, just list the ingredient name.

Article text:
${articleText.slice(0, 15000)}`

  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  )

  if (!resp.ok) {
    throw new Error(`Gemini request failed: ${resp.status}`)
  }

  const data = await resp.json()
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const extracted = extractJson(text)
  if (!extracted) {
    throw new Error('Could not parse a recipe out of that page')
  }
  return extracted
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { url } = req.body ?? {}
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" in request body' })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return res.status(400).json({ error: 'Not a valid URL' })
  }

  const geminiKey = process.env.GEMINI_API_KEY
  if (!geminiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
  }

  try {
    const pageResp = await fetch(parsedUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeClipper/1.0)' },
    })
    if (!pageResp.ok) {
      return res.status(502).json({ error: `Could not fetch that page (${pageResp.status})` })
    }
    const html = await pageResp.text()

    const { document } = parseHTML(html)
    const article = new Readability(document as unknown as Document).parse()
    const articleText = article?.textContent?.trim()

    if (!articleText) {
      return res.status(422).json({ error: 'Could not find readable article content on that page' })
    }

    const extracted = await callGemini(articleText, geminiKey)

    const supabaseUrl = process.env.VITE_SUPABASE_URL!
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey)

    const { data, error } = await supabase
      .from('recipes')
      .insert({
        url: parsedUrl.toString(),
        title: extracted.title,
        ingredients: extracted.ingredients,
        steps: extracted.steps,
      })
      .select()
      .single()

    if (error) {
      return res.status(500).json({ error: error.message })
    }

    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
}
