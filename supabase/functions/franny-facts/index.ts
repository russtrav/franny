// franny-facts: Franny digs up a fun fact about The Franchise on its own.
//
// PREVIEW-ONLY BUILD. It writes facts to league_qa.fun_facts for Russ to review and contains no
// code that posts anywhere. Posting to Discord and the schedule come in a later version, once the
// samples and the posting schedule are approved.
//
// POST with header x-franny-token (vault secret franny_facts_token) or JSON { passcode }:
//   ?admin=preview  { slot?, angle? }  -> starts one fact in the background, returns its id
//   ?admin=status                      -> settings, season state and the latest facts
import { ANGLES, findFact, pickAngle, type Slot, SLOTS, seasonState } from "../_shared/league-qa/facts.ts";
import {
  factSettings, factsStartedToday, factsToken, finishFact, getManagers, latestFacts, recentFacts, seasonNow, startFact,
} from "../_shared/league-qa/db.ts";

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: { waitUntil(p: Promise<any>): void } | undefined;

function background(p: Promise<unknown>) {
  const guarded = p.catch((e) => console.error("background task failed", e));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(guarded);
}

// deno-lint-ignore no-explicit-any
async function allowed(req: Request, body: any): Promise<boolean> {
  const token = req.headers.get("x-franny-token") ?? "";
  if (token) {
    const expected = await factsToken();
    return !!expected && sameSecret(token, expected);
  }
  const passcode = Deno.env.get("LEAGUE_PASSCODE") ?? "";
  return !!passcode && typeof body?.passcode === "string" && sameSecret(body.passcode.trim(), passcode);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Franny is digging.", { status: 200 });
  const action = new URL(req.url).searchParams.get("admin") ?? "";
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    const raw = await req.text();
    if (raw.length > 4000) return json({ ok: false, error: "request too large" }, 413);
    body = raw ? JSON.parse(raw) : {};
  } catch { /* empty */ }

  try {
    if (!(await allowed(req, body))) {
      await new Promise((r) => setTimeout(r, 400));
      return json({ ok: false, error: "not allowed" }, 401);
    }

    if (action === "preview") {
      const settings = await factSettings();
      const limit = Number(settings.max_previews_per_day ?? 30);
      if ((await factsStartedToday("preview")) >= limit) {
        return json({ ok: false, error: `Today's preview limit (${limit}) is used up.` }, 429);
      }
      const [season, recent] = await Promise.all([seasonNow(), recentFacts(true)]);
      const state = seasonState(season);
      const slot: Slot = SLOTS.includes(body.slot) ? body.slot : state.live ? "wildcard" : "offseason";
      const angle = ANGLES.find((a) => a.key === body.angle) ?? pickAngle(slot, state, recent.map((r) => r.angle));
      const id = await startFact({ trigger: "preview", slot, angle: angle.key });

      background((async () => {
        const started = Date.now();
        try {
          const managers = await getManagers();
          const r = await findFact({ slot, angle, managers, season, recent });
          await finishFact(id, {
            status: r.ok ? "preview" : "skipped",
            headline: r.headline, fact: r.fact, managers: r.managers, confidence: r.confidence,
            check_note: r.check_note || null, sql: r.sql, columns: r.columns, rows: r.rows, queries: r.queries,
            model: r.model, queries_run: r.queries_run, input_tokens: r.usage.input, output_tokens: r.usage.output,
            est_cost_usd: Number(r.usage.cost.toFixed(6)), ms: Date.now() - started, error_detail: r.problem ?? null,
          });
        } catch (e) {
          console.error(e);
          await finishFact(id, {
            status: "failed", headline: null, fact: null, managers: [], confidence: null, check_note: null, sql: null,
            columns: [], rows: [], queries: [], model: null, queries_run: 0, input_tokens: 0, output_tokens: 0,
            est_cost_usd: 0, ms: Date.now() - started, error_detail: String((e as Error)?.message ?? e),
          }).catch((err) => console.error("couldn't record the failure", err));
        }
      })());
      return json({ ok: true, id, slot, angle: angle.key }, 202);
    }

    if (action === "status") {
      const [settings, season, facts] = await Promise.all([factSettings(), seasonNow(), latestFacts(10)]);
      const state = seasonState(season);
      return json({
        ok: true, build: "preview-only", settings, season: { ...state, season: season?.season, week: season?.current_week },
        facts,
      });
    }

    return json({ ok: false, error: "This build only previews. Use ?admin=preview or ?admin=status." }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
