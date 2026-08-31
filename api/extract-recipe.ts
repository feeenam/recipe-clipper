import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { randomUUID } from 'node:crypto'

interface ExtractedRecipe {
  title: string
  ingredients: string[]
  steps: string[]
}

function flattenInstructions(instructions: unknown): string[] {
  if (!instructions) return []
  if (typeof instructions === 'string') {
    // Some sites put the whole method as one newline-separated string.
    return instructions
      .split(/\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (Array.isArray(instructions)) {
    return instructions.flatMap((item) => {
      if (typeof item === 'string') return [item]
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        // HowToSection nests further HowToStep entries under itemListElement.
        if (obj['@type'] === 'HowToSection' && Array.isArray(obj.itemListElement)) {
          return flattenInstructions(obj.itemListElement)
        }
        if (typeof obj.text === 'string') return [obj.text]
        if (typeof obj.name === 'string') return [obj.name]
      }
      return []
    })
  }
  return []
}

function findRecipeNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item)
      if (found) return found
    }
    return null
  }
  const obj = node as Record<string, unknown>
  const type = obj['@type']
  const isRecipe = type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))
  if (isRecipe) return obj
  if (Array.isArray(obj['@graph'])) return findRecipeNode(obj['@graph'])
  return null
}

function extractJsonLdRecipe(document: Document): ExtractedRecipe | null {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]')
  for (const script of Array.from(scripts)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script.textContent ?? '')
    } catch {
      continue
    }
    const recipeNode = findRecipeNode(parsed)
    if (!recipeNode) continue

    const title = typeof recipeNode.name === 'string' ? recipeNode.name : null
    const ingredients = Array.isArray(recipeNode.recipeIngredient)
      ? (recipeNode.recipeIngredient as unknown[]).filter((i): i is string => typeof i === 'string')
      : []
    const steps = flattenInstructions(recipeNode.recipeInstructions)

    if (title && ingredients.length > 0 && steps.length > 0) {
      return { title, ingredients, steps }
    }
  }
  return null
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

async function generateDishImage(title: string, apiKey: string): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `A professional, appetizing food photograph of "${title}", plated and ready to eat, natural lighting, shallow depth of field. No text, no watermarks, no logos.`,
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ['IMAGE'],
          },
        }),
      }
    )

    if (!resp.ok) {
      console.error('Gemini image request failed:', resp.status, await resp.text())
      return null
    }

    const data = await resp.json()
    const parts = data.candidates?.[0]?.content?.parts ?? []
    for (const part of parts) {
      if (part.inlineData?.data) {
        return {
          data: Buffer.from(part.inlineData.data, 'base64'),
          mimeType: part.inlineData.mimeType || 'image/png',
        }
      }
    }
    console.error('Gemini image response had no inline image data:', JSON.stringify(data).slice(0, 500))
    return null
  } catch (err) {
    console.error('Gemini image generation threw:', err)
    return null
  }
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

    // Most recipe sites embed a schema.org Recipe block for SEO — if it's there,
    // use it directly and skip the LLM call entirely (free, exact, no tokens spent).
    let extracted = extractJsonLdRecipe(document as unknown as Document)

    if (!extracted) {
      const article = new Readability(document as unknown as Document).parse()
      const articleText = article?.textContent?.trim()

      if (!articleText) {
        return res.status(422).json({ error: 'Could not find readable article content on that page' })
      }

      extracted = await callGemini(articleText, geminiKey)
    }

    const supabaseUrl = process.env.VITE_SUPABASE_URL!
    const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY!
    const supabase = createClient(supabaseUrl, supabaseAnonKey)

    // Best-effort — a failed image generation shouldn't fail the whole save.
    let imageUrl: string | null = null
    const image = await generateDishImage(extracted.title, geminiKey)
    if (image) {
      const ext = image.mimeType.split('/')[1] || 'png'
      const path = `${randomUUID()}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('recipe-images')
        .upload(path, image.data, { contentType: image.mimeType })
      if (!uploadError) {
        imageUrl = supabase.storage.from('recipe-images').getPublicUrl(path).data.publicUrl
      } else {
        console.error('Recipe image upload failed:', uploadError.message)
      }
    }

    const { data, error } = await supabase
      .from('recipes')
      .insert({
        url: parsedUrl.toString(),
        title: extracted.title,
        ingredients: extracted.ingredients,
        steps: extracted.steps,
        image_url: imageUrl,
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
