create table public.broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null check (broker in ('robinhood')),
  status text not null default 'connected' check (status in ('connected','error','revoked')),
  oauth_client_id text not null,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  account_id text,
  capabilities jsonb not null default '{}'::jsonb,
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker)
);
create index broker_connections_user_id_idx on public.broker_connections(user_id);
alter table public.broker_connections enable row level security;
revoke all on public.broker_connections from anon, authenticated;
grant all on public.broker_connections to service_role;
comment on table public.broker_connections is 'Server-only encrypted OAuth credentials and capability state for external execution brokers.';

create table public.broker_oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null check (broker in ('robinhood')),
  oauth_client_id text not null,
  code_verifier_ciphertext text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index broker_oauth_states_user_id_idx on public.broker_oauth_states(user_id);
create index broker_oauth_states_expires_at_idx on public.broker_oauth_states(expires_at);
alter table public.broker_oauth_states enable row level security;
revoke all on public.broker_oauth_states from anon, authenticated;
grant all on public.broker_oauth_states to service_role;
comment on table public.broker_oauth_states is 'Short-lived server-only PKCE state. Rows are deleted when consumed.';
