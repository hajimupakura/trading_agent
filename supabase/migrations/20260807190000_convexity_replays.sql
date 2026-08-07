-- Overnight Convexity Phase 2: historical replay queue + results.
-- Each row is one entry-session; the cron processes one queued row per light tick.
create table if not exists public.convexity_replays (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null unique,
  exit_date date not null,
  status text not null default 'queued' check (status in ('queued','running','done','error')),
  qualification jsonb,
  spot_entry numeric,
  results jsonb,
  summary jsonb,
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.convexity_replays enable row level security;
create index if not exists convexity_replays_status_idx on public.convexity_replays (status, entry_date desc);
