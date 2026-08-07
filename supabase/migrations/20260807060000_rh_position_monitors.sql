-- Exit-engine state for Robinhood agentic-account option positions: the Railway
-- worker evaluates stop/trail/time rules and tracks peak bids here, while all
-- broker I/O flows through the app's CRON_SECRET-guarded /api/cron/rh-exec
-- endpoint (Robinhood tokens are only decryptable at app runtime).
create table if not exists public.rh_position_monitors (
  occ_ticker text primary key,
  account_number text not null,
  option_id text not null,
  chain_symbol text not null,
  option_type text not null check (option_type in ('call','put')),
  strike numeric not null,
  expiration_date date not null,
  quantity numeric not null,
  entry_price numeric not null,
  peak_bid numeric not null default 0,
  opened_at timestamptz not null,
  opened_at_exact boolean not null default false,
  status text not null default 'monitoring',
  latest_bid numeric,
  exit_reason text,
  close_order_id text,
  close_submitted_at timestamptz,
  close_limit numeric,
  last_error text,
  updated_at timestamptz not null default now()
);
comment on table public.rh_position_monitors is 'Server-only exit-engine state for Robinhood agentic-account option positions.';
alter table public.rh_position_monitors enable row level security;
