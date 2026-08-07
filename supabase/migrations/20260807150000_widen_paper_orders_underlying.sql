-- Auto-adoption journals positions for ANY underlying the broker reports (watch
-- tickers included) — the SPY/SPX-only check made adoption inserts fail. Keep a
-- sanity bound instead of an enum so the watchlist can evolve without migrations.
alter table public.paper_trade_orders drop constraint if exists paper_trade_orders_underlying_check;
alter table public.paper_trade_orders add constraint paper_trade_orders_underlying_check check (length(underlying) between 1 and 8);
