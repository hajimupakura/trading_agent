-- Manual and auto-adopted positions have no originating signal; the NOT NULL on
-- signal_id made every monitor save for them fail, which silently disabled the
-- trailing exit (peak bid could never persist between worker cycles).
alter table public.paper_position_monitors alter column signal_id drop not null;
