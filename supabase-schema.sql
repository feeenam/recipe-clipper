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
