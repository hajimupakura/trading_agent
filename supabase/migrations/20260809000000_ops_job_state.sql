-- Ops heartbeat: per-cron-job consecutive failure tracking for paging.
create table if not exists public.ops_job_state (
  job text primary key,
  consecutive_errors int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table public.ops_job_state enable row level security;
