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
}
