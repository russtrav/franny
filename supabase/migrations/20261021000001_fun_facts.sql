-- Franny's fun facts: Franny digs up a league stat on its own and (later, once approved) drops it
-- into the league Discord at random times. This migration adds the bookkeeping only. The schedule
-- starts switched OFF and there is no cron job yet; nothing posts anywhere.

-- Every fact Franny writes, posted or not: previews for review, scheduled posts, rejects.
create table league_qa.fun_facts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'working'
    check (status in ('working', 'preview', 'posted', 'skipped', 'failed')),
  trigger text not null default 'preview',   -- preview | schedule | manual
  slot text,                                 -- recap | wildcard | preview | offseason
  angle text,                                -- which starting idea it was given
  headline text,
  fact text,
  managers text[],                           -- who the fact is about (spreads the spotlight around)
  confidence text,
  check_note text,                           -- the fact-checker's verdict
  sql text,                                  -- the query whose rows are shown under the fact
  columns jsonb,
  rows jsonb,
  queries jsonb,                             -- every query it ran, for review
  discord_channel_id text,
  discord_message_id text,
  posted_at timestamptz,
  model text,
  queries_run integer,
  input_tokens integer,
  output_tokens integer,
  est_cost_usd numeric(10,6),
  ms integer,
  error_detail text
);
create index fun_facts_created_at_idx on league_qa.fun_facts (created_at desc);

-- One row of settings. enabled = the posting schedule; it stays false until Russ approves.
create table league_qa.fun_fact_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  channel_id text,
  window_start_hour integer not null default 10 check (window_start_hour between 0 and 23),
  window_end_hour integer not null default 21 check (window_end_hour between 1 and 24),
  min_gap_hours integer not null default 12 check (min_gap_hours between 1 and 72),
  max_posts_per_day integer not null default 2,
  max_previews_per_day integer not null default 30,
  next_post_at timestamptz,
  next_slot text,
  last_slot text,
  consecutive_failures integer not null default 0,
  in_flight_since timestamptz,
  check (window_end_hour > window_start_hour)
);
insert into league_qa.fun_fact_settings default values;

-- ESPN team id -> manager name, for the current season's standings and schedule.
-- ESPN keeps team ids across seasons; update a row when a team changes hands.
create table league_qa.espn_teams (
  espn_team_id integer primary key,
  manager_name text not null
);
insert into league_qa.espn_teams (espn_team_id, manager_name) values
  (1, 'Russ'), (2, 'John'), (3, 'Dave'), (4, 'Jesse'), (5, 'Keeves'), (7, 'Brian'),
  (9, 'Eric'), (10, 'Perk'), (11, 'Evan'), (12, 'Tom'), (13, 'Stiv'), (14, 'Tony');

alter table league_qa.fun_facts enable row level security;
alter table league_qa.fun_fact_settings enable row level security;
alter table league_qa.espn_teams enable row level security;
revoke all on league_qa.fun_facts, league_qa.fun_fact_settings, league_qa.espn_teams from public, anon, authenticated;

-- Shared secret the scheduler (and Russ, from the SQL editor) sends as x-franny-token.
select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'franny_facts_token',
  'Sent as x-franny-token to the franny-facts function');

-- The current season as ESPN has it: teams (mapped to managers) and the full schedule with scores.
-- Read from the ESPN sync's latest league snapshot. Only standings and the schedule leave here.
create or replace function league_qa.franchise_now()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with snap as (
    select payload, fetched_at from motherboard.espn_snapshots
    where league_key = 'franchise' and kind = 'league'
    order by fetched_at desc limit 1
  )
  select jsonb_build_object(
    'season', (payload->>'seasonId')::int,
    'current_week', (payload->'status'->>'currentMatchupPeriod')::int,
    'regular_season_weeks', (payload->'settings'->'scheduleSettings'->>'matchupPeriodCount')::int,
    'as_of', fetched_at,
    'teams', (
      select jsonb_agg(jsonb_build_object(
        'id', (t->>'id')::int,
        'manager', coalesce(et.manager_name, initcap(trim(m->>'firstName'))),
        'team_name', trim(t->>'name')) order by (t->>'id')::int)
      from jsonb_array_elements(payload->'teams') t
      left join league_qa.espn_teams et on et.espn_team_id = (t->>'id')::int
      left join lateral (
        select mm from jsonb_array_elements(payload->'members') mm
        where mm->>'id' = t->>'primaryOwner' limit 1
      ) x(m) on true),
    'games', (
      select jsonb_agg(jsonb_build_object(
        'week', (g->>'matchupPeriodId')::int,
        'tier', g->>'playoffTierType',
        'winner', g->>'winner',
        'home', (g->'home'->>'teamId')::int,
        'away', (g->'away'->>'teamId')::int,
        'home_pts', (g->'home'->>'totalPoints')::numeric,
        'away_pts', (g->'away'->>'totalPoints')::numeric)
        order by (g->>'matchupPeriodId')::int, (g->>'id')::int)
      from jsonb_array_elements(payload->'schedule') g)
  )
  from snap;
$$;
revoke all on function league_qa.franchise_now() from public, anon, authenticated;

-- When the next fact should go out. In season it follows the NFL week:
--   recap    Tuesday            (last week's results are final)
--   wildcard Wednesday/Thursday (any angle)
--   preview  Friday/Saturday    (this week's matchups)
-- No posts Sunday or Monday. The day inside a slot and the minute inside the posting window are
-- random, at least min_gap_hours after the last post, and the same slot never runs twice in a row.
-- Off-season: one a week, 5-9 days apart.
create or replace function league_qa.plan_next_fun_fact(
  after timestamptz default now(), last_slot text default null, in_season boolean default true)
returns table (at timestamptz, slot text)
language plpgsql volatile security invoker set search_path = '' as $$
declare
  tz constant text := 'America/New_York';
  s record;
  d0 date := (after at time zone tz)::date;
  d date;
  k text;
  chosen text;
  eligible date[] := '{}';
  pick date;
  win_start timestamptz;
  win_end timestamptz;
  earliest timestamptz;
begin
  select window_start_hour, window_end_hour, min_gap_hours into s
  from league_qa.fun_fact_settings where id;

  if not in_season then
    pick := d0 + 5 + floor(random() * 5)::int;
    win_start := (pick::timestamp + make_interval(hours => s.window_start_hour)) at time zone tz;
    win_end := (pick::timestamp + make_interval(hours => s.window_end_hour)) at time zone tz;
    return query select win_start + (win_end - win_start) * random(), 'offseason'::text;
    return;
  end if;

  for i in 0..20 loop
    d := d0 + i;
    k := case extract(isodow from d)::int
           when 2 then 'recap' when 3 then 'wildcard' when 4 then 'wildcard'
           when 5 then 'preview' when 6 then 'preview' end;
    if k is null then
      if chosen is not null then exit; end if;
      continue;
    end if;
    win_end := (d::timestamp + make_interval(hours => s.window_end_hour)) at time zone tz;
    earliest := greatest((d::timestamp + make_interval(hours => s.window_start_hour)) at time zone tz,
                         after + make_interval(hours => s.min_gap_hours));
    if chosen is null then
      if k = last_slot and i <= 2 then continue; end if;  -- that slot just ran this week
      if earliest > win_end - interval '30 minutes' then continue; end if;
      chosen := k;
      eligible := array[d];
    elsif k = chosen then
      if earliest <= win_end - interval '30 minutes' then eligible := eligible || d; end if;
    else
      exit;
    end if;
  end loop;

  pick := eligible[1 + floor(random() * array_length(eligible, 1))::int];
  win_end := (pick::timestamp + make_interval(hours => s.window_end_hour)) at time zone tz;
  earliest := greatest((pick::timestamp + make_interval(hours => s.window_start_hour)) at time zone tz,
                       after + make_interval(hours => s.min_gap_hours));
  return query select earliest + (win_end - earliest) * random(), chosen;
end;
$$;
revoke all on function league_qa.plan_next_fun_fact(timestamptz, text, boolean) from public, anon, authenticated;
