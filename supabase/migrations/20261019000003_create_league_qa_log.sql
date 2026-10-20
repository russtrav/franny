-- Private bookkeeping for the league question tool. Not exposed through the REST API
-- (league_qa is not in the API's exposed schemas) and not readable by league_reader.
create schema if not exists league_qa;
revoke all on schema league_qa from public, anon, authenticated;

create table league_qa.questions (
  id bigint generated always as identity primary key,
  asked_at timestamptz not null default now(),
  client text not null default 'web',          -- web | discord
  asker text,                                  -- manager name picked on the device (unverified)
  question text not null,
  deep boolean not null default false,         -- Think harder
  model text,
  sql text,
  reading text,
  row_count integer,
  answer text,
  error_code text,
  error_detail text,
  queries_run integer,
  input_tokens integer,
  output_tokens integer,
  est_cost_usd numeric(10,6),
  ms integer
);
create index questions_asked_at_idx on league_qa.questions (asked_at desc);

-- Daily cap counter. day is the America/New_York calendar date.
create table league_qa.daily_usage (
  day date primary key,
  units integer not null default 0
);

alter table league_qa.questions enable row level security;
alter table league_qa.daily_usage enable row level security;
revoke all on all tables in schema league_qa from public, anon, authenticated;

-- Atomically take `cost` units from today's budget. Returns units used after taking,
-- or null when the cap would be exceeded (nothing is taken in that case).
create or replace function league_qa.take_units(cost integer, daily_cap integer)
returns integer language sql security invoker set search_path = '' as $$
  insert into league_qa.daily_usage as u (day, units)
  select (now() at time zone 'America/New_York')::date, cost
  where cost <= daily_cap
  on conflict (day) do update set units = u.units + excluded.units
    where u.units + excluded.units <= daily_cap
  returning units;
$$;
revoke all on function league_qa.take_units(integer, integer) from public, anon, authenticated;
