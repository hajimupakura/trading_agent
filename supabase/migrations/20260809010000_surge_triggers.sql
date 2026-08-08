-- Surge radar: measured breakout-trigger fires per symbol per session (alert-only).
create table if not exists public.surge_triggers (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  symbol text not null,
  direction text not null check (direction in ('up','down')),
  detail jsonb,
  created_at timestamptz not null default now(),
  unique (session_date, symbol)
);
alter table public.surge_triggers enable row level security;
create policy "surge_triggers_public_read" on public.surge_triggers for select using (true);
