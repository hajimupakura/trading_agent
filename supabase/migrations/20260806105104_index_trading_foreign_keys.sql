create index alerts_user_created_idx on public.alerts (user_id, created_at desc);
create index alerts_signal_idx on public.alerts (signal_id) where signal_id is not null;
create index paper_positions_user_status_idx on public.paper_positions (user_id, status, opened_at desc);
create index paper_positions_signal_idx on public.paper_positions (signal_id) where signal_id is not null;
create index replay_runs_user_date_idx on public.replay_runs (user_id, session_date desc);
create index replay_trades_run_idx on public.replay_trades (replay_run_id, entry_at);
create index trade_journal_user_created_idx on public.trade_journal (user_id, created_at desc);
create index trade_journal_position_idx on public.trade_journal (position_id) where position_id is not null;
