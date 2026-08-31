import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, type Recipe } from '../lib/supabase'

export function HomePage() {
  const navigate = useNavigate()
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recipes, setRecipes] = useState<Recipe[]>([])

  useEffect(() => {
    supabase
      .from('recipes')
      .select('*')
      .order('created_at', { ascending: false })
      .then(({ data }) => setRecipes(data ?? []))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/extract-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
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

        <form onSubmit={handleSubmit} className="flex gap-2 mb-2">
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
        </form>
        {error && <p className="text-red-600 text-sm mb-8">{error}</p>}

        <div className="mt-12">
          {recipes.length === 0 ? (
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
        </div>
      </div>
    </div>
  )
}
