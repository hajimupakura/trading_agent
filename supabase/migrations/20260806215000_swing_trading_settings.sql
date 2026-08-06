-- Late-day swing entry mode: buy 1-2 DTE in a 15:45-15:58 ET window (configurable,
-- floor 15:30 to match the position worker's swing threshold), hold overnight,
-- force-sold by 10:30 ET next morning by the exit engine. Disabled by default.
alter table public.user_settings
  add column if not exists swing_trading_enabled boolean not null default false,
  add column if not exists swing_entry_start_minutes integer not null default 945,
  add column if not exists swing_entry_end_minutes integer not null default 958;

alter table public.user_settings
  add constraint user_settings_swing_start_range check (swing_entry_start_minutes >= 930 and swing_entry_start_minutes <= 955),
  add constraint user_settings_swing_end_range check (swing_entry_end_minutes >= 931 and swing_entry_end_minutes <= 959),
  add constraint user_settings_swing_window_order check (swing_entry_start_minutes < swing_entry_end_minutes);
