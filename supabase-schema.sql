create table recipes (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  title text not null,
  ingredients jsonb not null,
  steps jsonb not null,
  image_url text,
  created_at timestamptz not null default now()
);

alter table recipes enable row level security;

create policy "public read" on recipes for select using (true);
create policy "public insert" on recipes for insert with check (true);

-- Storage bucket for generated dish images
insert into storage.buckets (id, name, public)
values ('recipe-images', 'recipe-images', true);

create policy "public read recipe images"
  on storage.objects for select
  using (bucket_id = 'recipe-images');

create policy "public upload recipe images"
  on storage.objects for insert
  with check (bucket_id = 'recipe-images');

-- ============================================================
-- Keepalive (dedicated writable row for the GitHub Action ping,
-- so free-tier inactivity pause sees a real write, not just a read)
-- ============================================================

create table keepalive (
  id int primary key default 1,
  alive boolean not null default true,
  pinged_at timestamptz not null default now(),
  constraint keepalive_singleton check (id = 1)
);

insert into keepalive (id) values (1);

alter table keepalive enable row level security;

create policy "Allow anon read"
  on keepalive for select
  using (true);

create policy "Allow anon update"
  on keepalive for update
  using (true)
  with check (true);

-- ============================================================
-- Recipe tags (cuisine / meal type / main ingredients) used to filter and sort the list.
-- Safe to run on an existing database: every column is nullable or defaulted, so the
-- currently deployed code keeps working. Run this BEFORE deploying the code that writes
-- these columns. `tagged_at` is null until a recipe has been tagged (the backfill script
-- uses it to find recipes still to do).
-- ============================================================

alter table recipes add column if not exists cuisine text;
alter table recipes add column if not exists meal_type text;
alter table recipes add column if not exists main_ingredients text[] not null default '{}';
alter table recipes add column if not exists tagged_at timestamptz;

create index if not exists recipes_cuisine_idx on recipes (cuisine);
create index if not exists recipes_meal_type_idx on recipes (meal_type);
create index if not exists recipes_main_ingredients_idx on recipes using gin (main_ingredients);

-- ============================================================
-- User accounts: private recipes, sharing, anonymous one-recipe trial.
--
-- BREAKING: this drops the public read/insert policies, so run it at the same moment you
-- deploy the matching code (downtime in between is expected). Run the whole block in one go
-- in the SQL editor so it applies as a single transaction.
--
-- BEFORE running:
--   1. Auth > Sign In / Providers: turn OFF "Allow new users to sign up" (invite-only) and
--      turn ON "Allow anonymous sign-ins" (the one-recipe trial).
--   2. Auth > Attack Protection: enable CAPTCHA with Turnstile and paste the secret key.
--   3. Invite your own email (Auth > Users > Invite user) and sign in once, so the backfill
--      below can find your user.
--   4. Replace owner_email in the DO block with that email.
-- ============================================================

-- True for the throwaway users created by "Try one recipe" (supabase.auth.signInAnonymously).
create or replace function public.is_anonymous_user() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

alter table recipes add column if not exists user_id uuid references auth.users (id) on delete cascade default auth.uid();
-- 'private' = owner only; 'public' = anyone with the link (never listed anywhere).
alter table recipes add column if not exists visibility text not null default 'private';
alter table recipes drop constraint if exists recipes_visibility_check;
alter table recipes add constraint recipes_visibility_check check (visibility in ('private', 'public'));

-- Give every existing recipe to the owner, then make ownership mandatory.
do $$
declare
  owner_email text := 'CHANGE_ME@example.com';
  owner_id uuid;
begin
  if exists (select 1 from recipes where user_id is null) then
    select id into owner_id from auth.users where email = owner_email;
    if owner_id is null then
      raise exception 'No auth user with email %; edit owner_email and sign in once first', owner_email;
    end if;
    update recipes set user_id = owner_id where user_id is null;
  end if;
end $$;

alter table recipes alter column user_id set not null;
create index if not exists recipes_user_id_idx on recipes (user_id);

drop policy if exists "public read" on recipes;
drop policy if exists "public insert" on recipes;

create policy "owner or public read" on recipes for select
  using (user_id = (select auth.uid()) or visibility = 'public');

create policy "owner insert" on recipes for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Trial users can't share: only non-anonymous owners may set visibility to 'public'.
create policy "owner update" on recipes for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (visibility = 'private' or not public.is_anonymous_user())
  );

create policy "owner delete" on recipes for delete to authenticated
  using (user_id = (select auth.uid()));

-- A trial user gets exactly one recipe. Enforced here so it holds even if someone calls the
-- REST API directly instead of going through /api/extract-recipe.
create or replace function public.enforce_trial_limit() returns trigger
language plpgsql as $$
begin
  if public.is_anonymous_user() and exists (select 1 from recipes where user_id = new.user_id) then
    raise exception 'Trial limit reached: sign in to save more recipes';
  end if;
  return new;
end $$;

drop trigger if exists recipes_trial_limit on recipes;
create trigger recipes_trial_limit before insert on recipes
  for each row execute function public.enforce_trial_limit();

-- Per-IP daily cap on trial clips, since clearing browser storage mints a fresh anonymous
-- user. Holds only a hash of the caller's IP. No policies on purpose: nobody can read or
-- write it directly, only claim_trial_clip() below (security definer).
create table if not exists trial_clips (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists trial_clips_ip_idx on trial_clips (ip_hash, created_at);
alter table trial_clips enable row level security;

create or replace function public.claim_trial_clip(p_ip_hash text, p_daily_limit int default 3) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from trial_clips where ip_hash = p_ip_hash and created_at > now() - interval '24 hours') >= p_daily_limit then
    return false;
  end if;
  insert into trial_clips (ip_hash) values (p_ip_hash);
  return true;
end $$;

revoke execute on function public.claim_trial_clip(text, int) from public, anon;
grant execute on function public.claim_trial_clip(text, int) to authenticated;

-- Images: new uploads go to <user_id>/<uuid>.<ext>; trial users don't get images at all.
-- The bucket stays public-read (unguessable URLs, and shared recipes need to show them).
drop policy if exists "public upload recipe images" on storage.objects;
create policy "users upload to own folder" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'recipe-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and not public.is_anonymous_user()
  );

-- Daily cleanup of abandoned trials. Deleting the auth user cascades to their recipes.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'delete-stale-trials',
  '17 3 * * *',
  $$
    delete from auth.users where is_anonymous and created_at < now() - interval '7 days';
    delete from public.trial_clips where created_at < now() - interval '2 days';
  $$
);

-- ============================================================
-- Prompt-injection hardening: per-user daily extraction cap + source-link cleanup.
-- Additive: safe to run BEFORE deploying the matching code (nothing existing depends on it).
-- Needs pg_cron (already enabled by the user-accounts block above).
-- ============================================================

-- Every request that reaches the model or a page fetch is logged here (refusals included,
-- since they still cost quota). No policies on purpose: only claim_extraction() writes to it.
create table if not exists extraction_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists extraction_log_user_idx on extraction_log (user_id, created_at);
alter table extraction_log enable row level security;

-- True when the signed-in caller is still under the limit (rolling 24 hours), and records the
-- request. The API passes the limit; calling this directly can only ever use up your own quota.
create or replace function public.claim_extraction(p_daily_limit int default 5) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    return false;
  end if;
  -- One request at a time per user, so two simultaneous requests can't both slip under the limit.
  perform pg_advisory_xact_lock(hashtext(uid::text));
  if (select count(*) from extraction_log where user_id = uid and created_at > now() - interval '24 hours') >= p_daily_limit then
    return false;
  end if;
  insert into extraction_log (user_id) values (uid);
  return true;
end $$;

revoke execute on function public.claim_extraction(int) from public, anon;
grant execute on function public.claim_extraction(int) to authenticated;

-- Only plain http(s) source links are accepted from now on (a javascript: link in a shared
-- recipe would run in the visitor's session). Blank any non-http(s) link already saved.
update recipes set url = '' where url <> '' and url !~* '^https?://';

select cron.schedule(
  'prune-extraction-log',
  '23 3 * * *',
  $$ delete from public.extraction_log where created_at < now() - interval '2 days' $$
);
