-- Allow watch-list tickers (NVDA, SPCX, TSLA, AAPL, GOOGL, META, MSFT, MU, ASTS, SKHY, ...)
-- in the monitor snapshot table. option_signals keeps its SPY/SPX check: watch tickers are
-- monitor-only and never generate signals.
alter table public.options_monitor_snapshots drop constraint if exists options_monitor_snapshots_underlying_check;
alter table public.options_monitor_snapshots add constraint options_monitor_snapshots_underlying_check check (underlying ~ '^[A-Z]{1,8}$');
