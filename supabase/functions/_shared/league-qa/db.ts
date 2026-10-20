// Database access. Two connections with very different powers:
//  - reader: logs in as league_reader (SELECT on football tables only). The ONLY
//    connection that ever runs model-written SQL, always in a READ ONLY transaction.
//  - bookkeeper: the project's own connection, used only for fixed, parameterized
//    statements against the private league_qa schema (daily cap + question log).
import postgres from "npm:postgres@3.4.5";
import type { Manager } from "./prompt.ts";

export const MAX_ROWS = 200;
const MAX_CELL_CHARS = 300;

type Sql = ReturnType<typeof postgres>;
let reader: Sql | null = null;
let bookkeeper: Sql | null = null;

function baseUrl(): URL {
  const raw = Deno.env.get("SUPABASE_DB_URL");
  if (!raw) throw new ConfigError("SUPABASE_DB_URL is missing.");
  return new URL(raw);
}

export class ConfigError extends Error {}

/** league_reader's connection string, built from the project's own host and port. */
function readerUrl(): string {
  const password = Deno.env.get("LEAGUE_READER_PASSWORD");
  if (!password) throw new ConfigError("LEAGUE_READER_PASSWORD is not set.");
  const url = baseUrl();
  // Pooler connections use "<role>.<project-ref>" as the user name; direct ones use "<role>".
  const user = decodeURIComponent(url.username);
  url.username = user.includes(".") ? `league_reader.${user.split(".").slice(1).join(".")}` : "league_reader";
  url.password = encodeURIComponent(password);
  return url.toString();
}

function getReader(): Sql {
  reader ??= postgres(readerUrl(), {
    prepare: false,
    max: 1, // each function instance holds at most one league_reader connection
    idle_timeout: 15,
    connect_timeout: 10,
    connection: { application_name: "league-ask" },
  });
  return reader;
}

/** Retry briefly when a burst of questions hits league_reader's connection limit. */
async function withReader<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(getReader());
    } catch (e) {
      // deno-lint-ignore no-explicit-any
      const code = (e as any)?.code;
      const busy = code === "53300" || code === "CONNECTION_CLOSED" || code === "CONNECT_TIMEOUT";
      if (!busy || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 600 * (attempt + 1)));
    }
  }
}

/** Where the database connection points (no secrets), for the health check. */
export function connectionKind(): Record<string, unknown> {
  const url = baseUrl();
  return { host_kind: url.hostname.includes("pooler") ? "pooler" : "direct", port: url.port || "5432" };
}

function getBookkeeper(): Sql {
  bookkeeper ??= postgres(baseUrl().toString(), { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 });
  return bookkeeper;
}

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
};

export class BusyError extends Error {}

export class QueryError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

function cleanValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Uint8Array) return "[binary]";
  try {
    const s = JSON.stringify(v);
    return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + "…" : v;
  } catch {
    return String(v);
  }
}

/** Run one guarded SELECT as league_reader, read-only, 5 s timeout, row cap. */
export async function runReadOnly(sql: string): Promise<QueryResult> {
  const wrapped = `select * from (\n${sql}\n) as answer limit ${MAX_ROWS + 1}`;
  try {
    const result = await withReader((r) => r.begin("read only", async (tx) => {
      await tx.unsafe("set local statement_timeout = '5s'");
      return await tx.unsafe(wrapped, []);
    }));
    // deno-lint-ignore no-explicit-any
    const res = result as any;
    const columns: string[] = (res.columns ?? []).map((c: { name: string }) => c.name);
    const all = Array.from(res as Record<string, unknown>[]);
    const truncated = all.length > MAX_ROWS;
    const rows = all.slice(0, MAX_ROWS).map((r) => {
      const o: Record<string, unknown> = {};
      for (const k of columns.length ? columns : Object.keys(r)) o[k] = cleanValue(r[k]);
      return o;
    });
    return { columns: columns.length ? columns : rows[0] ? Object.keys(rows[0]) : [], rows, rowCount: rows.length, truncated };
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    const err = e as any;
    if (err instanceof ConfigError) throw err;
    if (err?.code === "53300") throw new BusyError("Too many questions at once; the read-only login is at its connection limit.");
    if (err?.code === "57014") throw new QueryError("The query took longer than 5 seconds and was stopped.", err.code);
    if (err?.code === "28P01" || err?.code === "28000") {
      throw new ConfigError("The read-only database login was refused (check LEAGUE_READER_PASSWORD).");
    }
    if (err?.code) throw new QueryError(String(err.message ?? err).slice(0, 400), err.code);
    throw new QueryError("The database didn't answer: " + String(err?.message ?? err).slice(0, 200));
  }
}

/** The manager list, read through the read-only login. Cached for 10 minutes. */
let managersCache: { at: number; list: Manager[] } | null = null;
export async function getManagers(): Promise<Manager[]> {
  if (managersCache && Date.now() - managersCache.at < 600_000) return managersCache.list;
  const rows = await withReader((r) => r.begin("read only", (tx) =>
    tx`select name, joined_year, retired_year, active from managers order by active desc, name`
  ));
  const list = Array.from(rows as unknown as Manager[]).map((m) => ({
    name: m.name, joined_year: m.joined_year, retired_year: m.retired_year, active: m.active,
  }));
  managersCache = { at: Date.now(), list };
  return list;
}

export type Champion = { year: number; manager: string; team_name: string | null };

/** Each season's champion, for the page's trophy plaque. Cached for 10 minutes. */
let championsCache: { at: number; list: Champion[] } | null = null;
export async function getChampions(): Promise<Champion[]> {
  if (championsCache && Date.now() - championsCache.at < 600_000) return championsCache.list;
  const rows = await withReader((r) => r.begin("read only", (tx) =>
    tx`select season_year as year, manager_name as manager, team_name
       from v_teams where playoff_finish = 1 order by season_year`
  ));
  const list = Array.from(rows as unknown as Champion[]).map((c) => ({
    year: Number(c.year), manager: c.manager, team_name: c.team_name,
  }));
  championsCache = { at: Date.now(), list };
  return list;
}

/** Every non-public schema name, so the guard can refuse references to any of them. */
let schemaCache: string[] | null = null;
export async function getOtherSchemas(): Promise<string[]> {
  if (schemaCache) return schemaCache;
  const rows = await withReader((r) => r.begin("read only", (tx) =>
    tx`select nspname from pg_namespace where nspname <> 'public'`
  ));
  schemaCache = Array.from(rows as unknown as { nspname: string }[]).map((r) => r.nspname);
  return schemaCache;
}

/** What the read-only login actually is, for the health check. */
export async function readerIdentity(): Promise<Record<string, unknown>> {
  const [row] = await withReader((r) => r.begin("read only", (tx) =>
    tx`select current_user as role, current_setting('transaction_read_only') as read_only,
              current_setting('statement_timeout') as role_statement_timeout,
              current_setting('default_transaction_read_only') as role_default_read_only`
  ));
  return row as Record<string, unknown>;
}

/** Take units from today's league-wide budget. Returns units used after taking, or null if over the cap. */
export async function takeUnits(cost: number, cap: number): Promise<number | null> {
  const rows = await getBookkeeper()`select league_qa.take_units(${cost}::int, ${cap}::int) as used`;
  const used = rows[0]?.used;
  return used === null || used === undefined ? null : Number(used);
}

export async function unitsUsedToday(): Promise<number> {
  const rows = await getBookkeeper()`
    select coalesce((select units from league_qa.daily_usage
      where day = (now() at time zone 'America/New_York')::date), 0) as used`;
  return Number(rows[0]?.used ?? 0);
}

export type LogEntry = {
  client: string;
  asker: string | null;
  question: string;
  deep: boolean;
  model: string | null;
  sql: string | null;
  reading: string | null;
  row_count: number | null;
  answer: string | null;
  error_code: string | null;
  error_detail: string | null;
  queries_run: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
  ms: number;
};

/** Log one question. Returns the log row id (used by Discord's Think harder button), or null if logging failed. */
export async function logQuestion(e: LogEntry): Promise<number | null> {
  try {
    const rows = await getBookkeeper()`insert into league_qa.questions
      (client, asker, question, deep, model, sql, reading, row_count, answer, error_code, error_detail,
       queries_run, input_tokens, output_tokens, est_cost_usd, ms)
      values (${e.client}, ${e.asker}, ${e.question.slice(0, 500)}, ${e.deep}, ${e.model}, ${e.sql},
              ${e.reading}, ${e.row_count}, ${e.answer}, ${e.error_code}, ${e.error_detail?.slice(0, 1000) ?? null},
              ${e.queries_run}, ${e.input_tokens}, ${e.output_tokens}, ${e.est_cost_usd}, ${e.ms})
      returning id`;
    return rows[0]?.id != null ? Number(rows[0].id) : null;
  } catch (err) {
    console.error("log failed", err);
    return null;
  }
}

/** A logged question, for re-asking it (Discord's Think harder button). */
export async function loggedQuestion(id: number): Promise<{ question: string; asker: string | null } | null> {
  const rows = await getBookkeeper()`select question, asker from league_qa.questions where id = ${id}`;
  return rows[0] ? { question: String(rows[0].question), asker: rows[0].asker ?? null } : null;
}

/**
 * Which manager a Discord account belongs to. Russ lists each manager's Discord username in
 * league_qa.discord_members; the first time someone on the list uses Franny, their Discord user id
 * is saved too, so a later username change doesn't break the match.
 */
export async function managerForDiscord(userId: string, names: string[], save = true): Promise<string | null> {
  const handles = [...new Set(names.filter(Boolean).map((n) => n.trim().toLowerCase().replace(/^@/, "")))];
  const sql = getBookkeeper();
  // Names travel as one string split in SQL (unit-separator delimited); Discord names can't contain it.
  const joined = handles.join("\u001f");
  const rows = await sql`
    select handle, manager_name, discord_user_id from league_qa.discord_members
    where discord_user_id = ${userId} or handle = any(string_to_array(${joined}::text, chr(31)))
    order by (discord_user_id = ${userId}) desc nulls last
    limit 1`;
  const row = rows[0];
  if (!row) return null;
  if (save && userId && !row.discord_user_id) {
    await sql`update league_qa.discord_members set discord_user_id = ${userId}
              where handle = ${row.handle} and discord_user_id is null`;
  }
  return String(row.manager_name);
}

export async function discordMembers(): Promise<Record<string, unknown>[]> {
  const rows = await getBookkeeper()`
    select handle, manager_name, discord_user_id is not null as seen from league_qa.discord_members order by manager_name`;
  return Array.from(rows as unknown as Record<string, unknown>[]);
}
