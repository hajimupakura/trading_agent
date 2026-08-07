-- Overnight Convexity capture layer (Phase 1 — research only, no auto-trading).
-- candidates: the ~15:50 ET snapshot of next-session SPXW contracts under $8 with
--   entry-time quotes/Greeks plus the day's qualification verdict.
-- burst_quotes: per-minute executable bid/ask for tracked candidates, 9:25-10:15 ET
--   the next morning (the harvest window).
-- outcomes: per-contract results computed at ~10:30 — MFE/MAE and simulated exits
--   under several harvest rules, for the filter-on vs filter-off study.
create table if not exists public.convexity_candidates (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  expiry_date date not null,
  ticker text not null,
  side text not null,
  strike numeric not null,
  bid numeric, ask numeric, midpoint numeric, spread_pct numeric,
  delta numeric, gamma numeric, theta numeric, iv numeric,
  volume bigint, open_interest bigint,
  underlying_price numeric,
  qualified boolean not null default false,
  direction text,
  qualification jsonb not null default '{}',
  tracked boolean not null default false,
  created_at timestamptz not null default now(),
  unique (session_date, ticker)
);
create table if not exists public.convexity_burst_quotes (
  id bigint generated always as identity primary key,
  session_date date not null,
  ticker text not null,
  at timestamptz not null default now(),
  bid numeric, ask numeric, underlying numeric
);
create index if not exists convexity_burst_idx on public.convexity_burst_quotes (session_date, ticker, at);
create table if not exists public.convexity_outcomes (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  ticker text not null,
  entry_ask numeric,
  qualified boolean,
  direction text,
  metrics jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (session_date, ticker)
);
alter table public.convexity_candidates enable row level security;
alter table public.convexity_burst_quotes enable row level security;
alter table public.convexity_outcomes enable row level security;
