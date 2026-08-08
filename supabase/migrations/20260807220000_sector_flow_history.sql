-- Sector radar backtest data: every read appended (not just the 'latest' upsert), and
-- every suggested play recorded so its outcome can be graded later.
create table if not exists public.sector_flow_history (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  minutes int not null,
  phase text not null check (phase in ('premarket','session')),
  spy_change numeric,
  reads jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists sector_flow_history_date_idx on public.sector_flow_history (session_date, minutes);
alter table public.sector_flow_history enable row level security;

create table if not exists public.sector_play_suggestions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  etf text not null,
  direction text not null check (direction in ('in','out')),
  contract_ticker text not null,
  side text not null,
  strike numeric not null,
  expiration_date date not null,
  ask numeric not null,
  spread_pct numeric,
  delta numeric,
  source text not null, -- 'map' | 'rotation'
  created_at timestamptz not null default now(),
  unique (session_date, etf, source)
);
alter table public.sector_play_suggestions enable row level security;
