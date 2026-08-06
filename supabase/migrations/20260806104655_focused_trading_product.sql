create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);
create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  max_option_ask numeric(8,2) not null default 8 check (max_option_ask > 0),
  max_trade_debit numeric(10,2) not null default 800 check (max_trade_debit > 0),
  max_daily_loss numeric(10,2) not null default 500 check (max_daily_loss > 0),
  max_trades_per_day integer not null default 3 check (max_trades_per_day between 1 and 20),
  allowed_underlyings text[] not null default array['SPY','SPX'],
  ai_review_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.strategy_versions (
  id bigint generated always as identity primary key,
  name text not null,
  version text not null unique,
  rules jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.option_contract_snapshots (
  id bigint generated always as identity primary key,
  underlying text not null check (underlying in ('SPY','SPX')),
  contract_ticker text not null,
  captured_at timestamptz not null,
  snapshot jsonb not null
);
create index option_contract_snapshots_lookup_idx on public.option_contract_snapshots (underlying, captured_at desc);
create table public.paper_positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id text references public.option_signals(signal_id),
  contract_ticker text not null,
  side text not null check (side in ('call','put')),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  quantity integer not null default 1 check (quantity > 0),
  entry_price numeric(10,4) not null,
  exit_price numeric(10,4),
  opened_at timestamptz not null,
  closed_at timestamptz,
  exit_reason text,
  created_at timestamptz not null default now()
);
create table public.trade_journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid references public.paper_positions(id) on delete set null,
  title text not null,
  notes text,
  followed_plan boolean,
  chart_snapshot jsonb,
  created_at timestamptz not null default now()
);
create table public.replay_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  underlying text not null check (underlying in ('SPY','SPX')),
  session_date date not null,
  strategy_version text not null,
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  configuration jsonb not null default '{}'::jsonb,
  summary jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create table public.replay_trades (
  id bigint generated always as identity primary key,
  replay_run_id uuid not null references public.replay_runs(id) on delete cascade,
  contract_ticker text not null,
  entry_at timestamptz not null,
  entry_ask numeric(10,4) not null,
  exit_at timestamptz,
  exit_bid numeric(10,4),
  max_favorable_pct numeric(12,4),
  max_adverse_pct numeric(12,4),
  result jsonb not null default '{}'::jsonb
);
create table public.strategy_metrics (
  id bigint generated always as identity primary key,
  strategy_version text not null,
  underlying text not null check (underlying in ('SPY','SPX')),
  period_start date not null,
  period_end date not null,
  metrics jsonb not null,
  calculated_at timestamptz not null default now()
);
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id text references public.option_signals(signal_id),
  channel text not null check (channel in ('in_app','email','telegram','browser')),
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.strategy_versions enable row level security;
alter table public.option_contract_snapshots enable row level security;
alter table public.paper_positions enable row level security;
alter table public.trade_journal enable row level security;
alter table public.replay_runs enable row level security;
alter table public.replay_trades enable row level security;
alter table public.strategy_metrics enable row level security;
alter table public.alerts enable row level security;

grant select on public.profiles to authenticated;
grant select, update on public.user_settings to authenticated;
grant select, insert, update, delete on public.paper_positions, public.trade_journal, public.replay_runs, public.replay_trades, public.alerts to authenticated;
revoke all on public.strategy_versions, public.option_contract_snapshots, public.strategy_metrics from anon, authenticated;

create policy "read own profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "read own settings" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "update own settings" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "manage own paper positions" on public.paper_positions for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "manage own journal" on public.trade_journal for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "manage own replay runs" on public.replay_runs for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "manage trades from own replay" on public.replay_trades for all to authenticated
  using (exists (select 1 from public.replay_runs run where run.id = replay_run_id and run.user_id = (select auth.uid())))
  with check (exists (select 1 from public.replay_runs run where run.id = replay_run_id and run.user_id = (select auth.uid())));
create policy "manage own alerts" on public.alerts for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();

insert into public.strategy_versions (name, version, rules, active) values
('Opening Range Confluence', '1.0.0', '{"dte":[0,2],"maxAsk":8,"maxSpreadPct":12,"minVolume":25,"rsiCall":[50,78],"rsiPut":[22,50],"minBreakoutAtr":0.1}'::jsonb, true);
