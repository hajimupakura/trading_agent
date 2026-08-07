-- Economic-event guard: blocks entries around CPI/NFP mornings (until 10:00 ET) and
-- FOMC decision windows (13:30-15:00 ET). Default ON; toggleable in Settings.
alter table public.user_settings add column if not exists economic_guard_enabled boolean not null default true;
