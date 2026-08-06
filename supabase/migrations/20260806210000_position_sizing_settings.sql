-- Position sizing and contract-targeting risk settings.
-- risk_per_trade_pct: fraction of equity risked per trade (risk = debit x 30% stop distance).
-- max_contracts_per_trade: hard cap on contracts per entry.
-- delta_target: preferred absolute delta for contract selection.
alter table public.user_settings
  add column if not exists risk_per_trade_pct numeric not null default 0.005,
  add column if not exists max_contracts_per_trade integer not null default 5,
  add column if not exists delta_target numeric not null default 0.45;

alter table public.user_settings
  add constraint user_settings_risk_per_trade_pct_range check (risk_per_trade_pct >= 0.001 and risk_per_trade_pct <= 0.05),
  add constraint user_settings_max_contracts_range check (max_contracts_per_trade >= 1 and max_contracts_per_trade <= 10),
  add constraint user_settings_delta_target_range check (delta_target >= 0.25 and delta_target <= 0.70);
