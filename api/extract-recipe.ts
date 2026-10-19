import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

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

const HTML_ENTITY_PATTERN = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i

/**
 * Normalizes a single piece of recipe text. Sites often HTML-encode their JSON-LD (e.g.
 * "You&#39;ll"), and models occasionally echo entities or tags through, so this decodes
 * entities, drops stray tags, and collapses whitespace. Deterministic on purpose: an LLM
 * pass here could silently change amounts or wording.
 */
export function cleanText(input: string): string {
  let text = input
  // Two passes handles double-encoded text like "&amp;#39;"; more would risk mangling
  // text that legitimately mentions an entity.
  for (let pass = 0; pass < 2 && (HTML_ENTITY_PATTERN.test(text) || /<[a-z/!][^>]*>/i.test(text)); pass++) {
    const { document } = parseHTML(`<!doctype html><html><body><div>${text}</div></body></html>`)
    text = document.querySelector('div')?.textContent ?? text
  }
  return text.replace(/\s+/g, ' ').trim()
}

export function cleanRecipe(recipe: ExtractedRecipe): ExtractedRecipe {
  const cleanList = (items: unknown[]) =>
    items
      .filter((item): item is string => typeof item === 'string')
      .map(cleanText)
      .filter(Boolean)
  return {
    title: cleanText(recipe.title),
    ingredients: cleanList(recipe.ingredients),
    steps: cleanList(recipe.steps),
  }
}

const RECIPE_EXTRACTION_TIMEOUT_MS = 15000

function buildRecipePrompt(articleText: string): string {
  return `You are extracting a recipe from an article's text. Return ONLY strict JSON, no markdown fences, in this exact shape:
{"title": "...", "ingredients": ["2 cups flour", "1 tsp salt", ...], "steps": ["Preheat oven to 350F.", "Mix dry ingredients.", ...]}

Rules:
- ingredients: each item folds the amount and unit into the string, one ingredient per entry.
- steps: plain imperative sentences only, one action per step.
- Exclude entirely: personal stories/anecdotes, blog intro text, tips, variations, nutrition info, serving suggestions, ads, comments.
- If the amount for an ingredient isn't stated, just list the ingredient name.

Article text:
${articleText.slice(0, 15000)}`
}

/** Thrown by a model call for a failure that's worth retrying against the backup model. */
export class RetryableLlmError extends Error {}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RetryableLlmError('Request timed out')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

async function geminiGenerate(prompt: string, apiKey: string, timeoutMs: number): Promise<string> {
  const resp = await fetchWithTimeout(
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
    },
    timeoutMs
  )

  if (!resp.ok) {
    // 429 (rate limit) and 5xx (Gemini-side errors) are worth a shot on the backup model.
    // 4xx other than 429 means our request was bad, and the backup will fail the same way.
    if (resp.status === 429 || resp.status >= 500) {
      throw new RetryableLlmError(`Gemini request failed: ${resp.status}`)
    }
    throw new Error(`Gemini request failed: ${resp.status}`)
  }

  const data = await resp.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

async function groqGenerate(prompt: string, apiKey: string, timeoutMs: number): Promise<string> {
  const resp = await fetchWithTimeout(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    timeoutMs
  )

  if (!resp.ok) {
    throw new Error(`Groq request failed: ${resp.status}`)
  }

  const data = await resp.json()
  return data.choices?.[0]?.message?.content ?? ''
}

/**
 * Runs a prompt against Gemini first and falls back to Groq (a different provider, so this
 * survives a Gemini-wide outage, not just one model) on a timeout, rate limit, or server
 * error. Any other failure (bad request) is assumed to affect the backup the same way, so
 * it's not worth retrying. Returns the raw model text; callers parse it.
 *
 * NOTE — if this endpoint gets enough traffic to matter: this is a reactive, per-request
 * fallback with no shared state, which is fine at low volume but means every single
 * request pays the cost of failing against the primary before trying the backup. The
 * dashboard-api pattern (see LlmChatService._resolveModel) avoids that by keeping a
 * per-model `isOnline` flag (e.g. in Vercel KV/Redis) that a scheduled liveness probe
 * flips on majority-vote failures, so a struggling model is skipped pre-flight instead
 * of being retried on every request. Worth adopting here once volume/latency justifies
 * the added infra.
 */
export async function generateWithFallback(
  prompt: string,
  geminiKey: string,
  groqKey?: string,
  timeoutMs: number = RECIPE_EXTRACTION_TIMEOUT_MS
): Promise<string> {
  try {
    return await geminiGenerate(prompt, geminiKey, timeoutMs)
  } catch (err) {
    if (!(err instanceof RetryableLlmError) || !groqKey) {
      throw err
    }
    console.error('llm_fallback_used: Gemini failed, retrying with Groq:', err.message)
    return await groqGenerate(prompt, groqKey, timeoutMs)
  }
}

/** Extracts a recipe from article text. An unparsable response is not retried on the backup. */
export async function extractRecipe(articleText: string, geminiKey: string, groqKey?: string): Promise<ExtractedRecipe> {
  const text = await generateWithFallback(buildRecipePrompt(articleText), geminiKey, groqKey)
  const extracted = extractJson(text)
  if (!extracted) {
    throw new Error('Could not parse a recipe out of that page')
  }
  return extracted
}

// ---- Recipe tags (cuisine / meal type / main ingredients) -----------------------------
// Fixed lists keep filtering consistent; the model is told to pick from them and anything
// else is normalized below.
export const CUISINES = [
  'american', 'british', 'caribbean', 'chinese', 'ethiopian', 'filipino', 'french', 'german',
  'greek', 'indian', 'indonesian', 'italian', 'japanese', 'korean', 'latin american', 'lebanese',
  'mediterranean', 'mexican', 'middle eastern', 'moroccan', 'nordic', 'russian', 'spanish',
  'thai', 'turkish', 'vietnamese', 'other',
]
export const MEAL_TYPES = ['breakfast', 'main', 'side', 'soup', 'salad', 'dessert', 'snack', 'drink']

const TAGGING_TIMEOUT_MS = 10000
const MAX_MAIN_INGREDIENTS = 3

export interface RecipeTags {
  cuisine: string | null
  meal_type: string | null
  main_ingredients: string[]
}

export const UNTAGGED: RecipeTags = { cuisine: null, meal_type: null, main_ingredients: [] }

export function hasTags(tags: RecipeTags): boolean {
  return tags.cuisine !== null || tags.meal_type !== null || tags.main_ingredients.length > 0
}

/** Coerces untrusted model output into valid tags; anything unusable becomes null / empty. */
export function normalizeTags(raw: unknown): RecipeTags {
  if (!raw || typeof raw !== 'object') return { ...UNTAGGED, main_ingredients: [] }
  const obj = raw as Record<string, unknown>
  const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : '')

  const cuisineText = lower(obj.cuisine)
  // A non-empty cuisine we don't recognise is still information ("other"), unlike no answer.
  const cuisine = !cuisineText ? null : CUISINES.includes(cuisineText) ? cuisineText : 'other'

  const mealText = lower(obj.meal_type)
  const meal_type = MEAL_TYPES.includes(mealText) ? mealText : null

  const ingredients = Array.isArray(obj.main_ingredients) ? obj.main_ingredients : []
  const main_ingredients = Array.from(new Set(ingredients.map(lower).filter((i) => i && i.length <= 40))).slice(
    0,
    MAX_MAIN_INGREDIENTS
  )

  return { cuisine, meal_type, main_ingredients }
}

function buildTagPrompt(recipe: ExtractedRecipe): string {
  return `You are labeling a recipe so it can be filtered in a recipe library. Return ONLY strict JSON, no markdown fences, in this exact shape:
{"cuisine": "...", "meal_type": "...", "main_ingredients": ["...", "..."]}

Rules:
- cuisine: exactly one of: ${CUISINES.join(', ')}. Use "other" if none fit.
- meal_type: exactly one of: ${MEAL_TYPES.join(', ')}.
- main_ingredients: 1 to ${MAX_MAIN_INGREDIENTS} headline ingredients that define the dish (e.g. "chicken", "salmon", "leek"). Lowercase, singular, ingredient name only: no amounts, no preparation words, and no pantry staples (salt, oil, water, sugar, pepper) unless the dish is built around them.

Recipe title: ${recipe.title}
Ingredients:
${recipe.ingredients
  .slice(0, 40)
  .map((i) => `- ${i}`)
  .join('\n')}`
}

/**
 * Best-effort: never throws. Any LLM or parse failure returns "untagged" so a tagging
 * problem can't block saving a recipe (the backfill script can fill the tags in later).
 */
export async function tagRecipe(recipe: ExtractedRecipe, geminiKey: string, groqKey?: string): Promise<RecipeTags> {
  try {
    const text = await generateWithFallback(buildTagPrompt(recipe), geminiKey, groqKey, TAGGING_TIMEOUT_MS)
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return { ...UNTAGGED, main_ingredients: [] }
    return normalizeTags(JSON.parse(match[0]))
  } catch (err) {
    console.error('recipe_tagging_failed:', err instanceof Error ? err.message : err)
    return { ...UNTAGGED, main_ingredients: [] }
  }
}

async function generateDishImage(title: string, ingredients: string[]): Promise<{ data: Buffer; mimeType: string } | null> {
  try {
    const ingredientList = ingredients.slice(0, 12).join(', ')
    const prompt = `Anime style illustration of ${title}, made with ${ingredientList}, plated and ready to eat, vibrant colors, studio ghibli-esque food art. No text, no watermarks, no logos.`
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=576&model=flux&nologo=true`

    const resp = await fetch(url)
    if (!resp.ok) {
      console.error('Pollinations image request failed:', resp.status)
      return null
    }

    const mimeType = resp.headers.get('content-type') || 'image/jpeg'
    if (!mimeType.startsWith('image/')) {
      console.error('Pollinations returned non-image content-type:', mimeType)
      return null
    }

    const arrayBuffer = await resp.arrayBuffer()
    return { data: Buffer.from(arrayBuffer), mimeType }
  } catch (err) {
    console.error('Pollinations image generation threw:', err)
    return null
  }
}

/** Hash of the caller's IP, for the per-IP trial cap. Vercel sets x-forwarded-for itself. */
function clientIpHash(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return createHash('sha256').update(first || req.socket?.remoteAddress || 'unknown').digest('hex')
}

// --- SSRF guard -------------------------------------------------------------
// Kept in this file on purpose: Vercel only reliably bundles top-level api/*.ts
// files, so a shared helper module is not an option (see NOTE in admin-login.ts).
// Known gap: fetch() re-resolves DNS after we validate, so a DNS-rebinding
// attacker could still race the check; closing it needs a pinned-IP dispatcher.

export class BlockedUrlError extends Error {}

const MAX_REDIRECTS = 5

function isBlockedIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && ip.startsWith('192.0.0.')) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  )
}

function ipv6ToWords(ip: string): number[] | null {
  let addr = ip.split('%')[0].toLowerCase()
  const v4 = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const o = v4[2].split('.').map(Number)
    addr = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null
  const words = [...head, ...Array(fill).fill('0'), ...tail].map((w) => parseInt(w, 16))
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null
}

function isBlockedIPv6(ip: string): boolean {
  const w = ipv6ToWords(ip)
  if (!w) return true
  // Allowlist global unicast (2000::/3). That rejects ::, ::1, fc00::/7, fe80::/10,
  // ff00::/8, IPv4-mapped (::ffff:0:0/96) and NAT64 in one go.
  if ((w[0] & 0xe000) !== 0x2000) return true
  if (w[0] === 0x2002) return true // 6to4 embeds an IPv4 address
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0x0db8)) return true // Teredo, documentation
  return false
}

function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isBlockedIPv4(ip)
  if (family === 6) return isBlockedIPv6(ip)
  return true
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError('scheme')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new BlockedUrlError('host')
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedUrlError('address')
  }
}

// Fetches a user-supplied URL, validating the destination before every hop so a
// public URL cannot redirect us to an internal one.
export async function safeFetch(startUrl: URL, init: RequestInit): Promise<Response> {
  let current = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current)
    const resp = await fetch(current.toString(), { ...init, redirect: 'manual' })
    if (resp.status < 300 || resp.status >= 400) return resp
    const location = resp.headers.get('location')
    await resp.body?.cancel()
    if (!location) return resp
    try {
      current = new URL(location, current)
    } catch {
      throw new BlockedUrlError('redirect')
    }
  }
  throw new BlockedUrlError('too many redirects')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) {
    return res.status(401).json({ error: 'Sign in to save recipes' })
  }

  // Acts as the signed-in user: RLS, not this code, decides what they may read and write.
  const supabase = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await supabase.auth.getUser(token)
  const user = userData.user
  if (userError || !user) {
    return res.status(401).json({ error: 'Your session expired. Sign in again.' })
  }
  // Trial users (anonymous sign-in) get one recipe and no generated image.
  const isTrial = user.is_anonymous === true

  const { url, text } = req.body ?? {}
  const pastedText = typeof text === 'string' ? text.trim() : ''

  let parsedUrl: URL | null = null
  if (typeof url === 'string' && url.trim()) {
    try {
      parsedUrl = new URL(url)
    } catch {
      return res.status(400).json({ error: 'Not a valid URL' })
    }
  } else if (!pastedText) {
    return res.status(400).json({ error: 'Missing "url" in request body' })
  }

  const geminiKey = process.env.GEMINI_API_KEY
  if (!geminiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })
  }
  const groqKey = process.env.GROQ_API_KEY

  // Trial limits are checked before any LLM or page fetch so a refused request costs nothing.
  if (isTrial) {
    const { count } = await supabase
      .from('recipes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    if ((count ?? 0) >= 1) {
      return res.status(403).json({ error: 'Your trial recipe is used. Sign in to save more.' })
    }
    const { data: allowed, error: claimError } = await supabase.rpc('claim_trial_clip', {
      p_ip_hash: clientIpHash(req),
    })
    if (claimError) {
      return res.status(500).json({ error: claimError.message })
    }
    if (!allowed) {
      return res.status(429).json({ error: 'Too many trial recipes from your network today. Try again tomorrow.' })
    }
  }

  try {
    let extracted: ExtractedRecipe | null = null

    if (pastedText) {
      extracted = await extractRecipe(pastedText, geminiKey, groqKey)
    } else {
      let pageResp: Response
      try {
        pageResp = await safeFetch(parsedUrl!, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RecipeClipper/1.0)' },
        })
      } catch (err) {
        if (err instanceof BlockedUrlError) {
          return res.status(400).json({ error: "That URL isn't allowed" })
        }
        throw err
      }
      if (!pageResp.ok) {
        return res.status(502).json({ error: `Could not fetch that page (${pageResp.status})` })
      }
      const html = await pageResp.text()

      const { document } = parseHTML(html)

      // Most recipe sites embed a schema.org Recipe block for SEO — if it's there,
      // use it directly and skip the LLM call entirely (free, exact, no tokens spent).
      extracted = extractJsonLdRecipe(document as unknown as Document)

      if (!extracted) {
        const article = new Readability(document as unknown as Document).parse()
        const articleText = article?.textContent?.trim()

        if (!articleText) {
          return res.status(422).json({ error: 'Could not find readable article content on that page' })
        }

        extracted = await extractRecipe(articleText, geminiKey, groqKey)
      }
    }

    // Applies to both the JSON-LD and LLM paths so stored text never carries HTML entities.
    extracted = cleanRecipe(extracted)

    // Best-effort — a failed image generation or tagging call shouldn't fail the whole save.
    // They run concurrently (image generation is the slow part), so tagging adds no latency.
    // Trial recipes skip the image entirely, so they never touch storage.
    let imageUrl: string | null = null
    const [image, tags] = await Promise.all([
      isTrial ? Promise.resolve(null) : generateDishImage(extracted.title, extracted.ingredients),
      tagRecipe(extracted, geminiKey, groqKey),
    ])
    if (image) {
      const ext = image.mimeType.split('/')[1] || 'png'
      // Per-user folder: the storage policy only lets users upload under their own id.
      const path = `${user.id}/${randomUUID()}.${ext}`
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
        user_id: user.id,
        url: parsedUrl ? parsedUrl.toString() : '',
        title: extracted.title,
        ingredients: extracted.ingredients,
        steps: extracted.steps,
        image_url: imageUrl,
        cuisine: tags.cuisine,
        meal_type: tags.meal_type,
        main_ingredients: tags.main_ingredients,
        // Left null when tagging failed so the backfill script knows to retry this recipe.
        tagged_at: hasTags(tags) ? new Date().toISOString() : null,
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
