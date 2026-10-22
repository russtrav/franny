// Fun facts: season text, angle picking, and the preview-only guarantee.
// Run: deno test -A tests/facts_test.ts
import { ANGLES, factSystem, pickAngle, type SeasonNow, seasonBlock, seasonState } from "../supabase/functions/_shared/league-qa/facts.ts";

function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

const NOW = new Date("2026-10-21T22:00:00Z");

const season: SeasonNow = {
  season: 2026, current_week: 3, regular_season_weeks: 17, as_of: "2026-10-21T11:15:00Z",
  teams: [
    { id: 1, manager: "Russ", team_name: "Team One" },
    { id: 2, manager: "John", team_name: "Team Two" },
    { id: 5, manager: "Keeves", team_name: "Quoth" },
    { id: 9, manager: "Eric", team_name: "Love Hurts" },
  ],
  games: [
    { week: 1, tier: "NONE", winner: "HOME", home: 5, away: 2, home_pts: 134.26, away_pts: 81.9 },
    { week: 1, tier: "NONE", winner: "AWAY", home: 9, away: 1, home_pts: 100, away_pts: 107.84 },
    { week: 2, tier: "NONE", winner: "AWAY", home: 1, away: 5, home_pts: 75.08, away_pts: 79.92 },
    { week: 2, tier: "NONE", winner: "HOME", home: 2, away: 9, home_pts: 90.5, away_pts: 88 },
    { week: 3, tier: "NONE", winner: "UNDECIDED", home: 5, away: 9, home_pts: 0, away_pts: 0 },
    { week: 3, tier: "NONE", winner: "UNDECIDED", home: 1, away: 2, home_pts: 0, away_pts: 0 },
  ],
};

Deno.test("season block: standings, streaks, scores winner-first, this week's matchups", () => {
  const text = seasonBlock(season);
  assert(text.includes("Week 2 is the latest finished week"), text);
  assert(text.includes('1. Keeves ("Quoth") 2-0, 214.18 PF, 156.98 PA, won 2 straight'), text);
  assert(text.includes("Week 1: Keeves 134.26 beat John 81.90; Russ 107.84 beat Eric 100.00"), text);
  assert(text.includes('Eric ("Love Hurts") 0-2'), text);
  assert(text.includes("lost 2 straight"), text);
  assert(text.includes("This week (Week 3) matchups: Keeves vs Eric; Russ vs John"), text);
  assert(!/undecided/i.test(text), "unplayed games stay out of the scores");
});

Deno.test("season state: live only with a fresh snapshot and games left", () => {
  assert(seasonState(season, NOW).live);
  assert(seasonState(season, NOW).hasResults && seasonState(season, NOW).hasThisWeek);
  const stale = { ...season, as_of: "2026-09-01T00:00:00Z" };
  assert(!seasonState(stale, NOW).live, "a stale snapshot means off-season");
  const over = { ...season, games: season.games.map((g) => ({ ...g, winner: g.winner === "UNDECIDED" ? "HOME" : g.winner })) };
  assert(!seasonState(over, NOW).live, "everything decided means off-season");
  assert(!seasonState(null, NOW).live);
});

Deno.test("angles fit the slot and skip what the season can't support", () => {
  const live = seasonState(season, NOW);
  const off = { live: false, hasResults: false, hasThisWeek: false };
  for (let i = 0; i < 200; i++) {
    const r = () => (i + 0.5) / 200;
    const preview = pickAngle("preview", live, [], r);
    assert((preview.slots.preview ?? 0) > 0, `preview got ${preview.key}`);
    const recap = pickAngle("recap", live, [], r);
    assert((recap.slots.recap ?? 0) > 0, `recap got ${recap.key}`);
    const o = pickAngle("offseason", off, [], r);
    assert(!o.needs, `off-season got ${o.key}, which needs current-season data`);
    const w = pickAngle("wildcard", off, [], r);
    assert(!w.needs, `wildcard with no season got ${w.key}`);
  }
});

Deno.test("angles used in the last three facts are skipped when there's another choice", () => {
  const live = seasonState(season, NOW);
  const recent = ["auction", "luck", "matchup", "champions"];
  for (let i = 0; i < 100; i++) {
    const a = pickAngle("wildcard", live, recent, () => i / 100);
    assert(!recent.slice(0, 3).includes(a.key), `${a.key} was used in the last three`);
  }
  // only one angle fits: it's used even though it was recent
  const onlyOne = pickAngle("recap", { live: true, hasResults: false, hasThisWeek: true }, ["streaks", "luck"], () => 0.1);
  assert(["streaks", "luck"].includes(onlyOne.key), onlyOne.key);
});

Deno.test("prompt carries the season, the angle, and what was already posted", () => {
  const live = seasonState(season, NOW);
  const prompt = factSystem({
    managers: [{ name: "Russ", joined_year: 2011, retired_year: null, active: true }],
    angle: ANGLES[0], slot: "preview", season, state: live, maxQueries: 8, now: NOW,
    recent: [{ headline: "Nobody has ever started 6-0", fact: "Until now.", angle: "pace", managers: ["Keeves", "Keeves"], at: "" }],
  });
  assert(prompt.includes("Wednesday, October 21, 2026"), "Eastern date");
  assert(prompt.includes("This week (Week 3) matchups"), "season block");
  assert(prompt.includes("STARTING ANGLE: This week's matchup"), "angle");
  assert(prompt.includes("- Nobody has ever started 6-0: Until now."), "already posted");
  assert(prompt.includes("Recently featured: Keeves 2"), "spotlight counts");
  const offPrompt = factSystem({
    managers: [], angle: ANGLES[5], slot: "offseason", season: null, state: seasonState(null, NOW), maxQueries: 8, now: NOW, recent: [],
  });
  assert(offPrompt.includes("no current-season data"), "off-season prompt");
});

Deno.test("preview-only build: franny-facts and everything it imports has no way to post", async () => {
  const seen = new Set<string>();
  const queue = [new URL("../supabase/functions/franny-facts/index.ts", import.meta.url)];
  while (queue.length) {
    const url = queue.pop()!;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const src = await Deno.readTextFile(url);
    assert(!/discord\.com|discord\.ts|DISCORD_BOT_TOKEN|\/channels\//i.test(src), `${url.pathname} mentions Discord posting`);
    for (const m of src.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) queue.push(new URL(m[1], url));
  }
  assert(seen.size >= 6, `followed ${seen.size} files`);
});
