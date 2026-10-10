# Recipe Clipper

Paste a recipe URL (or the page text) and get a clean, ad-free recipe: title, ingredients and steps, saved to a shared library. Open a recipe in cooking mode to keep the screen awake and control it hands-free by voice.

## Stack

- **Frontend:** React 18 + TypeScript, Vite, Tailwind CSS, React Router
- **Backend:** Vercel serverless functions in `api/`
- **Database / storage:** Supabase (Postgres table `recipes`, storage bucket `recipe-images`)
- **LLMs:** Gemini (recipe extraction), Groq (extraction fallback, Whisper transcription, voice command routing)

## How it works

### Saving a recipe (`api/extract-recipe.ts`)
1. Fetches the page and tries to read structured `application/ld+json` Recipe data first (no LLM needed).
2. If that fails, runs Mozilla Readability to get the article text and asks Gemini to return `{title, ingredients, steps}` as JSON. On rate limits or server errors it falls back to Groq.
3. Generates a dish image (Pollinations), uploads it to Supabase Storage, and inserts the recipe row. Image failure never blocks the save.

### Cooking mode (`src/pages/RecipePage.tsx`)
- `useWakeLock` keeps the screen on while cooking.
- `useVoiceAssistant` records mic audio with `MediaRecorder`, detects end of speech by silence, and posts the audio to `api/voice-assistant.ts`.
- The API transcribes it with Whisper, then a Groq model acts as a strict command router: it must call exactly one tool (next / previous / repeat / current step, look up an ingredient, stop). The server executes the tool against the recipe and returns text to speak, so the LLM never answers freely.

### Admin (`/admin`)
A password-protected status page (`api/admin-*.ts`) that probes the Gemini and Groq providers and shows whether each is online. The auth helpers are intentionally duplicated across the three files because Vercel's bundler would not include shared modules (see the note in `api/admin-login.ts`).

## Project layout

```
api/                    Serverless functions (extract-recipe, voice-assistant, admin-*)
src/pages/              HomePage (add + list recipes), RecipePage (cooking mode), AdminPage
src/lib/                supabase client, useWakeLock, useVoiceAssistant
supabase-schema.sql     Tables, RLS policies, storage bucket, keepalive table
.github/workflows/      keepalive.yml (daily Supabase ping), pr-agent.yml (AI PR review)
```

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in the values below
npm run dev                  # frontend only
```

`vite` does not serve `api/`, so to test the serverless functions locally use `npx vercel dev` instead.

Environment variables:

| Variable | Used by |
| --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | frontend and `extract-recipe` |
| `GEMINI_API_KEY` | `extract-recipe`, admin status |
| `GROQ_API_KEY` | `extract-recipe` fallback, `voice-assistant`, admin status |
| `ADMIN_PASSWORD` | `/admin` login |

Run the SQL in `supabase-schema.sql` in your Supabase project once to create the tables and bucket.

## Scripts

- `npm run dev` start the dev server
- `npm run build` typecheck and build
- `npm run typecheck` TypeScript only

## CI

- **Supabase Keepalive** writes to a dedicated row daily so the free-tier project is not paused for inactivity.
- **PR Agent** reviews and describes pull requests using Gemini. Needs the `GEMINI_API_KEY` Actions secret. Comment `/review`, `/describe` or `/improve` on a PR to rerun.
