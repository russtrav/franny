import { guardSql } from "../supabase/functions/_shared/league-qa/guard.ts";
const cases: [string, boolean][] = [
  ["select manager_name, count(*) from v_teams where playoff_finish = 1 group by manager_name", true],
  ["with g as (select 1 as x) select * from g;", true],
  ["select * from head_to_head where manager = 'Tom' and opponent ilike 'dave'", true],
  ["select 'insert; drop' as label from teams", true],
  ["select * from managers where name = 'O''Brien'", true],
  ["select round(points_for, 2) as \"Points For\" from matchups limit 5", true],
  ["select name from managers offset 2", true],
  ["select * from public.teams", true],
  ["select * from baseball.teams", false],
  ["select * from \"net\".\"_http_response\"", false],
  ["select * from net._http_response", false],
  ["select net.http_get('http://x')", false],
  ["select pg_sleep(10)", false],
  ["select * from pg_roles", false],
  ["select set_config('role','postgres',true)", false],
  ["select query_to_xml('select * from x', true, true, '')", false],
  ["with x as (update managers set name = name returning 1) select * from x", false],
  ["select * into newtbl from teams", false],
  ["select 1; select 2", false],
  ["delete from teams", false],
  ["select E'\\'' ; drop table x", false],
  ["select $$a$$", false],
  ["select * from U&\"\\006Eet\"._http_response", false],
  ["select * from league_qa.questions", false],
  ["select * from information_schema.tables", false],
  ["select * from motherboard.anything", false],
  ["select * from somenew.schema_tbl", true], // caught only by runtime schema list
];
let bad = 0;
for (const [sql, expect] of cases) {
  const r = guardSql(sql, ["somenew_not"]);
  if (r.ok !== expect) { bad++; console.log("MISMATCH", expect ? "should pass" : "should block", "|", sql, "|", r.ok ? "" : r.reason); }
}
const dyn = guardSql("select * from somenew.schema_tbl", ["somenew"]);
console.log("runtime schema list blocks unknown schema:", !dyn.ok);
console.log(bad === 0 ? `all ${cases.length} guard cases behave as expected` : `${bad} mismatches`);
