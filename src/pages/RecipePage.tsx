import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, type Recipe } from '../lib/supabase'
import { useWakeLock } from '../lib/useWakeLock'
import { useVoiceAssistant } from '../lib/useVoiceAssistant'
import { useAuth } from '../lib/auth'

function TagLink({ param, value }: { param: 'cuisine' | 'meal' | 'ingredient'; value: string }) {
  return (
    <Link
      to={`/?${param}=${encodeURIComponent(value)}`}
      className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200"
    >
      {value.charAt(0).toUpperCase() + value.slice(1)}
    </Link>
  )
}

// Only http(s) links are clickable: a stored javascript: URL would run in the visitor's session.
const isHttpUrl = (value: string) => /^https?:\/\//i.test(value)

export function RecipePage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { session, isAnonymous } = useAuth()
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const isOwner = !!session && !!recipe && recipe.user_id === session.user.id
  const { isActive: keepAwake, isSupported: wakeLockSupported, toggle: toggleWakeLock } = useWakeLock()
  const {
    isSupported: voiceSupported,
    status: voiceStatus,
    currentStep: voiceStep,
    toggle: toggleVoiceAssistant,
  } = useVoiceAssistant({ steps: recipe?.steps ?? [], ingredients: recipe?.ingredients ?? [] })

  useEffect(() => {
    supabase
      .from('recipes')
      .select('*')
      .eq('id', id)
      .single()
      .then(({ data }) => {
        setRecipe(data)
        setLoading(false)
      })
  }, [id])

  // The admin cookie is HttpOnly, so ask the server whether this visitor is logged in.
  // Any failure (including `vite dev`, which doesn't serve /api) just means "not admin".
  useEffect(() => {
    fetch('/api/delete-recipe')
      .then((res) => res.json())
      .then((data) => setIsAdmin(data?.admin === true))
      .catch(() => setIsAdmin(false))
  }, [])

  // Only the owner can change this (RLS enforces it); trial users can't share at all.
  async function setVisibility(next: 'private' | 'public') {
    if (!recipe || sharing) return
    setSharing(true)
    setShareError(null)
    const { data, error } = await supabase
      .from('recipes')
      .update({ visibility: next })
      .eq('id', recipe.id)
      .select()
      .single()
    if (error || !data) setShareError(error?.message ?? 'Could not update sharing')
    else setRecipe(data)
    setSharing(false)
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setShareError('Could not copy the link')
    }
  }

  async function handleDelete() {
    if (!recipe || deleting) return
    if (!window.confirm(`Delete "${recipe.title}"? This can't be undone.`)) return

    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch('/api/delete-recipe', {
        method: 'POST',
        // The server accepts the admin cookie or the owner's access token.
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ id: recipe.id }),
      })
      if (res.status === 401) {
        setIsAdmin(false)
        throw new Error(isOwner ? 'Your session expired. Sign in again.' : 'Admin session expired. Log in again at /admin.')
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to delete recipe')
      }
      navigate('/')
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Something went wrong')
      setDeleting(false)
    }
  }

  if (loading) {
    return <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400">Loading…</div>
  }

  if (!recipe) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-4">
        <p className="text-gray-500">Recipe not found.</p>
        <Link to="/" className="text-gray-900 underline">Back home</Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl">
        <div className="flex items-center justify-between mb-6">
          {session ? (
            <Link to="/" className="text-gray-400 hover:text-gray-600 text-sm inline-block">&larr; All recipes</Link>
          ) : (
            <Link to="/login" className="text-gray-400 hover:text-gray-600 text-sm inline-block">Sign in</Link>
          )}

          <div className="flex items-center gap-2">
            {voiceSupported && isAdmin && (
              <button
                onClick={toggleVoiceAssistant}
                className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                  voiceStatus !== 'off'
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-500 border-gray-300 hover:border-gray-400'
                }`}
              >
                {voiceStatus === 'listening' && '🎙️ Listening…'}
                {voiceStatus === 'thinking' && '🤔 Thinking…'}
                {voiceStatus === 'speaking' && '🔊 Speaking…'}
                {voiceStatus === 'off' && '🎙️ Voice assistant'}
              </button>
            )}

            {wakeLockSupported && (
              <button
                onClick={toggleWakeLock}
                className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                  keepAwake
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-500 border-gray-300 hover:border-gray-400'
                }`}
              >
                {keepAwake ? '☀︎ Screen awake' : 'Keep screen awake'}
              </button>
            )}

            {(isAdmin || isOwner) && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-sm px-3 py-1.5 rounded-full border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            )}
          </div>
        </div>
        {deleteError && <p className="text-red-600 text-sm mb-4 text-right">{deleteError}</p>}

        {recipe.image_url && (
          <img
            src={recipe.image_url}
            alt={recipe.title}
            className="w-full aspect-video object-cover rounded-lg mb-6 border border-gray-200"
          />
        )}

        <h1 className="text-3xl font-semibold text-gray-900 mb-1">{recipe.title}</h1>
        {recipe.url && isHttpUrl(recipe.url) && (
          <a
            href={recipe.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 text-sm hover:text-gray-600 break-all"
          >
            {recipe.url}
          </a>
        )}

        {(recipe.cuisine || recipe.meal_type || recipe.main_ingredients?.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {recipe.cuisine && <TagLink param="cuisine" value={recipe.cuisine} />}
            {recipe.meal_type && <TagLink param="meal" value={recipe.meal_type} />}
            {recipe.main_ingredients?.map((ingredient) => (
              <TagLink key={ingredient} param="ingredient" value={ingredient} />
            ))}
          </div>
        )}

        {isOwner && !isAnonymous && (
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <button
              onClick={() => setVisibility(recipe.visibility === 'public' ? 'private' : 'public')}
              disabled={sharing}
              title={recipe.visibility === 'public' ? 'Click to make private' : 'Click to share with anyone who has the link'}
              className="text-sm px-3 py-1.5 rounded-full border border-gray-300 bg-white text-gray-600 hover:border-gray-400 disabled:opacity-50"
            >
              {recipe.visibility === 'public' ? '🔗 Anyone with the link' : '🔒 Private'}
            </button>
            {recipe.visibility === 'public' && (
              <button onClick={copyLink} className="text-sm text-gray-500 hover:text-gray-700 underline">
                {copied ? 'Copied' : 'Copy link'}
              </button>
            )}
            {shareError && <span className="text-red-600 text-xs">{shareError}</span>}
          </div>
        )}

        <div className="mt-10">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Ingredients</h2>
          <ul className="space-y-2">
            {recipe.ingredients.map((ing, i) => (
              <li key={i} className="text-gray-700">{ing}</li>
            ))}
          </ul>
        </div>

        <div className="mt-10">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Steps</h2>
          <ol className="space-y-4">
            {recipe.steps.map((step, i) => (
              <li
                key={i}
                className={`flex gap-3 rounded-md px-2 py-1 -mx-2 transition-colors ${
                  voiceStatus !== 'off' && i === voiceStep ? 'bg-yellow-100 text-gray-900' : 'text-gray-700'
                }`}
              >
                <span className="font-medium text-gray-400">{i + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        {!session && (
          <div className="mt-12 pt-6 border-t border-gray-200 text-sm text-gray-500">
            Want to keep your own recipes?{' '}
            <Link to="/login" className="text-gray-900 underline">
              Clip your own
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
