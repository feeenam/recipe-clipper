import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase, type Recipe } from '../lib/supabase'
import { useWakeLock } from '../lib/useWakeLock'

export function RecipePage() {
  const { id } = useParams()
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [loading, setLoading] = useState(true)
  const { isActive: keepAwake, isSupported: wakeLockSupported, toggle: toggleWakeLock } = useWakeLock()

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
          <Link to="/" className="text-gray-400 hover:text-gray-600 text-sm inline-block">&larr; All recipes</Link>

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
        </div>

        {recipe.image_url && (
          <img
            src={recipe.image_url}
            alt={recipe.title}
            className="w-full aspect-video object-cover rounded-lg mb-6 border border-gray-200"
          />
        )}

        <h1 className="text-3xl font-semibold text-gray-900 mb-1">{recipe.title}</h1>
        <a
          href={recipe.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-400 text-sm hover:text-gray-600 break-all"
        >
          {recipe.url}
        </a>

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
              <li key={i} className="flex gap-3 text-gray-700">
                <span className="font-medium text-gray-400">{i + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}
