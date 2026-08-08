alter table public.research_fetches add column if not exists timeframe text not null default '1Min' check (timeframe in ('1Min','1Day'));
