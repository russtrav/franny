// The question-answering core. Surface-agnostic: the web endpoint and the Discord bot
// both call answerQuestion() and render the result their own way.
import { agentSystem, answerSystem, askerLine, type Manager, sqlSystem } from "./prompt.ts";
import { guardSql } from "./guard.ts";
import { BusyError, ConfigError, getOtherSchemas, QueryError, type QueryResult, runReadOnly } from "./db.ts";
import { callClaude, ClaudeError, DEEP_MODEL, FAST_MODEL, type Message, textOf, Usage } from "./claude.ts";

export type AskInput = {
  question: string;
  asker: string | null; // canonical manager name, or null if unknown
  deep: boolean; // "Think harder"
  managers: Manager[];
};

export type AskSuccess = {
  ok: true;
  answer: string;
  reading: string;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  sql: string;
  deep: boolean;
  model: string;
  queries_run: number;
};

export type AskFailure = {
  ok: false;
  code: "needs_asker" | "no_query" | "budget" | "busy" | "config" | "refused" | "failed";
  message: string;
  detail?: string;
  sql?: string;
  deep: boolean;
  model: string;
  queries_run: number;
};

export type AskResult = (AskSuccess | AskFailure) & { usage: Usage };

// Only questions that actually say I/me/my can need the asker.
const FIRST_PERSON = /\b(i|me|my|mine|myself|i'm|i've|i'd|im|ive)\b/i;

const FAST_ATTEMPTS = 3;
const AGENT_MAX_QUERIES = 5;
const AGENT_DEADLINE_MS = 75_000;

export async function answerQuestion(input: AskInput): Promise<AskResult> {
  const usage = new Usage();
  const model = input.deep ? DEEP_MODEL() : FAST_MODEL();
  try {
    const r = input.deep ? await deepPath(input, usage, model) : await fastPath(input, usage, model);
    return { ...r, usage };
  } catch (e) {
    return { ...failureFrom(e, input.deep, model), usage };
  }
}

function failureFrom(e: unknown, deep: boolean, model: string): AskFailure {
  const base = { ok: false as const, deep, model, queries_run: 0 };
  if (e instanceof ClaudeError) {
    const msg: Record<ClaudeError["code"], string> = {
      budget: "The league's question budget for this month is used up. Russ can top it up.",
      busy: "Claude is busy right now. Give it a moment and ask again.",
      config: "The question tool isn't fully set up yet.",
      refused: "Claude wouldn't answer that one. Try asking it a different way.",
      failed: "Something went wrong while writing the answer. Ask again in a moment.",
    };
    return { ...base, code: e.code, message: msg[e.code], detail: e.message };
  }
  if (e instanceof BusyError) {
    return { ...base, code: "busy", message: "Lots of questions at once right now. Give it a few seconds and ask again.", detail: e.message };
  }
  if (e instanceof ConfigError) {
    return { ...base, code: "config", message: "The question tool isn't fully set up yet.", detail: e.message };
  }
  return { ...base, code: "failed", message: "Something went wrong. Ask again in a moment.", detail: String((e as Error)?.message ?? e) };
}

function userTurn(input: AskInput): string {
  return `${askerLine(input.asker)}\nQuestion: ${input.question}`;
}

export function rowsForModel(r: QueryResult, limit: number): string {
  let json = JSON.stringify(r.rows.slice(0, limit));
  if (json.length > 12_000) json = json.slice(0, 12_000) + " …";
  const note = r.rowCount > limit ? `, first ${limit} shown` : "";
  return `(${r.rowCount}${r.truncated ? "+" : ""} rows${note}) ${json}`;
}

export async function runGuarded(sql: unknown, denied: string[]): Promise<{ sql: string; result: QueryResult }> {
  const g = guardSql(sql, denied);
  if (!g.ok) throw new QueryError(g.reason, "guard");
  return { sql: g.sql, result: await runReadOnly(g.sql) };
}

// ---------- fast path: Haiku writes one query (up to 3 tries), then a short answer ----------

const SUBMIT_TOOL = {
  name: "submit_query",
  description: "Submit the single read-only SELECT that answers the question.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "One SELECT (a WITH clause is fine). No semicolons or comments." },
      reading: { type: "string", description: "One plain sentence saying how you read the question, including any limits of the data." },
      needs_asker: { type: "boolean", description: "True only when the question literally says I, me, my or mine and the asker is unknown. Leave sql empty then. Questions about named managers or the whole league never need the asker." },
    },
    required: ["sql", "reading"],
  },
};

async function fastPath(input: AskInput, usage: Usage, model: string): Promise<AskSuccess | AskFailure> {
  const denied = await getOtherSchemas();
  const system = sqlSystem(input.managers);
  const messages: Message[] = [{ role: "user", content: userTurn(input) }];
  let lastSql = "", lastError = "", queries = 0;

  for (let attempt = 1; attempt <= FAST_ATTEMPTS; attempt++) {
    const data = await callClaude({
      model, system, messages, maxTokens: 1200, usage,
      tools: [SUBMIT_TOOL], toolChoice: { type: "tool", name: "submit_query" },
    });
    // deno-lint-ignore no-explicit-any
    const call = (data.content ?? []).find((b: any) => b.type === "tool_use");
    if (!call) throw new ClaudeError("No query came back.", "failed");
    const { sql, reading, needs_asker } = call.input ?? {};
    if (needs_asker && !input.asker && FIRST_PERSON.test(input.question)) {
      return {
        ok: false, code: "needs_asker", deep: false, model, queries_run: queries,
        message: "That question is about you. Pick who you are first, then ask again.",
      };
    }
    lastSql = typeof sql === "string" ? sql : "";
    try {
      queries++;
      const { sql: safe, result } = await runGuarded(sql, denied);
      const answer = await writeAnswer(input, typeof reading === "string" ? reading : "", result, usage);
      return {
        ok: true, answer, reading: typeof reading === "string" ? reading : "",
        columns: result.columns, rows: result.rows, row_count: result.rowCount, truncated: result.truncated,
        sql: safe, deep: false, model, queries_run: queries,
      };
    } catch (e) {
      if (!(e instanceof QueryError)) throw e;
      lastError = e.message;
      const wronglyAskedForAsker = needs_asker && !String(sql ?? "").trim();
      messages.push({ role: "assistant", content: data.content });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result", tool_use_id: call.id, is_error: true,
          content: wronglyAskedForAsker
            ? "This question doesn't depend on who is asking. Set needs_asker to false and write the query."
            : `That query failed: ${e.message}\nWrite a corrected query.`,
        }],
      });
    }
  }
  return {
    ok: false, code: "no_query", deep: false, model, queries_run: queries, sql: lastSql, detail: lastError,
    message: "That question didn't turn into a working query. Try rewording it, or tap Think harder.",
  };
}

async function writeAnswer(input: AskInput, reading: string, result: QueryResult, usage: Usage): Promise<string> {
  const data = await callClaude({
    // Light private thinking (effort low) keeps self-corrections out of the visible answer.
    // Thinking counts toward maxTokens, so leave room for it.
    model: FAST_MODEL(), system: answerSystem(input.asker), maxTokens: 1500, usage, effort: "low",
    messages: [{
      role: "user",
      content: `Question: ${input.question}\nHow the question was read: ${reading || "as asked"}\nRows ${rowsForModel(result, 40)}`,
    }],
  });
  return textOf(data) || "The record book came back, but no answer was written. Check the table below.";
}

// ---------- "Think harder": a small agent that may run several queries ----------

const RUN_TOOL = {
  name: "run_query",
  description: "Run one read-only SELECT against the league database and see the rows (first 30).",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "One SELECT (a WITH clause is fine). No semicolons or comments." },
      purpose: { type: "string", description: "A few words on what this query checks." },
    },
    required: ["sql"],
  },
};

const FINAL_TOOL = {
  name: "final_answer",
  description: "Give the final answer once you're confident.",
  input_schema: {
    type: "object",
    properties: {
      answer: { type: "string", description: "One to three plain sentences. Lead with the answer: who, the number, when. No mention of SQL, queries or tables." },
      reading: { type: "string", description: "One plain sentence on how you read the question, including any limits of the data." },
      table_query: { type: "integer", description: "Which successful run_query call (1 = first) best supports the answer; its rows are shown under the answer." },
      needs_asker: { type: "boolean", description: "True only when the question is about the asker and the asker is unknown." },
    },
    required: ["answer", "reading", "table_query"],
  },
};

async function deepPath(input: AskInput, usage: Usage, model: string): Promise<AskSuccess | AskFailure> {
  const denied = await getOtherSchemas();
  const system = agentSystem(input.managers, AGENT_MAX_QUERIES) +
    "\n" + (input.asker ? `In final_answer, call ${input.asker} "you" when they're the subject.` : "In final_answer, use names.");
  const messages: Message[] = [{ role: "user", content: userTurn(input) }];
  const successes: { sql: string; result: QueryResult }[] = [];
  const started = Date.now();
  let queries = 0, nudged = false;

  // Sonnet 5.5 rejects forced tool use, so tool_choice stays "auto" and the loop steers with
  // tool results and a one-time nudge instead. Thinking stays adaptive (it can't be turned off).
  for (let turn = 0; turn < AGENT_MAX_QUERIES + 3; turn++) {
    const outOfTime = Date.now() - started > AGENT_DEADLINE_MS;
    const data = await callClaude({
      model, system, messages, maxTokens: 8000, usage, effort: "medium",
      tools: [RUN_TOOL, FINAL_TOOL],
    });
    messages.push({ role: "assistant", content: data.content });
    // deno-lint-ignore no-explicit-any
    const calls = (data.content ?? []).filter((b: any) => b.type === "tool_use");
    // deno-lint-ignore no-explicit-any
    const final = calls.find((c: any) => c.name === "final_answer");
    if (!calls.length) {
      // A plain-text reply: nudge once toward final_answer, then accept the text.
      const text = textOf(data);
      if (!nudged && !outOfTime) {
        nudged = true;
        messages.push({
          role: "user",
          content: successes.length
            ? "Please call final_answer now with your answer."
            : "Please answer by running a query with run_query first.",
        });
        continue;
      }
      const last = successes[successes.length - 1];
      if (!last || !text) break;
      return {
        ok: true, answer: text, reading: "", columns: last.result.columns, rows: last.result.rows,
        row_count: last.result.rowCount, truncated: last.result.truncated, sql: last.sql,
        deep: true, model, queries_run: queries,
      };
    }
    if (final) {
      const f = final.input ?? {};
      if (f.needs_asker && !input.asker && FIRST_PERSON.test(input.question)) {
        return {
          ok: false, code: "needs_asker", deep: true, model, queries_run: queries,
          message: "That question is about you. Pick who you are first, then ask again.",
        };
      }
      const pick = successes[Math.min(Math.max(Number(f.table_query) || successes.length, 1), successes.length) - 1];
      if (!pick) {
        return {
          ok: false, code: "no_query", deep: true, model, queries_run: queries,
          message: "Even thinking harder, that question didn't turn into a working query. Try rewording it.",
        };
      }
      return {
        ok: true, answer: String(f.answer ?? "").trim(), reading: String(f.reading ?? ""),
        columns: pick.result.columns, rows: pick.result.rows, row_count: pick.result.rowCount,
        truncated: pick.result.truncated, sql: pick.sql, deep: true, model, queries_run: queries,
      };
    }
    // deno-lint-ignore no-explicit-any
    const results: any[] = [];
    for (const c of calls) {
      if (c.name !== "run_query" || queries >= AGENT_MAX_QUERIES) {
        results.push({ type: "tool_result", tool_use_id: c.id, is_error: true, content: "No more queries. Call final_answer." });
        continue;
      }
      queries++;
      try {
        const ran = await runGuarded(c.input?.sql, denied);
        successes.push(ran);
        results.push({
          type: "tool_result", tool_use_id: c.id,
          content: `Query ${successes.length} ok ${rowsForModel(ran.result, 30)}`,
        });
      } catch (e) {
        if (!(e instanceof QueryError)) throw e;
        results.push({ type: "tool_result", tool_use_id: c.id, is_error: true, content: `Query failed: ${e.message}` });
      }
    }
    if (!results.length) throw new ClaudeError("The agent stopped without answering.", "failed");
    if (queries >= AGENT_MAX_QUERIES || outOfTime) {
      results.push({ type: "text", text: "That was your last query. Call final_answer now." });
    }
    messages.push({ role: "user", content: results });
  }
  return {
    ok: false, code: "no_query", deep: true, model, queries_run: queries,
    message: "Even thinking harder, that question didn't come together. Try rewording it.",
  };
}
