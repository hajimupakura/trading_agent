alter table public.replay_runs add column if not exists raw_storage_path text;

drop table if exists public.historical_replay_runs;

comment on column public.replay_runs.raw_storage_path is
  'Private Supabase Storage object containing the compressed raw bars, quotes, and reconstruction inputs for this replay.';
