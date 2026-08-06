create table public.options_monitor_snapshots (
  underlying text primary key check (underlying in ('SPY', 'SPX')),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.option_signals (
  signal_id text primary key,
  underlying text not null check (underlying in ('SPY', 'SPX')),
  action text not null check (action in ('watch', 'enter_call', 'enter_put', 'no_trade')),
  setup text not null,
  confidence integer not null check (confidence between 0 and 100),
  contract_ticker text,
  fingerprint text not null,
  market_snapshot jsonb not null,
  contract_snapshot jsonb,
  reasons jsonb not null,
  invalidation text,
  ai_review jsonb,
  generated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index option_signals_underlying_generated_at_idx
  on public.option_signals (underlying, generated_at desc);
create index option_signals_contract_ticker_idx
  on public.option_signals (contract_ticker, generated_at desc)
  where contract_ticker is not null;

alter table public.options_monitor_snapshots enable row level security;
alter table public.option_signals enable row level security;

revoke all on public.options_monitor_snapshots from anon, authenticated;
revoke all on public.option_signals from anon, authenticated;
grant all on public.options_monitor_snapshots to service_role;
grant all on public.option_signals to service_role;

comment on table public.options_monitor_snapshots is
  'Server-only latest SPY/SPX monitor state. Access through authenticated application APIs.';
comment on table public.option_signals is
  'Server-only journal of deterministic 0-2 DTE research signals and optional AI reviews.';
