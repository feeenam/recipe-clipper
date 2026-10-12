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
