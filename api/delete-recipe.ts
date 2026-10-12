import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { createHash, timingSafeEqual } from 'node:crypto'

// Admin-only. The `recipes` table has no delete policy for the anon key on purpose, so this
// uses the service-role key (server-side only, never a VITE_ var) after checking the same
// admin session cookie as admin-status.ts. The auth helpers are duplicated rather than shared
// for the bundler reason explained in admin-login.ts.
const ADMIN_COOKIE_NAME = 'admin_session'
const RECIPE_IMAGES_BUCKET = 'recipe-images'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex')
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const cookies: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    try {
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
    } catch {
      // Ignore cookies with malformed encoding.
    }
  }
  return cookies
}

function isAuthedRequest(req: VercelRequest): boolean {
  const expected = process.env.ADMIN_PASSWORD
  if (!expected) return false
  const sessionToken = parseCookies(req.headers.cookie)[ADMIN_COOKIE_NAME]
  if (!sessionToken) return false
  const a = Buffer.from(sessionToken)
  const b = Buffer.from(hashPassword(expected))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Storage object path from a public URL like .../object/public/recipe-images/<path>. */
function storagePathFromPublicUrl(imageUrl: string): string | null {
  const marker = `/${RECIPE_IMAGES_BUCKET}/`
  const idx = imageUrl.indexOf(marker)
  if (idx === -1) return null
  const path = imageUrl.slice(idx + marker.length).split('?')[0]
  return path ? decodeURIComponent(path) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')

  // Cheap "am I logged in as admin?" check so the UI knows whether to show the delete button.
  // Always 200 so logged-out visitors don't see an error in their console.
  if (req.method === 'GET') {
    return res.status(200).json({ admin: isAuthedRequest(req) })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!isAuthedRequest(req)) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  const id = req.body?.id
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    return res.status(400).json({ error: 'Invalid recipe id' })
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' })
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { data: recipe, error: lookupError } = await supabase
    .from('recipes')
    .select('id, image_url')
    .eq('id', id)
    .maybeSingle()
  if (lookupError) {
    return res.status(500).json({ error: lookupError.message })
  }
  if (!recipe) {
    return res.status(404).json({ error: 'Recipe not found' })
  }

  // Delete the row first: if the image cleanup below fails we leave an orphaned file,
  // never a recipe pointing at a missing image.
  const { error: deleteError } = await supabase.from('recipes').delete().eq('id', id)
  if (deleteError) {
    return res.status(500).json({ error: deleteError.message })
  }

  const imagePath = recipe.image_url ? storagePathFromPublicUrl(recipe.image_url) : null
  if (imagePath) {
    const { error: removeError } = await supabase.storage.from(RECIPE_IMAGES_BUCKET).remove([imagePath])
    if (removeError) console.error('Recipe image cleanup failed:', removeError.message)
  }

  return res.status(200).json({ ok: true })
}
