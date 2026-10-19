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
3. Runs a second, best-effort LLM call that tags the recipe (cuisine, meal type, 1-3 main ingredients) while a dish image is generated (Pollinations) and uploaded to Supabase Storage, then inserts the recipe row. Neither a tagging failure nor an image failure blocks the save; the recipe is just untagged (`tagged_at` stays null) or imageless.

The home page can filter by cuisine, meal type and main ingredient and sort by newest, oldest or title. Filters, sort and page live in the URL (`/?cuisine=italian&page=2`) and are applied by the database, so pagination stays correct. Tag chips on a recipe page link to the matching filter.

### Cooking mode (`src/pages/RecipePage.tsx`)
- `useWakeLock` keeps the screen on while cooking.
- `useVoiceAssistant` records mic audio with `MediaRecorder`, detects end of speech by silence, and posts the audio to `api/voice-assistant.ts`.
- The API transcribes it with Whisper, then a Groq model acts as a strict command router: it must call exactly one tool (next / previous / repeat / current step, look up an ingredient, stop). The server executes the tool against the recipe and returns text to speak, so the LLM never answers freely.

### Admin (`/admin`) and deleting recipes
Log in at `/admin` and a Delete button appears on every recipe page (with a confirm prompt). Deletion goes through `api/delete-recipe.ts`, which checks the admin cookie and uses the service-role key; the anon key has no delete permission on purpose. It also removes the recipe's dish image from storage.

A password-protected status page (`api/admin-*.ts`) that probes the Gemini and Groq providers and shows whether each is online. The auth helpers are intentionally duplicated across the three files because Vercel's bundler would not include shared modules (see the note in `api/admin-login.ts`).

## Project layout

```
api/                    Serverless functions (extract-recipe, voice-assistant, delete-recipe, admin-*)
src/pages/              HomePage (add + list recipes), RecipePage (cooking mode), AdminPage
src/lib/                supabase client, useWakeLock, useVoiceAssistant
scripts/                One-off maintenance scripts (backfill-clean-recipes.ts, backfill-recipe-tags.ts)
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
| `ADMIN_PASSWORD` | `/admin` login, admin-only delete |
| `SUPABASE_SERVICE_ROLE_KEY` | `delete-recipe` and the local backfill scripts (server-only; never expose to the browser) |
| `VITE_TURNSTILE_SITE_KEY` | login page bot check (the secret key lives in Supabase, not here) |
| `VITE_INVITE_EMAIL` | optional "Request an invite" link on the login page |

Run the SQL in `supabase-schema.sql` in your Supabase project once to create the tables and bucket. When upgrading an existing project, run only the newer blocks (the recipe-tags migration at the bottom) **before** deploying code that uses them.

## Accounts

Recipes belong to a user and are private by default. Sign-in is email and password (Supabase Auth stores the passwords, hashed), accounts are invite-only, and visitors can try saving one recipe through an anonymous trial (no image, one per user, capped per IP per day). A recipe's owner can set it to "anyone with the link" from its page. The voice assistant is admin-only (`/admin` login).

One-time setup, in this order:

1. **Cloudflare Turnstile:** create a widget for your production hostname and `localhost`. Put the site key in `VITE_TURNSTILE_SITE_KEY` (`.env.local` and Vercel).
2. **Supabase > Authentication:**
   - Sign In / Providers: turn **off** "Allow new users to sign up", turn **on** "Allow anonymous sign-ins".
   - Attack Protection: enable CAPTCHA, provider Turnstile, paste the **secret** key.
   - URL Configuration: set the Site URL to your production URL and add redirect URLs for it, `http://localhost:5173` and, if you test on previews, `https://*.vercel.app`.
3. **Invite yourself:** Authentication > Users > Invite user, open the email link once so the account exists. Invite anyone else the same way. Invited users have no password yet: on the login page they use "Forgot your password, or first time here?" to get an email link, which asks them to choose one. Consider raising the minimum password length (Authentication > Sign In / Providers > Email); the app itself requires 8.
4. **Migration:** run the "User accounts" block at the bottom of `supabase-schema.sql` (set `owner_email` to your email first). It gives all existing recipes to that user and drops the public policies, so the old deployed code stops working until the new code is live: run it and deploy together.
5. Set `VITE_TURNSTILE_SITE_KEY` (and optionally `VITE_INVITE_EMAIL`) in Vercel, then deploy.

## Scripts

- `npm run dev` start the dev server
- `npm run build` typecheck and build
- `npm run typecheck` TypeScript only
- `node scripts/backfill-clean-recipes.ts` reads saved recipes and writes SQL to decode HTML entities (e.g. `&#39;`) in old rows; review the generated file and run it in the Supabase SQL editor. Needs `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment (recipes are private per user, so it reads with the service role).
- `node scripts/backfill-recipe-tags.ts` tags recipes that have no tags yet (`--all` re-tags everything) and writes SQL to review and run in the Supabase SQL editor. Additionally needs `GEMINI_API_KEY` (optional `GROQ_API_KEY`).

## CI

- **Supabase Keepalive** writes to a dedicated row daily so the free-tier project is not paused for inactivity.
- **PR Agent** reviews and describes pull requests using Gemini. Needs the `GEMINI_API_KEY` Actions secret. Comment `/review`, `/describe` or `/improve` on a PR to rerun.
