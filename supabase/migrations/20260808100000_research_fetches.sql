-- Ad-hoc research fetch queue: minute-aggregate pulls for any ticker, processed
-- server-side by the cron (options via Massive, equities via Alpaca).
create table if not exists public.research_fetches (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  from_date date not null,
  to_date date not null,
  status text not null default 'queued' check (status in ('queued','running','done','error')),
  bars jsonb,
  bar_count int,
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.research_fetches enable row level security;
create policy "research_fetches_public_read" on public.research_fetches for select using (true);
