-- Per-minute SPX spot samples derived from option-chain snapshots (underlying price
-- or ATM put-call parity). Fallback bar source when the market-data entitlement
-- lacks live index aggregates. Server-only: RLS enabled with no policies.
create table if not exists public.index_bar_samples (
  symbol text not null,
  bar_time timestamptz not null,
  price numeric not null check (price > 0),
  source text not null check (source in ('underlying_asset','put_call_parity')),
  created_at timestamptz not null default now(),
  primary key (symbol, bar_time)
);
comment on table public.index_bar_samples is 'Server-only per-minute index spot samples derived from option-chain snapshots; substitutes for licensed index aggregates.';
alter table public.index_bar_samples enable row level security;
create index if not exists index_bar_samples_symbol_time on public.index_bar_samples (symbol, bar_time desc);
