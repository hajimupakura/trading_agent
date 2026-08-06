alter table public.paper_trade_orders drop constraint paper_trade_orders_signal_unique;
create unique index paper_trade_orders_entry_signal_unique on public.paper_trade_orders(signal_id) where action = 'buy_to_open';
alter table public.paper_trade_orders alter column max_debit drop not null;
alter table public.paper_trade_orders drop constraint paper_trade_orders_max_debit_check;
alter table public.paper_trade_orders add constraint paper_trade_orders_max_debit_check check (max_debit is null or max_debit > 0);

create table public.paper_position_monitors (
  contract_ticker text primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  signal_id text not null references public.option_signals(signal_id) on delete restrict,
  status text not null check (status in ('monitoring','closing','closed','error')),
  entry_price numeric(12,4) not null check (entry_price > 0),
  peak_bid numeric(12,4) not null check (peak_bid >= 0),
  latest_bid numeric(12,4) not null check (latest_bid >= 0),
  latest_ask numeric(12,4) not null check (latest_ask >= 0),
  opened_at timestamptz not null,
  last_quote_at timestamptz not null,
  exit_reason text,
  close_order_id text,
  close_order_submitted_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
create index paper_position_monitors_user_idx on public.paper_position_monitors(user_id);
create index paper_position_monitors_signal_idx on public.paper_position_monitors(signal_id);
alter table public.paper_position_monitors enable row level security;
revoke all on public.paper_position_monitors from anon,authenticated;
grant all on public.paper_position_monitors to service_role;

create table public.position_manager_control (
  id boolean primary key default true check (id),
  auto_exits_enabled boolean not null default true,
  kill_switch boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.position_manager_control(id,auto_exits_enabled,kill_switch) values(true,true,false);
alter table public.position_manager_control enable row level security;
revoke all on public.position_manager_control from anon,authenticated;
grant all on public.position_manager_control to service_role;

create table public.position_manager_status (
  id text primary key,
  enabled boolean not null,
  healthy boolean not null,
  managed_positions integer not null default 0 check (managed_positions >= 0),
  last_error text,
  last_heartbeat timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.position_manager_status enable row level security;
revoke all on public.position_manager_status from anon,authenticated;
grant all on public.position_manager_status to service_role;
