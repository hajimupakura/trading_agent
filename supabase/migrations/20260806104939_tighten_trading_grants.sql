revoke all on public.profiles, public.user_settings, public.strategy_versions,
  public.option_contract_snapshots, public.paper_positions, public.trade_journal,
  public.replay_runs, public.replay_trades, public.strategy_metrics, public.alerts
  from anon, authenticated;

grant select on public.profiles to authenticated;
grant select, update on public.user_settings to authenticated;
grant select, insert, update, delete on public.paper_positions, public.trade_journal,
  public.replay_runs, public.replay_trades, public.alerts to authenticated;
