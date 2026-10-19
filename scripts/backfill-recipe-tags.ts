// One-off backfill: tags already-saved recipes (cuisine / meal type / main ingredients).
//
// Like backfill-clean-recipes.ts, this does NOT write to the database: recipes are private per
// user, so it reads every user's rows with the service-role key (local use only: keep it in
// .env.local, never in the browser or a VITE_ var), and the SQL it writes is run by hand. It reads untagged recipes, asks the LLM for tags, and writes
// a SQL file of UPDATEs for you to review and run in the Supabase SQL editor.
//
// Run the tag migration in supabase-schema.sql first.
//
// Usage (Node 22.6+):
//   VITE_SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//   GEMINI_API_KEY=... [GROQ_API_KEY=...] \
//     node scripts/backfill-recipe-tags.ts [output.sql] [--all]
//
// By default only recipes with no tags yet (tagged_at is null) are processed; --all re-tags everything.
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { hasTags, tagRecipe, type RecipeTags } from '../api/extract-recipe.ts'

const url = process.env.VITE_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const geminiKey = process.env.GEMINI_API_KEY
const groqKey = process.env.GROQ_API_KEY
if (!url || !serviceRoleKey || !geminiKey) {
  console.error('Set VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and GEMINI_API_KEY (GROQ_API_KEY is optional)')
  process.exit(1)
}
const args = process.argv.slice(2)
const retagAll = args.includes('--all')
const outFile = args.find((a) => !a.startsWith('--')) ?? 'backfill-recipe-tags.sql'

// Gentle on the Gemini free tier's requests-per-minute limit.
const DELAY_BETWEEN_CALLS_MS = Number(process.env.TAG_DELAY_MS ?? 2000)
const PAGE = 500

const supabase = createClient(url, serviceRoleKey)

interface Row {
  id: string
  title: string
  ingredients: string[]
  steps: string[]
}

// Dollar-quoting avoids escaping apostrophes; refuse the (absurd) case where the tag appears in the data.
function dollarQuote(value: string): string {
  if (value.includes('$bf$')) throw new Error('Value contains the $bf$ quote tag; handle this row manually')
  return `$bf$${value}$bf$`
}

function toUpdateSql(id: string, tags: RecipeTags): string {
  const text = (v: string | null) => (v === null ? 'null' : dollarQuote(v))
  const array = tags.main_ingredients.length
    ? `array[${tags.main_ingredients.map(dollarQuote).join(', ')}]::text[]`
    : `'{}'::text[]`
  return (
    `update recipes set cuisine = ${text(tags.cuisine)}, meal_type = ${text(tags.meal_type)}, ` +
    `main_ingredients = ${array}, tagged_at = now() where id = '${id}';`
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE) {
    let query = supabase.from('recipes').select('id, title, ingredients, steps').order('created_at', { ascending: true })
    if (!retagAll) query = query.is('tagged_at', null)
    const { data, error } = await query.range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to read recipes: ${error.message}`)
    rows.push(...(data as Row[]))
    if (!data || data.length < PAGE) break
  }
  console.log(`${rows.length} recipe(s) to tag.\n`)

  const statements: string[] = []
  const skipped: string[] = []
  for (const [i, row] of rows.entries()) {
    const tags = await tagRecipe(
      { title: row.title, ingredients: row.ingredients ?? [], steps: row.steps ?? [] },
      geminiKey!,
      groqKey
    )
    if (hasTags(tags)) {
      statements.push(toUpdateSql(row.id, tags))
      console.log(
        `${row.title}\n    ${tags.cuisine ?? '?'} | ${tags.meal_type ?? '?'} | ${tags.main_ingredients.join(', ') || '?'}`
      )
    } else {
      skipped.push(row.title)
      console.log(`${row.title}\n    (no tags returned, skipped)`)
    }
    if (i < rows.length - 1) await sleep(DELAY_BETWEEN_CALLS_MS)
  }

  console.log(`\nTagged ${statements.length}; skipped ${skipped.length}.`)
  if (skipped.length) console.log(`Skipped (rerun the script later to retry): ${skipped.join('; ')}`)
  if (statements.length === 0) return

  writeFileSync(outFile, `begin;\n${statements.join('\n')}\ncommit;\n`)
  console.log(`Wrote ${outFile}. Review it, then run it in the Supabase SQL editor.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
