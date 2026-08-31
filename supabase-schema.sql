create table recipes (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  title text not null,
  ingredients jsonb not null,
  steps jsonb not null,
  created_at timestamptz not null default now()
);

alter table recipes enable row level security;

create policy "public read" on recipes for select using (true);
create policy "public insert" on recipes for insert with check (true);
