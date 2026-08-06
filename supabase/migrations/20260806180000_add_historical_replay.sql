create table public.historical_replay_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  underlying text not null check (underlying in ('SPY', 'SPX')),
  session_date date not null,
  dte smallint not null check (dte between 0 and 2),
  strategy_version text not null,
  raw_storage_path text not null,
  status text not null check (status in ('complete', 'partial', 'failed')),
  summary jsonb not null,
  created_at timestamptz not null default now()
);

create index historical_replay_runs_owner_created_idx
  on public.historical_replay_runs (owner_id, created_at desc);
create index historical_replay_runs_lookup_idx
  on public.historical_replay_runs (underlying, session_date desc, dte);

alter table public.historical_replay_runs enable row level security;
revoke all on public.historical_replay_runs from anon, authenticated;
grant all on public.historical_replay_runs to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('historical-replay', 'historical-replay', false, 52428800, array['application/gzip'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on table public.historical_replay_runs is
  'Server-only summaries for deterministic historical strategy replays; raw quote payloads live in the private historical-replay Storage bucket.';
