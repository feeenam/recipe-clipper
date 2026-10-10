import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase, type Recipe } from '../lib/supabase'

const PAGE_SIZE = 10

export function HomePage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [pasteMode, setPasteMode] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [recipesLoading, setRecipesLoading] = useState(true)

  // Page lives in the URL so back-navigation from a recipe returns to the same page.
  const requestedPage = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)

  useEffect(() => {
    let cancelled = false
    setRecipesLoading(true)
    const from = (requestedPage - 1) * PAGE_SIZE
    supabase
      .from('recipes')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
      .then(({ data, count }) => {
        if (cancelled) return
        setRecipes(data ?? [])
        setTotalCount(count ?? 0)
        setRecipesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [requestedPage])

  // If the URL points past the last page (e.g. recipes were removed), snap back to it.
  useEffect(() => {
    if (!recipesLoading && requestedPage > totalPages) goToPage(totalPages)
  }, [recipesLoading, requestedPage, totalPages])

  function goToPage(next: number) {
    setSearchParams(next <= 1 ? {} : { page: String(next) })
    window.scrollTo({ top: 0 })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/extract-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pasteMode ? { text, url } : { url }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || 'Failed to extract recipe')
      }
      navigate(`/recipe/${data.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  function sourceDomain(recipeUrl: string) {
    try {
      return new URL(recipeUrl).hostname.replace(/^www\./, '')
    } catch {
      return recipeUrl
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">Recipe Clipper</h1>
        <p className="text-gray-500 mb-8">Paste a recipe URL. Get just the ingredients and steps.</p>

        <form onSubmit={handleSubmit} className="mb-2">
          {pasteMode ? (
            <div className="flex flex-col gap-2">
              <input
                type="url"
                placeholder="Source URL (optional)"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <textarea
                required
                placeholder="Paste the recipe text here…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                className="border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900 resize-y"
              />
              <button
                type="submit"
                disabled={loading}
                className="bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white font-medium px-5 py-3 rounded-lg whitespace-nowrap"
              >
                {loading ? 'Clipping…' : 'Save Recipe'}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="url"
                required
                placeholder="https://example.com/some-recipe"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="flex-1 border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <button
                type="submit"
                disabled={loading}
                className="bg-gray-900 hover:bg-gray-800 disabled:opacity-50 text-white font-medium px-5 py-3 rounded-lg whitespace-nowrap"
              >
                {loading ? 'Clipping…' : 'Save Recipe'}
              </button>
            </div>
          )}
        </form>
        <button
          type="button"
          onClick={() => {
            setPasteMode((v) => !v)
            setError(null)
          }}
          className="text-gray-400 hover:text-gray-600 text-sm mb-8 underline"
        >
          {pasteMode ? 'Paste a URL instead' : "Site blocking us? Paste the recipe text instead"}
        </button>
        {error && <p className="text-red-600 text-sm mb-8">{error}</p>}

        <div className="mt-12">
          {recipesLoading && recipes.length === 0 ? (
            <p className="text-gray-400 text-sm">Loading recipes…</p>
          ) : totalCount === 0 ? (
            <p className="text-gray-400 text-sm">No recipes saved yet.</p>
          ) : (
            <ul className="divide-y divide-gray-200 border-t border-b border-gray-200">
              {recipes.map((r) => (
                <li key={r.id}>
                  <a
                    href={`/recipe/${r.id}`}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(`/recipe/${r.id}`)
                    }}
                    className="flex items-center gap-3 py-4 hover:bg-gray-100 px-2 -mx-2 rounded"
                  >
                    {r.image_url ? (
                      <img src={r.image_url} alt="" className="w-12 h-12 rounded object-cover shrink-0" />
                    ) : (
                      <div className="w-12 h-12 rounded bg-gray-200 shrink-0" />
                    )}
                    <span className="text-gray-900 font-medium flex-1">{r.title}</span>
                    <span className="text-gray-400 text-sm whitespace-nowrap">{sourceDomain(r.url)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}

          {totalPages > 1 && (
            <nav aria-label="Recipe pages" className="flex items-center justify-between mt-6 text-sm">
              <button
                type="button"
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1 || recipesLoading}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Previous
              </button>
              <span className="text-gray-500">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => goToPage(page + 1)}
                disabled={page >= totalPages || recipesLoading}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Next
              </button>
            </nav>
          )}
        </div>
      </div>
    </div>
  )
}
