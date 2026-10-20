# Franny

The Franchise record book. Ask anything about the league since 2011 and get a plain-English answer
with the numbers underneath.

- **The page** is `index.html`, served by GitHub Pages. It holds no keys or passwords; the league
  passcode is typed in once and remembered on each device.
- **The backend** is the `league-ask` Supabase Edge Function (web page) and `franny-discord` (the Discord bot) in `supabase/functions/`, sharing one question engine. See
  [BACKEND.md](BACKEND.md) for how it answers questions, its safety layers, secrets and handy queries.

## Tests

- Query guard: `deno run -A tests/guard_test.ts`
- Discord bot: `deno test -A tests/discord_test.ts`
- Page: `python3 tests/page/run.py` drives the page in Chromium (phone and desktop, light and dark)
  against captured responses in `tests/page/fixtures.json`.
