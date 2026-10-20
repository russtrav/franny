// Discord side of Franny: request signing, message layout, and the interaction handler.
// Discord calls the franny-discord function for every /franny command and button press.
// Franny replies "thinking…" right away (Discord allows 3 seconds), then edits that reply
// with the answer once the shared question logic is done.
import nacl from "npm:tweetnacl@1.0.3";
import { answerQuestion, type AskResult } from "./answer.ts";
import { easterEgg, getManagers, logQuestion, loggedQuestion, managerForDiscord, takeUnits } from "./db.ts";

export const PAGE_URL = "https://russtrav.github.io/franny/";
const BRASS = 0xC49A3A;
const DEEP_COST = 5;
const DAILY_CAP = () => Number(Deno.env.get("LEAGUE_DAILY_CAP") ?? 100);

// ---------- signatures ----------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) return new Uint8Array();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Discord signs every request with the app's key; anything that doesn't verify gets a 401. */
export function verifyDiscord(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): boolean {
  const key = hexToBytes(publicKeyHex), sig = hexToBytes(signatureHex);
  if (key.length !== 32 || sig.length !== 64 || !timestamp) return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(timestamp + body), sig, key);
  } catch {
    return false;
  }
}

// ---------- layout ----------

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function label(k: string): string {
  const t = k.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s);

/**
 * A small monospace table that stays readable on a phone: at most 10 rows, short cells,
 * and columns dropped from the right until it fits about 44 characters wide.
 */
export function formatTable(columns: string[], rows: Record<string, unknown>[], maxRows = 10, maxWidth = 44): string {
  if (!rows.length) return "";
  let keys = (columns.length ? columns : Object.keys(rows[0])).filter((k) => !/(^id$|_id$)/i.test(k));
  if (!keys.length) keys = columns.length ? columns : Object.keys(rows[0]);
  const shown = rows.slice(0, maxRows);
  const build = (ks: string[]) => {
    const head = ks.map((k) => cut(label(k), 14));
    const body = shown.map((r) => ks.map((k) => cut(cell(r[k]), 16)));
    const numeric = ks.map((_, i) => body.every((row) => row[i] === "-" || isNum(row[i])));
    const widths = ks.map((_, i) => Math.max(head[i].length, ...body.map((row) => row[i].length)));
    const line = (vals: string[]) =>
      vals.map((v, i) => (numeric[i] ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join("  ").trimEnd();
    return { text: [line(head), ...body.map(line)].join("\n"), width: widths.reduce((a, b) => a + b, 0) + 2 * (ks.length - 1) };
  };
  let out = build(keys);
  while (out.width > maxWidth && keys.length > 2) {
    keys = keys.slice(0, -1);
    out = build(keys);
  }
  const more = rows.length > maxRows ? `\n+${rows.length - maxRows} more rows on the web page` : "";
  return out.text + more;
}

// deno-lint-ignore no-explicit-any
type Msg = { content?: string; embeds?: any[]; components?: any[]; allowed_mentions?: any };

function buttons(logId: number | null, deep: boolean) {
  // deno-lint-ignore no-explicit-any
  const row: any[] = [];
  if (!deep && logId) row.push({ type: 2, style: 2, label: "Think harder", custom_id: `deep:${logId}` });
  row.push({ type: 2, style: 5, label: "Open Franny", url: PAGE_URL });
  return [{ type: 1, components: row }];
}

export function answerMessage(question: string, r: AskResult, remaining: number, logId: number | null): Msg {
  if (!r.ok) return noticeMessage(question, failureText(r.code, r.message));
  const table = formatTable(r.columns, r.rows);
  const description = cut(r.answer, 1500) + (table ? "\n```\n" + cut(table, 2200) + "\n```" : "");
  const footer = [
    r.reading ? "How Franny read it: " + cut(r.reading, 220) : "",
    `${remaining} of ${DAILY_CAP()} questions left today` + (r.deep ? ". Thought harder" : ""),
  ].filter(Boolean).join("\n");
  return {
    embeds: [{ color: BRASS, title: cut((r.deep ? "Thinking harder: " : "") + question, 256), description, footer: { text: footer } }],
    components: buttons(logId, r.deep),
    allowed_mentions: { parse: [] },
  };
}

export function noticeMessage(question: string, text: string): Msg {
  return {
    embeds: [{ color: BRASS, title: cut(question, 256), description: text }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open Franny", url: PAGE_URL }] }],
    allowed_mentions: { parse: [] },
  };
}

function failureText(code: string, message: string): string {
  if (code === "needs_asker") {
    return "Franny doesn't know which manager you are yet, so it can't answer questions about \"me\" or \"my\". " +
      "Ask Russ to add your Discord name, or ask it with a name instead (\"What's Tom's record against Dave?\").";
  }
  if (code === "no_query") return "Franny couldn't turn that into a lookup. Try rewording it.";
  return message;
}

// ---------- the work ----------

export type Who = { id: string; names: string[] };

/** Answer a question for a Discord user and return the message to post. Shared by Discord and the preview tool. */
export async function runQuestion(question: string, who: Who, deep: boolean, presetAsker?: string | null): Promise<Msg> {
  const managers = await getManagers();
  const asker = presetAsker !== undefined ? presetAsker : await managerForDiscord(who.id, who.names);
  const cap = DAILY_CAP();

  // Easter eggs answer instantly, cost nothing and don't use the daily budget.
  const egg = await easterEgg(question);
  if (egg) {
    await logQuestion({
      client: "discord", asker, question, deep: false, model: "easter-egg", sql: null, reading: null, row_count: 0,
      answer: egg, error_code: null, error_detail: null, queries_run: 0, input_tokens: 0, output_tokens: 0,
      est_cost_usd: 0, ms: 0,
    });
    return { embeds: [{ color: BRASS, title: cut(question, 256), description: egg }], allowed_mentions: { parse: [] } };
  }

  const used = await takeUnits(deep ? DEEP_COST : 1, cap);
  if (used === null) {
    return noticeMessage(question, deep
      ? "There isn't enough of today's question budget left for Think harder. It resets at midnight Eastern."
      : `The league has used all ${cap} of today's questions. They reset at midnight Eastern.`);
  }
  const started = Date.now();
  const r = await answerQuestion({ question, asker, deep, managers });
  const logId = await logQuestion({
    client: "discord", asker, question, deep, model: r.model,
    sql: r.ok ? r.sql : r.sql ?? null, reading: r.ok ? r.reading : null, row_count: r.ok ? r.row_count : null,
    answer: r.ok ? r.answer : null, error_code: r.ok ? null : r.code, error_detail: r.ok ? null : r.detail ?? null,
    queries_run: r.queries_run, input_tokens: r.usage.input, output_tokens: r.usage.output,
    est_cost_usd: Number(r.usage.cost.toFixed(6)), ms: Date.now() - started,
  });
  return answerMessage(question, r, Math.max(cap - used, 0), logId);
}

// ---------- Discord API ----------

async function editOriginal(appId: string, token: string, msg: Msg): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) });
    if (res.ok) return;
    const text = await res.text();
    if (res.status === 429 && attempt < 2) {
      let wait = 1;
      try { wait = Number(JSON.parse(text).retry_after ?? 1); } catch { /* keep 1s */ }
      await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
      continue;
    }
    console.error("Discord edit failed", res.status, text.slice(0, 500));
    return;
  }
}

export async function registerCommands(appId: string, botToken: string): Promise<{ status: number; body: unknown }> {
  const commands = [{
    name: "franny",
    type: 1,
    description: "Ask Franny anything about The Franchise since 2011",
    contexts: [0],
    integration_types: [0],
    options: [{ type: 3, name: "question", description: "Like: longest win streak of all time", required: true, max_length: 300 }],
  }];
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${botToken}` },
    body: JSON.stringify(commands),
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
}

// ---------- interactions ----------

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: { waitUntil(p: Promise<any>): void } | undefined;

function background(p: Promise<unknown>) {
  const guarded = p.catch((e) => console.error("background task failed", e));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(guarded);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
function whoFrom(i: any): Who {
  const u = i.member?.user ?? i.user ?? {};
  return { id: String(u.id ?? ""), names: [u.username, u.global_name, i.member?.nick].filter(Boolean) };
}

export type Deps = { run?: typeof runQuestion; edit?: typeof editOriginal };

/** Handle one signed request from Discord. */
export async function handleInteraction(req: Request, publicKey: string, deps: Deps = {}): Promise<Response> {
  const run = deps.run ?? runQuestion;
  const edit = deps.edit ?? editOriginal;
  const body = await req.text();
  const ok = verifyDiscord(publicKey, req.headers.get("x-signature-ed25519") ?? "", req.headers.get("x-signature-timestamp") ?? "", body);
  if (!ok) return new Response("invalid request signature", { status: 401 });

  // deno-lint-ignore no-explicit-any
  let i: any;
  try { i = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }

  if (i.type === 1) return json({ type: 1 }); // PING

  const appId = String(i.application_id ?? "");
  const token = String(i.token ?? "");

  if (i.type === 2 && i.data?.name === "franny") {
    // deno-lint-ignore no-explicit-any
    const question = String(i.data?.options?.find((o: any) => o.name === "question")?.value ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
    if (!question) return json({ type: 4, data: { content: "Ask a question after /franny.", flags: 64 } });
    const who = whoFrom(i);
    background((async () => {
      let msg: Msg;
      try { msg = await run(question, who, false); }
      catch (e) { console.error(e); msg = noticeMessage(question, "Something went wrong. Ask again in a moment."); }
      await edit(appId, token, msg);
    })());
    return json({ type: 5 }); // "Franny is thinking…"
  }

  if (i.type === 3 && typeof i.data?.custom_id === "string" && i.data.custom_id.startsWith("deep:")) {
    const id = Number(i.data.custom_id.slice(5));
    const who = whoFrom(i);
    background((async () => {
      let msg: Msg;
      try {
        const q = await loggedQuestion(id);
        msg = q ? await run(q.question, who, true, q.asker) : noticeMessage("Think harder", "Franny couldn't find that question anymore. Ask it again with /franny.");
      } catch (e) { console.error(e); msg = noticeMessage("Think harder", "Something went wrong. Ask again in a moment."); }
      await edit(appId, token, msg);
    })());
    return json({ type: 5 }); // new message: "Franny is thinking…"
  }

  return json({ type: 4, data: { content: "Franny doesn't know that command.", flags: 64 } });
}
