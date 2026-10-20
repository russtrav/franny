-- Canned replies Franny gives instead of looking anything up. pattern is a case-insensitive
-- JavaScript regular expression checked against the question; the first active match wins.
-- The replies themselves live only in the database (not in this public repo) so they stay a surprise.
create table league_qa.easter_eggs (
  id integer generated always as identity primary key,
  pattern text not null,
  reply text not null,
  active boolean not null default true,
  added_at timestamptz not null default now()
);
alter table league_qa.easter_eggs enable row level security;
revoke all on league_qa.easter_eggs from public, anon, authenticated;
