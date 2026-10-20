// Read-only query guard. This is a backstop: the real wall is the league_reader
// database role (SELECT on football tables only) inside a READ ONLY transaction.

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const MAX_SQL_CHARS = 8000;

// Schemas that are never allowed as a prefix. Extended at runtime with every
// non-public schema the database reports (see extraDenied).
const DENIED_SCHEMAS = [
  "net", "extensions", "auth", "storage", "vault", "baseball", "motherboard", "graphql",
  "graphql_public", "realtime", "supabase_migrations", "supabase_functions", "pgbouncer",
  "cron", "information_schema", "league_qa", "pgsodium", "pgsodium_masks",
];

const DENIED_WORDS =
  /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|vacuum|call|do|execute|prepare|deallocate|listen|unlisten|notify|lock|reindex|cluster|comment|set|reset|refresh|import|security|discard|checkpoint|load|into)\b/i;

const DENIED_FUNCTIONS =
  /\b(pg_\w+|lo_\w+|dblink\w*|set_config|current_setting|query_to_xml\w*|table_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|cursor_to_xml\w*|ts_stat|http\w*|txid_\w+)\b/i;

export function guardSql(input: unknown, extraDenied: string[] = []): GuardResult {
  if (typeof input !== "string" || !input.trim()) return { ok: false, reason: "No query was written." };
  if (input.length > MAX_SQL_CHARS) return { ok: false, reason: "The query is too long." };

  let s = input.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  s = s.replace(/;+\s*$/, "").trim();

  if (!/^(select|with)\b/i.test(s)) return { ok: false, reason: "The query must start with SELECT or WITH." };
  if (/\$[A-Za-z0-9_]*\$/.test(s)) return { ok: false, reason: "Dollar-quoted strings aren't allowed." };
  if (/(^|[^A-Za-z0-9_'])[eE]'/.test(s)) return { ok: false, reason: "Escape strings (E'...') aren't allowed." };
  if (/[uU]&['"]/.test(s)) return { ok: false, reason: "Unicode-escaped names aren't allowed." };

  // Blank out string literals, then unwrap quoted identifiers so "net"."x" reads as net.x.
  const noStrings = s.replace(/'(?:[^']|'')*'/g, "''");
  if (noStrings.includes(";")) return { ok: false, reason: "Only one statement is allowed; remove the semicolon." };
  if (/'/.test(noStrings.replace(/''/g, ""))) return { ok: false, reason: "A string in the query isn't closed." };
  const bare = noStrings.replace(/"((?:[^"]|"")*)"/g, (_m, id: string) => id.replace(/""/g, '"'));

  const word = bare.match(DENIED_WORDS);
  if (word) return { ok: false, reason: `Only reading the league tables is allowed (found "${word[0]}").` };
  const fn = bare.match(DENIED_FUNCTIONS);
  if (fn) return { ok: false, reason: `That function isn't allowed here ("${fn[0]}").` };

  const schemas = [...new Set([...DENIED_SCHEMAS, ...extraDenied.map((x) => x.toLowerCase())])]
    .filter((x) => x && x !== "public" && /^[a-z_][a-z0-9_]*$/.test(x));
  const schemaRef = new RegExp(`\\b(${schemas.join("|")})\\s*\\.`, "i");
  const ref = bare.match(schemaRef);
  if (ref) return { ok: false, reason: `Only the league's football tables can be used (found "${ref[1]}.").` };

  return { ok: true, sql: s };
}
