import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export interface Recipe {
  id: string
  url: string
  title: string
  ingredients: string[]
  steps: string[]
  image_url: string | null
  created_at: string
  // Tags added by the LLM at save time (or the backfill); null / empty until tagged.
  cuisine: string | null
  meal_type: string | null
  main_ingredients: string[]
  tagged_at: string | null
}
