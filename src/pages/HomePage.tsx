import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase, type Recipe } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const PAGE_SIZE = 10

type SortOption = 'newest' | 'oldest' | 'title'
const SORT_LABELS: Record<SortOption, string> = { newest: 'Newest first', oldest: 'Oldest first', title: 'Title A–Z' }

type FacetOption = { value: string; count: number }
interface Facets {
  cuisine: FacetOption[]
  meal: FacetOption[]
  ingredient: FacetOption[]
}
const EMPTY_FACETS: Facets = { cuisine: [], meal: [], ingredient: [] }

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function countValues(values: string[]): FacetOption[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return Array.from(counts, ([value, count]) => ({ value, count })).sort(
    (a, b) => b.count - a.count || a.value.localeCompare(b.value)
  )
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string
  allLabel: string
  value: string
  options: FacetOption[]
  onChange: (value: string) => void
}) {
  // Nothing to filter on yet (no recipes carry this tag), and nothing selected: hide it.
  if (options.length === 0 && !value) return null
  // Keep a value from the URL selectable even if no saved recipe matches it any more.
  const valueIsListed = !value || options.some((o) => o.value === value)
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900"
    >
      <option value="">{allLabel}</option>
      {!valueIsListed && <option value={value}>{capitalize(value)}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {capitalize(o.value)} ({o.count})
        </option>
      ))}
    </select>
  )
}

export function HomePage() {
  const navigate = useNavigate()
  const { session, isAnonymous } = useAuth()
  const userId = session?.user.id
  const [searchParams, setSearchParams] = useSearchParams()
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [pasteMode, setPasteMode] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [recipesLoading, setRecipesLoading] = useState(true)
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS)

  // Page, filters and sort live in the URL so back-navigation from a recipe returns to the
  // same view and a filtered list can be bookmarked.
  const requestedPage = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const cuisineFilter = searchParams.get('cuisine') ?? ''
  const mealFilter = searchParams.get('meal') ?? ''
  const ingredientFilter = searchParams.get('ingredient') ?? ''
  const sortParam = searchParams.get('sort')
  const sort: SortOption = sortParam === 'oldest' || sortParam === 'title' ? sortParam : 'newest'
  const hasActiveFilters = Boolean(cuisineFilter || mealFilter || ingredientFilter)
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const page = Math.min(requestedPage, totalPages)

  useEffect(() => {
    if (!userId) return
    let cancelled = false
    setRecipesLoading(true)
    const from = (requestedPage - 1) * PAGE_SIZE
    // Filtering is done by the database so pagination and the total stay correct. RLS also lets
    // us read other people's shared recipes, so the library must filter to our own explicitly.
    let query = supabase.from('recipes').select('*', { count: 'exact' }).eq('user_id', userId)
    if (cuisineFilter) query = query.eq('cuisine', cuisineFilter)
    if (mealFilter) query = query.eq('meal_type', mealFilter)
    if (ingredientFilter) query = query.contains('main_ingredients', [ingredientFilter])
    query = sort === 'title' ? query.order('title', { ascending: true }) : query.order('created_at', { ascending: sort === 'oldest' })
    query
      .order('id') // tie-breaker so rows can't repeat or vanish across pages
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
  }, [userId, requestedPage, cuisineFilter, mealFilter, ingredientFilter, sort])

  // Options for the filter dropdowns, built from what's actually saved (most common first).
  // One lightweight query; fine at personal-library scale.
  useEffect(() => {
    if (!userId) return
    supabase
      .from('recipes')
      .select('cuisine, meal_type, main_ingredients')
      .eq('user_id', userId)
      .then(({ data }) => {
        const rows = data ?? []
        setFacets({
          cuisine: countValues(rows.flatMap((r) => (r.cuisine ? [r.cuisine as string] : []))),
          meal: countValues(rows.flatMap((r) => (r.meal_type ? [r.meal_type as string] : []))),
          ingredient: countValues(rows.flatMap((r) => (r.main_ingredients as string[] | null) ?? [])),
        })
      })
  }, [userId])

  // If the URL points past the last page (e.g. recipes were removed), snap back to it.
  useEffect(() => {
    // replace so the invalid entry doesn't stay in history and trap the Back button.
    if (!recipesLoading && requestedPage > totalPages) goToPage(totalPages, { replace: true })
  }, [recipesLoading, requestedPage, totalPages])

  // Changes some URL params while keeping the rest (null / '' removes a param).
  function updateParams(changes: Record<string, string | null>, options?: { replace?: boolean }) {
    const next = new URLSearchParams(searchParams)
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setSearchParams(next, options)
  }

  function goToPage(nextPage: number, options?: { replace?: boolean }) {
    updateParams({ page: nextPage <= 1 ? null : String(nextPage) }, options)
    window.scrollTo({ top: 0 })
  }

  // Any filter or sort change goes back to page 1.
  function setFilter(key: 'cuisine' | 'meal' | 'ingredient' | 'sort', value: string) {
    updateParams({ [key]: value === '' || (key === 'sort' && value === 'newest') ? null : value, page: null })
  }

  function clearFilters() {
    updateParams({ cuisine: null, meal: null, ingredient: null, page: null })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      // The API acts as the signed-in user, so it needs the current access token.
      const {
        data: { session: current },
      } = await supabase.auth.getSession()
      if (!current) {
        navigate('/login')
        return
      }
      const res = await fetch('/api/extract-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.access_token}` },
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

  async function handleSignOut() {
    await supabase.auth.signOut()
    navigate('/login')
  }

  // A trial user gets exactly one recipe; the database enforces it, this just explains it.
  const trialUsed = isAnonymous && !recipesLoading && totalCount >= 1

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl">
        <div className="flex justify-end mb-4 text-sm text-gray-400">
          {isAnonymous && <span className="mr-3">Trial</span>}
          <button type="button" onClick={handleSignOut} className="hover:text-gray-600 underline">
            {isAnonymous ? 'Sign in' : 'Sign out'}
          </button>
        </div>
        <h1 className="text-3xl font-semibold text-gray-900 mb-2">Recipe Clipper</h1>
        <p className="text-gray-500 mb-8">Paste a recipe URL. Get just the ingredients and steps.</p>

        {trialUsed ? (
          <p className="text-gray-600 text-sm border border-gray-200 bg-white rounded-lg px-4 py-3 mb-8">
            You've used your trial recipe. Accounts are invite-only, so sign in to save more.
          </p>
        ) : (
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
        )}
        {!trialUsed && (
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
        )}
        {error && <p className="text-red-600 text-sm mb-8">{error}</p>}

        <div className="mt-12">
          {(hasActiveFilters || totalCount > 0) && (
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <FilterSelect
                label="Filter by cuisine"
                allLabel="All cuisines"
                value={cuisineFilter}
                options={facets.cuisine}
                onChange={(v) => setFilter('cuisine', v)}
              />
              <FilterSelect
                label="Filter by meal type"
                allLabel="All meal types"
                value={mealFilter}
                options={facets.meal}
                onChange={(v) => setFilter('meal', v)}
              />
              <FilterSelect
                label="Filter by main ingredient"
                allLabel="Any ingredient"
                value={ingredientFilter}
                options={facets.ingredient}
                onChange={(v) => setFilter('ingredient', v)}
              />
              <select
                aria-label="Sort recipes"
                value={sort}
                onChange={(e) => setFilter('sort', e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900 sm:ml-auto"
              >
                {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
                  <option key={option} value={option}>
                    {SORT_LABELS[option]}
                  </option>
                ))}
              </select>
              {hasActiveFilters && (
                <button type="button" onClick={clearFilters} className="text-sm text-gray-500 hover:text-gray-700 underline">
                  Clear filters
                </button>
              )}
            </div>
          )}

          {recipesLoading && recipes.length === 0 ? (
            <p className="text-gray-400 text-sm">Loading recipes…</p>
          ) : totalCount === 0 ? (
            <p className="text-gray-400 text-sm">
              {hasActiveFilters ? 'No recipes match these filters.' : 'No recipes saved yet.'}
            </p>
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
                    <div className="flex-1 min-w-0">
                      <span className="text-gray-900 font-medium">{r.title}</span>
                      {(r.cuisine || r.meal_type || r.main_ingredients?.length > 0) && (
                        <p className="text-gray-400 text-xs mt-0.5">
                          {[r.cuisine, r.meal_type, r.main_ingredients?.join(', ')]
                            .filter(Boolean)
                            .map((part) => capitalize(part as string))
                            .join(' · ')}
                        </p>
                      )}
                    </div>
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
