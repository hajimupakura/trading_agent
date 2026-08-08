-- Per-position exit mode: burst = full stop/trail/time engine (default, unchanged);
-- trend = MAX CONVEXITY ride — only the 50% disaster floor sells automatically.
alter table public.paper_position_monitors add column if not exists exit_mode text not null default 'burst' check (exit_mode in ('burst','trend'));
