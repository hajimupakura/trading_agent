alter table public.alerts
  add column if not exists event_key text,
  add column if not exists severity text not null default 'info',
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.alerts
  add constraint alerts_severity_valid check (severity in ('info','success','warning','critical'));

create unique index alerts_event_key_unique
  on public.alerts (event_key)
  where event_key is not null;

comment on table public.alerts is
  'User-scoped durable notifications for paper entry, exit, market-data, and position-manager events.';
