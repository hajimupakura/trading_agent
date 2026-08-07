-- Manual paper orders (leaderboard contract execution) are not tied to a signal.
alter table public.paper_trade_orders alter column signal_id drop not null;
