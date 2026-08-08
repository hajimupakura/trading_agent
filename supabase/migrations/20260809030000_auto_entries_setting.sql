-- Autonomous paper entries toggle (off by default; SPY only, all gates enforced).
alter table public.user_settings add column if not exists auto_entries_enabled boolean not null default false;
