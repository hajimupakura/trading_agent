-- Self-healing step 1: automatic post-trade autopsies. One row per closed trade;
-- metrics measured from the contract's minute tape, verdict classified, AI lesson.
create table if not exists public.trade_reviews (
  id uuid primary key default gen_random_uuid(),
  sell_order_id bigint not null unique,
  contract_ticker text not null,
  underlying text,
  quantity int,
  entry_price numeric,
  exit_price numeric,
  entry_at timestamptz,
  exit_at timestamptz,
  exit_reason text,
  status text not null default 'pending_data' check (status in ('pending_data','done','error')),
  metrics jsonb,
  verdict text,
  lesson text,
  error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.trade_reviews enable row level security;
create policy "trade_reviews_public_read" on public.trade_reviews for select using (true);
