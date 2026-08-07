-- Trend-day continuation entries: consolidation breakouts after 30 minutes of persistence
-- beyond the opening range. Validated out-of-sample vs the ORB baseline (6/25-8/6:
-- +$388 vs +$113 per contract; +135% excluding the calibration day). Default ON;
-- signals still require manual approval plus the full risk gate.
alter table public.user_settings add column if not exists trend_day_entries_enabled boolean not null default true;
