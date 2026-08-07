-- Telegram dispatch cursor: alerts with notified_at null are pending delivery.
-- The every-minute cron sends instant-tier alerts (fills/exits/critical radar/AI briefs)
-- and the half-hour digest sweeps the rest. Backfill existing rows so the deploy
-- doesn't replay the whole alert history to Telegram.
alter table public.alerts add column if not exists notified_at timestamptz;
update public.alerts set notified_at = created_at where notified_at is null;
create index if not exists alerts_unnotified_idx on public.alerts (created_at) where notified_at is null;
