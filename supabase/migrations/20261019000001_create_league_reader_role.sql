-- Read-only login used by the league-facing question tool to run model-written SQL.
-- No password here (set separately as a SCRAM hash so it never lands in migration history).
create role league_reader with login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 5;

alter role league_reader set default_transaction_read_only = on;
alter role league_reader set statement_timeout = '5s';
alter role league_reader set lock_timeout = '1s';
alter role league_reader set idle_in_transaction_session_timeout = '10s';
alter role league_reader set search_path = public;

grant usage on schema public to league_reader;

grant select on
  public.auction_results, public.leagues, public.lineup_decisions, public.managers,
  public.matchups, public.player_weekly_stats, public.players, public.seasons,
  public.team_players, public.teams, public.weeks,
  public.head_to_head, public.manager_career_summary, public.v_auction_results,
  public.v_player_weekly_stats, public.v_players, public.v_team_players, public.v_teams
to league_reader;

comment on role league_reader is 'Read-only: SELECT on The Franchise football tables/views only. Used by the league-ask edge function.';
