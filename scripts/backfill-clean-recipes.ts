// One-off backfill: decodes HTML entities / strips stray tags in already-saved recipes.
//
// The anon key can only read `recipes` (no update policy), so this does NOT write to the
// database. It writes a SQL file of UPDATEs for only the rows that would change, which you
// review and run in the Supabase SQL editor.
//
// Usage (Node 22.6+):
//   VITE_SUPABASE_URL=https://xxxx.supabase.co VITE_SUPABASE_ANON_KEY=... \
//     node scripts/backfill-clean-recipes.ts [output.sql]
import { createClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { cleanRecipe } from '../api/extract-recipe.ts'

const url = process.env.VITE_SUPABASE_URL
const anonKey = process.env.VITE_SUPABASE_ANON_KEY
if (!url || !anonKey) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}
const outFile = process.argv[2] ?? 'backfill-clean-recipes.sql'

const supabase = createClient(url, anonKey)
const PAGE = 500

interface Row {
  id: string
  title: string
  ingredients: unknown[]
  steps: unknown[]
}

// Dollar-quoting avoids escaping apostrophes; refuse the (absurd) case where the tag appears in the data.
function dollarQuote(value: string): string {
  if (value.includes('$bf$')) throw new Error('Value contains the $bf$ quote tag; handle this row manually')
  return `$bf$${value}$bf$`
}

async function main() {
  const rows: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('recipes')
      .select('id, title, ingredients, steps')
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to read recipes: ${error.message}`)
    rows.push(...(data as Row[]))
    if (!data || data.length < PAGE) break
  }

  const statements: string[] = []
  const samples: string[] = []
  for (const row of rows) {
    const cleaned = cleanRecipe({
      title: row.title,
      ingredients: (row.ingredients ?? []) as string[],
      steps: (row.steps ?? []) as string[],
    })
    const changed =
      cleaned.title !== row.title ||
      JSON.stringify(cleaned.ingredients) !== JSON.stringify(row.ingredients) ||
      JSON.stringify(cleaned.steps) !== JSON.stringify(row.steps)
    if (!changed) continue

    statements.push(
      `update recipes set title = ${dollarQuote(cleaned.title)}, ` +
        `ingredients = ${dollarQuote(JSON.stringify(cleaned.ingredients))}::jsonb, ` +
        `steps = ${dollarQuote(JSON.stringify(cleaned.steps))}::jsonb ` +
        `where id = '${row.id}';`
    )
    if (samples.length < 5) {
      const before = [row.title, ...(row.ingredients as string[]), ...(row.steps as string[])]
      const after = [cleaned.title, ...cleaned.ingredients, ...cleaned.steps]
      const i = before.findIndex((text, idx) => text !== after[idx])
      samples.push(`  ${JSON.stringify(before[i])}\n    -> ${JSON.stringify(after[i])}`)
    }
  }

  console.log(`Checked ${rows.length} recipes; ${statements.length} need cleaning.`)
  if (statements.length === 0) return

  writeFileSync(outFile, `begin;\n${statements.join('\n')}\ncommit;\n`)
  console.log(`\nExamples:\n${samples.join('\n')}`)
  console.log(`\nWrote ${outFile}. Review it, then run it in the Supabase SQL editor.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
