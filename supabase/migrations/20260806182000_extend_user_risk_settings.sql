alter table public.user_settings
  add column if not exists allowed_dte smallint[] not null default array[0,1,2]::smallint[],
  add column if not exists min_contract_volume integer not null default 100,
  add column if not exists max_spread_pct numeric(5,2) not null default 10,
  add column if not exists max_open_positions integer not null default 1,
  add column if not exists entry_start_minutes smallint not null default 585,
  add column if not exists entry_end_minutes smallint not null default 885,
  add column if not exists paper_trading_enabled boolean not null default true;

alter table public.user_settings
  add constraint user_settings_allowed_dte_valid check (allowed_dte <@ array[0,1,2]::smallint[] and cardinality(allowed_dte) > 0),
  add constraint user_settings_min_volume_valid check (min_contract_volume between 0 and 10000000),
  add constraint user_settings_max_spread_valid check (max_spread_pct between 0.1 and 50),
  add constraint user_settings_max_positions_valid check (max_open_positions between 0 and 5),
  add constraint user_settings_entry_window_valid check (entry_start_minutes between 570 and 930 and entry_end_minutes between 585 and 945 and entry_start_minutes < entry_end_minutes);

comment on table public.user_settings is
  'Per-user scanner and paper-execution controls. Live brokerage execution is not supported.';
