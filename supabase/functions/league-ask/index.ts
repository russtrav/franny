// league-ask: the league-facing "League History" endpoint for The Franchise.
// POST JSON. Every action needs the shared league passcode.
//   { action: "hello",  passcode }                          -> manager list + today's budget
//   { action: "ask",    passcode, question, asker?, deep? } -> answer + table
//   { action: "health", passcode }                          -> setup check (no secrets returned)
import { answerQuestion } from "../_shared/league-qa/answer.ts";
import { ON_FILE } from "../_shared/league-qa/prompt.ts";
import { BusyError, connectionKind, easterEgg, getChampions, getManagers, logQuestion, readerIdentity, takeUnits, unitsUsedToday } from "../_shared/league-qa/db.ts";
import { DEEP_MODEL, FAST_MODEL } from "../_shared/league-qa/claude.ts";

const DAILY_CAP = () => Number(Deno.env.get("LEAGUE_DAILY_CAP") ?? 100);
const DEEP_COST = 5; // a "Think harder" question uses 5 of the daily units
const MAX_QUESTION_CHARS = 300;

function cors(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("LEAGUE_ALLOWED_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0] ?? "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(req: Request, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return json(req, status, { ok: false, code, message, ...extra });
}

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return fail(req, 405, "method", "Use POST.");

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    const raw = await req.text();
    if (raw.length > 4000) return fail(req, 413, "too_large", "That request is too large.");
    body = JSON.parse(raw);
  } catch {
    return fail(req, 400, "bad_request", "The request wasn't valid JSON.");
  }

  const expected = Deno.env.get("LEAGUE_PASSCODE");
  if (!expected) return fail(req, 503, "config", "The question tool isn't fully set up yet.");
  if (typeof body?.passcode !== "string" || !sameSecret(body.passcode.trim(), expected)) {
    await new Promise((r) => setTimeout(r, 400));
    return fail(req, 401, "bad_passcode", "That passcode isn't right. Ask in the league chat for it.");
  }

  const action = String(body.action ?? "ask");
  const cap = DAILY_CAP();

  try {
    if (action === "hello") {
      const [managers, used, champions] = await Promise.all([getManagers(), unitsUsedToday(), getChampions()]);
      return json(req, 200, {
        ok: true,
        managers: managers.map((m) => ({ name: m.name, active: m.active })),
        champions,
        daily_cap: cap, used_today: used, deep_cost: DEEP_COST, on_file: ON_FILE,
      });
    }

    if (action === "health") {
      const checks: Record<string, unknown> = {
        anthropic_key_set: !!Deno.env.get("ANTHROPIC_API_KEY"),
        reader_password_set: !!Deno.env.get("LEAGUE_READER_PASSWORD"),
        fast_model: FAST_MODEL(), deep_model: DEEP_MODEL(), daily_cap: cap,
        allowed_origins: Deno.env.get("LEAGUE_ALLOWED_ORIGINS") ?? "*",
      };
      try { checks.db_connection = connectionKind(); } catch (e) { checks.db_connection_error = String((e as Error).message ?? e); }
      try { checks.reader = await readerIdentity(); } catch (e) { checks.reader_error = String((e as Error).message ?? e); }
      try { checks.used_today = await unitsUsedToday(); } catch (e) { checks.log_error = String((e as Error).message ?? e); }
      return json(req, 200, { ok: true, checks });
    }

    if (action !== "ask") return fail(req, 400, "bad_request", "Unknown action.");

    const question = typeof body.question === "string" ? body.question.trim().replace(/\s+/g, " ") : "";
    if (!question) return fail(req, 400, "empty", "Type a question first.");
    if (question.length > MAX_QUESTION_CHARS) return fail(req, 400, "too_long", `Keep questions under ${MAX_QUESTION_CHARS} characters.`);
    const deep = body.deep === true;
    const client = body.client === "discord" ? "discord" : "web";

    const managers = await getManagers();
    const askerRaw = typeof body.asker === "string" ? body.asker.trim().toLowerCase() : "";
    const asker = managers.find((m) => m.name.toLowerCase() === askerRaw)?.name ?? null;

    // Easter eggs answer instantly, cost nothing and don't use the daily budget.
    const egg = await easterEgg(question);
    if (egg) {
      const usedNow = await unitsUsedToday();
      await logQuestion({
        client, asker, question, deep: false, model: "easter-egg", sql: null, reading: null, row_count: 0,
        answer: egg, error_code: null, error_detail: null, queries_run: 0, input_tokens: 0, output_tokens: 0,
        est_cost_usd: 0, ms: 0,
      });
      return json(req, 200, {
        ok: true, egg: true, answer: egg, reading: "", columns: [], rows: [], row_count: 0, truncated: false,
        sql: "", deep: false, model: "easter-egg", queries_run: 0, asker,
        daily_cap: cap, used_today: usedNow, remaining_today: Math.max(cap - usedNow, 0), ms: 0, est_cost_usd: 0,
      });
    }

    const cost = deep ? DEEP_COST : 1;
    const used = await takeUnits(cost, cap);
    if (used === null) {
      return fail(req, 429, "daily_cap",
        deep
          ? "There isn't enough of today's question budget left for Think harder. Try a regular question, or come back after midnight Eastern."
          : `The league has used all ${cap} of today's questions. The counter resets at midnight Eastern.`,
        { daily_cap: cap });
    }

    const started = Date.now();
    const result = await answerQuestion({ question, asker, deep, managers });
    const ms = Date.now() - started;

    await logQuestion({
      client, asker, question, deep, model: result.model,
      sql: result.ok ? result.sql : result.sql ?? null,
      reading: result.ok ? result.reading : null,
      row_count: result.ok ? result.row_count : null,
      answer: result.ok ? result.answer : null,
      error_code: result.ok ? null : result.code,
      error_detail: result.ok ? null : result.detail ?? null,
      queries_run: result.queries_run,
      input_tokens: result.usage.input, output_tokens: result.usage.output,
      est_cost_usd: Number(result.usage.cost.toFixed(6)), ms,
    });

    const { usage, ...rest } = result;
    const budget = { daily_cap: cap, used_today: used, remaining_today: Math.max(cap - used, 0) };
    if (!result.ok) {
      const status = result.code === "budget" ? 402 : result.code === "busy" ? 503 : result.code === "config" ? 503 : 200;
      return json(req, status, { ...rest, asker, ...budget, ms, est_cost_usd: Number(usage.cost.toFixed(5)) });
    }
    return json(req, 200, { ...rest, asker, ...budget, ms, est_cost_usd: Number(usage.cost.toFixed(5)) });
  } catch (e) {
    console.error(e);
    // deno-lint-ignore no-explicit-any
    if ((e as any)?.code === "53300" || e instanceof BusyError) {
      return fail(req, 503, "busy", "Lots of questions at once right now. Give it a few seconds and ask again.");
    }
    return fail(req, 500, "failed", "Something went wrong. Ask again in a moment.");
  }
});
