-- Which Discord account belongs to which manager, so "my record" questions in Discord just work.
-- Russ fills in handles (Discord usernames, lowercase). The first time a listed person uses Franny,
-- their Discord user id is saved too, so later username changes don't break the match.
create table league_qa.discord_members (
  handle text primary key check (handle = lower(handle)),
  manager_name text not null,
  discord_user_id text unique,
  added_at timestamptz not null default now()
);
alter table league_qa.discord_members enable row level security;
revoke all on league_qa.discord_members from public, anon, authenticated;
