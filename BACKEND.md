# Franchise League History — backend

A question box for The Franchise. A leaguemate types "What's the longest win streak of all time?"
and gets a plain-English answer plus the table behind it, in a few seconds.

## How a question is answered

1. The page POSTs to the `league-ask` Supabase Edge Function with the league passcode.
2. The function takes 1 unit from today's league-wide budget (100/day; "Think harder" costs 5).
3. **Fast path:** Claude Haiku 5.5 writes one SELECT. It's checked by the query guard, then run as the
   `league_reader` database role in a read-only transaction (5 s timeout, 200-row cap). A failed
   query goes back to Haiku with the error, up to 3 tries. Haiku then writes a 1–3 sentence answer.
4. **Think harder:** Claude Sonnet 5.5 works as a small agent that can run up to 5 read-only
   queries to check names, try a second approach or verify a result before answering.
5. Every question is logged to `league_qa.questions` (question, asker, SQL, answer, tokens, cost, time).

## Safety layers (outermost first)

| Layer | What it stops |
|---|---|
| League passcode (secret `LEAGUE_PASSCODE`) | Strangers with the link |
| Daily cap, 100 units/day, resets midnight Eastern | A leaked passcode running up the bill |
| Anthropic workspace spend limit | Anything the cap misses |
| Query guard (`guard.ts`) | Writes, multiple statements, other schemas, risky functions |
| Extended-protocol single statement | Stacked statements |
| `league_reader` role: SELECT on 11 football tables + 7 views only | Baseball, auth, storage, vault, any write |
| Read-only transaction + 5 s timeout | Write tricks, outbound web requests, runaway queries |

No key of any kind is in the page. The function never uses the service role for model-written SQL.

## Secrets (Supabase → Edge Functions → Secrets)

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Key from the "Franchise League" Anthropic workspace |
| `LEAGUE_READER_PASSWORD` | Password for the `league_reader` database role |
| `LEAGUE_PASSCODE` | Shared league passcode |
| `LEAGUE_DAILY_CAP` | Optional. Units per day (default 100) |
| `LEAGUE_ALLOWED_ORIGINS` | Optional. Comma list of page origins for CORS (default `*`) |
| `LEAGUE_FAST_MODEL` / `LEAGUE_DEEP_MODEL` | Optional model overrides |

## API

`POST https://seqvzektwxxypdcqgtve.supabase.co/functions/v1/league-ask`, JSON body:

- `{ "action": "hello", "passcode": "…" }` → manager list, champions (for the plaque), today's usage, what's on file
- `{ "action": "ask", "passcode": "…", "question": "…", "asker": "Tom", "deep": false }`
  → `{ ok, answer, reading, columns, rows, row_count, truncated, sql, remaining_today, … }`
  or `{ ok: false, code, message }` with code `bad_passcode`, `daily_cap`, `needs_asker`,
  `no_query`, `busy`, `budget` or `config`
- `{ "action": "health", "passcode": "…" }` → setup check (no secret values returned)

## Handy queries (SQL editor)

```sql
-- What people asked recently
select asked_at, asker, question, deep, left(answer, 120), error_code, est_cost_usd
from league_qa.questions order by asked_at desc limit 50;

-- Spend by day
select (asked_at at time zone 'America/New_York')::date as day, count(*), round(sum(est_cost_usd), 4)
from league_qa.questions group by 1 order by 1 desc;
```

## Rotating things

- **Passcode:** change `LEAGUE_PASSCODE`; tell the league.
- **Reader password:** `alter role league_reader password '<new>';` then update `LEAGUE_READER_PASSWORD`.
- **New football table:** `grant select on public.<table> to league_reader;` and add it to `prompt.ts`.

## Discord bot

`supabase/functions/_shared/league-qa/answer.ts` exports `answerQuestion()` and has no web code in it.
A bot function imports it, defers the interaction (Discord wants a reply within 3 s), and posts the
answer as a follow-up. Pass `client: "discord"` when logging.

## Tests

`deno run -A tests/guard_test.ts` checks the query guard against 27 allowed and blocked queries.

## The page

`index.html` (GitHub Pages, https://russtrav.github.io/franny/) calls the function with
`Content-Type: text/plain` so browsers make a simple request with no CORS preflight. Set
`LEAGUE_ALLOWED_ORIGINS` to `https://russtrav.github.io` so other websites can't call it from a browser.

## Discord

`supabase/functions/franny-discord` is the bot. Discord's **Interactions Endpoint URL** points at
`https://seqvzektwxxypdcqgtve.supabase.co/functions/v1/franny-discord`.

- `/franny question:<text>`: Franny replies "thinking…" at once (Discord allows 3 seconds), then edits
  the reply with the answer, a phone-width table (top 10 rows), a **Think harder** button and an
  **Open Franny** link. Same question logic, same 100-a-day budget as the page.
- No passcode in Discord. Being in the server is the pass.
- "My" questions: `league_qa.discord_members` maps Discord usernames (lowercase) to managers. The first
  time a listed person uses Franny, their Discord user id is saved too, so a username change later
  doesn't break the match. Unlisted people can still ask anything that doesn't say "my".
- Secrets: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` (the token is only used to
  register the command).
- Admin actions (POST with `{ "passcode": "…" }`): `?admin=register` registers `/franny`,
  `?admin=members` lists the username map, `?admin=preview` with `question` (and optional `as`, a
  Discord username) returns the message Franny would post, without touching Discord.

```sql
-- Add or fix a manager's Discord username
insert into league_qa.discord_members (handle, manager_name) values ('their_username', 'Tom')
on conflict (handle) do update set manager_name = excluded.manager_name;
```

Registered command: `/franny` (application 1562110932866310154). Add Franny to a server with
`https://discord.com/oauth2/authorize?client_id=1562110932866310154&scope=bot+applications.commands&permissions=0`
(Public Bot is off, so only the app owner can use that link). The username list lives only in the
database, not in this public repo; `?admin=members` shows it.

Tests: `deno test -A tests/discord_test.ts` plays Discord (signed requests, PING, deferred reply,
table width, Think harder button).

## Easter eggs

`league_qa.easter_eggs` holds canned replies Franny gives instead of looking anything up, on both the
page and Discord. `pattern` is a case-insensitive JavaScript regular expression checked against the
question; the first active match wins. Eggs answer instantly, cost nothing and don't use the daily
budget, and they're logged with `model = 'easter-egg'`. Changes show up within 2 minutes. The replies
live only in the database so they stay a surprise.

```sql
-- Add one (\b = word edge, so "fumbles" matches but "fumbler" doesn't)
insert into league_qa.easter_eggs (pattern, reply) values ('\bfumbles?\b', 'Your reply here');

-- See them, or switch one off
select id, pattern, reply, active from league_qa.easter_eggs order by id;
update league_qa.easter_eggs set active = false where id = 1;
```
