-- Football league data is read-only to the public API roles. Reads stay as they were.
revoke insert, update, delete, truncate, references, trigger on
  public.auction_results, public.leagues, public.lineup_decisions, public.managers,
  public.matchups, public.player_weekly_stats, public.players, public.seasons,
  public.team_players, public.teams, public.weeks
from anon, authenticated;
