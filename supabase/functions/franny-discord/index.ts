// franny-discord: Franny in the league's Discord server.
// Discord's "Interactions Endpoint URL" points here. Signed Discord requests go to the interaction
// handler. Unsigned POSTs are admin actions protected by the league passcode:
//   ?admin=register  { passcode }                          -> (re)register the /franny command
//   ?admin=preview   { passcode, question, as?, deep? }    -> run a question and return the Discord message JSON
//   ?admin=members   { passcode }                          -> list the Discord name -> manager map
import { handleInteraction, registerCommands, runQuestion } from "../_shared/league-qa/discord.ts";
import { discordMembers, managerForDiscord } from "../_shared/league-qa/db.ts";

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Franny is listening.", { status: 200 });

  if (req.headers.has("x-signature-ed25519")) {
    const publicKey = Deno.env.get("DISCORD_PUBLIC_KEY") ?? "";
    if (!publicKey) return new Response("DISCORD_PUBLIC_KEY is not set", { status: 503 });
    return handleInteraction(req, publicKey);
  }

  const admin = new URL(req.url).searchParams.get("admin");
  if (!admin) return new Response("invalid request signature", { status: 401 });
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = JSON.parse(await req.text()); } catch { /* empty */ }
  const expected = Deno.env.get("LEAGUE_PASSCODE") ?? "";
  if (!expected || typeof body.passcode !== "string" || !sameSecret(body.passcode, expected)) {
    await new Promise((r) => setTimeout(r, 400));
    return json({ ok: false, error: "bad passcode" }, 401);
  }

  try {
    if (admin === "register") {
      const appId = Deno.env.get("DISCORD_APPLICATION_ID") ?? "";
      const bot = Deno.env.get("DISCORD_BOT_TOKEN") ?? "";
      if (!appId || !bot) return json({ ok: false, error: "Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN first." }, 400);
      const r = await registerCommands(appId, bot);
      return json({ ok: r.status < 300, status: r.status, result: r.body });
    }
    if (admin === "preview") {
      const question = String(body.question ?? "").trim();
      if (!question) return json({ ok: false, error: "question is required" }, 400);
      // `as` is a Discord username to pretend to be; looked up without saving anything.
      const as = typeof body.as === "string" ? body.as : null;
      const asker = as ? await managerForDiscord("", [as], false) : null;
      const msg = await runQuestion(question, { id: "", names: [] }, body.deep === true, asker);
      return json({ ok: true, message: msg });
    }
    if (admin === "members") return json({ ok: true, members: await discordMembers() });
    return json({ ok: false, error: "unknown admin action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});
