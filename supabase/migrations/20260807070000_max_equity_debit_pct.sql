-- Configurable equity-percentage debit cap (was hardcoded 1%). Default relaxed to 2%;
-- small accounts can raise it — the per-trade dollar cap and buying power still bound it.
alter table public.user_settings add column if not exists max_equity_debit_pct numeric not null default 2 check (max_equity_debit_pct >= 0.5 and max_equity_debit_pct <= 100);
