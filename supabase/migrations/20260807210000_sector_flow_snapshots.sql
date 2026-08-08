-- Sector money-flow radar: latest panel snapshot (single-row upsert, id='latest').
create table if not exists public.sector_flow_snapshots (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.sector_flow_snapshots enable row level security;
