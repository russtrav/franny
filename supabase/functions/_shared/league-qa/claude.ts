// Minimal Claude Messages API client with usage/cost tracking and friendly errors.

export const FAST_MODEL = () => Deno.env.get("LEAGUE_FAST_MODEL") ?? "claude-haiku-5-5";
export const DEEP_MODEL = () => Deno.env.get("LEAGUE_DEEP_MODEL") ?? "claude-sonnet-5-5";

// USD per million tokens: input, output, 5-minute cache write, cache read.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.10, 0.50, 0.125, 0.01],
  "claude-sonnet-5-5": [2, 10, 2.5, 0.10],
  "claude-opus-5-5": [4, 20, 5, 0.20],
};

export class Usage {
  input = 0;
  output = 0;
  cost = 0;
  calls = 0;
  add(model: string, u: Record<string, number> | undefined) {
    if (!u) return;
    const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
    const fresh = u.input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0;
    const out = u.output_tokens ?? 0;
    this.input += fresh + write + read;
    this.output += out;
    this.cost += (fresh * p[0] + out * p[1] + write * p[2] + read * p[3]) / 1e6;
    this.calls++;
  }
}

export class ClaudeError extends Error {
  constructor(message: string, public code: "budget" | "busy" | "config" | "refused" | "failed") {
    super(message);
  }
}

// deno-lint-ignore no-explicit-any
export type Message = { role: "user" | "assistant"; content: any };
// deno-lint-ignore no-explicit-any
export type Tool = { name: string; description: string; input_schema: any };

export type CallOptions = {
  model: string;
  system: string;
  messages: Message[];
  maxTokens: number;
  tools?: Tool[];
  toolChoice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  // Haiku 5.5 / Sonnet 5.5 think adaptively by default and thinking counts toward maxTokens.
  // Haiku accepts { type: "disabled" }; Sonnet 5.5 rejects that and rejects forced tool use.
  thinking?: { type: "disabled" } | { type: "adaptive" } | { type: "between_tools" };
  effort?: "low" | "medium" | "high";
  usage: Usage;
  timeoutMs?: number;
};

// deno-lint-ignore no-explicit-any
export async function callClaude(o: CallOptions): Promise<any> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new ClaudeError("ANTHROPIC_API_KEY is not set.", "config");
  // deno-lint-ignore no-explicit-any
  const body: any = {
    model: o.model,
    max_tokens: o.maxTokens,
    system: [{ type: "text", text: o.system, cache_control: { type: "ephemeral" } }],
    messages: o.messages,
  };
  if (o.tools) body.tools = o.tools;
  if (o.toolChoice) body.tool_choice = o.toolChoice;
  if (o.thinking) body.thinking = o.thinking;
  if (o.effort) body.output_config = { effort: o.effort };

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 45_000),
      });
    } catch (e) {
      if (attempt === 0) continue;
      throw new ClaudeError("Claude didn't respond in time: " + String((e as Error)?.message ?? e), "busy");
    }
    if (res.ok) {
      const data = await res.json();
      o.usage.add(o.model, data.usage);
      if (data.stop_reason === "refusal") throw new ClaudeError("Claude declined to answer that.", "refused");
      return data;
    }
    const text = await res.text();
    let err: { type?: string; message?: string; details?: { error_code?: string } } = {};
    try { err = JSON.parse(text).error ?? {}; } catch { /* not JSON */ }
    const msg = err.message ?? text.slice(0, 300);
    if (res.status === 429 && err.details?.error_code === "enforced_spend_limit_reached") {
      throw new ClaudeError("Monthly API spend cap reached.", "budget");
    }
    if (res.status === 400 && /specified (workspace )?API usage limits/i.test(msg)) {
      throw new ClaudeError("Spend limit reached.", "budget");
    }
    if (res.status === 400 && /credit balance/i.test(msg)) throw new ClaudeError("API credits are used up.", "budget");
    if (res.status === 401 || res.status === 403) throw new ClaudeError("The API key was rejected: " + msg, "config");
    if (res.status === 404 && /model/i.test(msg)) throw new ClaudeError("Model not available: " + msg, "config");
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt === 0) {
      const wait = Math.min(Number(res.headers.get("retry-after") ?? 2), 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new ClaudeError(`Claude API error ${res.status}: ${msg}`, res.status === 429 || res.status === 529 ? "busy" : "failed");
  }
  throw new ClaudeError("Claude didn't respond.", "busy");
}

// deno-lint-ignore no-explicit-any
export function textOf(data: any): string {
  return (data?.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
}
