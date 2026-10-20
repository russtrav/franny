// Plays Discord: signs requests with a test key and checks the handler's replies.
// Run: deno test -A tests/discord_test.ts
import nacl from "npm:tweetnacl@1.0.3";
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`expected ${y}\n     got ${x}`);
}
import { answerMessage, formatTable, handleInteraction, verifyDiscord } from "../supabase/functions/_shared/league-qa/discord.ts";

const keys = nacl.sign.keyPair();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const PUB = hex(keys.publicKey);

function signed(body: unknown, opts: { badSig?: boolean } = {}): Request {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = nacl.sign.detached(new TextEncoder().encode(ts + raw), keys.secretKey);
  if (opts.badSig) sig[0] ^= 0xff;
  return new Request("https://x/franny-discord", {
    method: "POST", body: raw,
    headers: { "x-signature-ed25519": hex(sig), "x-signature-timestamp": ts, "content-type": "application/json" },
  });
}

Deno.test("bad signature is refused with 401 (Discord checks this when the URL is saved)", async () => {
  const res = await handleInteraction(signed({ type: 1 }, { badSig: true }), PUB);
  assertEquals(res.status, 401);
});

Deno.test("PING gets PONG", async () => {
  const res = await handleInteraction(signed({ type: 1 }), PUB);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { type: 1 });
});

Deno.test("/franny defers right away and edits the reply with the answer", async () => {
  const seen: { q?: string; who?: unknown; deep?: boolean; edit?: unknown } = {};
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const res = await handleInteraction(signed({
    type: 2, application_id: "app1", token: "tok1",
    data: { name: "franny", options: [{ name: "question", value: "  longest   win streak " }] },
    member: { user: { id: "u1", username: "tomb", global_name: "Tom B" }, nick: "Tommy" },
  }), PUB, {
    run: (q, who, deep) => { seen.q = q; seen.who = who; seen.deep = deep; return Promise.resolve({ content: "answer" }); },
    edit: (appId, token, msg) => { seen.edit = { appId, token, msg }; done(); return Promise.resolve(); },
  });
  assertEquals(await res.json(), { type: 5 });
  await finished;
  assertEquals(seen.q, "longest win streak");
  assertEquals(seen.deep, false);
  assertEquals(seen.who, { id: "u1", names: ["tomb", "Tom B", "Tommy"] });
  assertEquals(seen.edit, { appId: "app1", token: "tok1", msg: { content: "answer" } });
});

Deno.test("signature check rejects junk keys", () => {
  assert(!verifyDiscord("zz", "00", "1", "{}"));
  assert(!verifyDiscord(PUB, "", "1", "{}"));
});

Deno.test("table fits a phone: narrow, at most 10 rows, numbers right-aligned", () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({
    manager: ["Tom", "Tony", "Evan"][i % 3], streak: String(11 - (i % 5)), start_season: 2015 + i, start_week: i + 1,
    end_season: 2016 + i, end_week: 17 - i, team_id: "abc",
  }));
  const t = formatTable(["manager", "streak", "start_season", "start_week", "end_season", "end_week", "team_id"], rows);
  const lines = t.split("\n");
  assertEquals(lines.length, 12); // header + 10 rows + "more" line
  assert(lines.slice(0, 11).every((l) => l.length <= 44), "every line fits 44 characters");
  assert(!t.includes("Team id"), "id columns are dropped");
  assert(t.endsWith("+3 more rows on the web page"));
  assert(lines[1].includes("  11"), "numbers are right-aligned");
});

Deno.test("answer message carries the Think harder button with the log id", () => {
  // deno-lint-ignore no-explicit-any
  const r: any = { ok: true, answer: "Tom, 11 straight.", reading: "regular season", columns: ["manager"], rows: [{ manager: "Tom" }],
    row_count: 1, truncated: false, sql: "select 1", deep: false, model: "m", queries_run: 1, usage: {} };
  const msg = answerMessage("Longest streak", r, 99, 42);
  assertEquals(msg.components![0].components[0].custom_id, "deep:42");
  assert(msg.embeds![0].description.includes("```"));
  assert(msg.embeds![0].footer.text.includes("99 of 100 questions left today"));
});
