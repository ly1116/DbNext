/**
 * 类型短名归一化：把 PG/驱动返回的冗长编目名转成常用写法，仅用于展示与 DDL 生成
 * （varchar(n) / timestamptz 等均为合法 DDL 写法，不影响 ALTER / 建表）。
 * - character varying(20) → varchar(20)；character(n) → char(n)
 * - timestamp without time zone → timestamp；timestamp with time zone → timestamptz
 * - time without time zone → time；time with time zone → timetz；bit varying → varbit
 * - integer(32) / bigint(64) 这类整型的展示宽度后缀无 DDL 意义，直接去掉括号
 */
export function shortTypeName(t?: string): string {
  const s = (t ?? '').trim();
  if (!s) return s;
  let out = s.replace(/^(smallint|integer|int|bigint|tinyint)\s*\(\s*\d+\s*\)$/i, '$1');
  out = out
    .replace(/^character\s+varying(\s*\(\s*\d+\s*\))?$/i, (_m, p: string) => `varchar${p ?? ''}`)
    .replace(/^character(\s*\(\s*\d+\s*\))?$/i, (_m, p: string) => `char${p ?? ''}`)
    .replace(/^timestamp(\s*\(\s*\d+\s*\))?\s+without\s+time\s+zone$/i, (_m, p: string) => `timestamp${p ?? ''}`)
    .replace(/^timestamp(\s*\(\s*\d+\s*\))?\s+with\s+time\s+zone$/i, (_m, p: string) => `timestamptz${p ?? ''}`)
    .replace(/^time(\s*\(\s*\d+\s*\))?\s+without\s+time\s+zone$/i, (_m, p: string) => `time${p ?? ''}`)
    .replace(/^time(\s*\(\s*\d+\s*\))?\s+with\s+time\s+zone$/i, (_m, p: string) => `timetz${p ?? ''}`)
    .replace(/^bit\s+varying(\s*\(\s*\d+\s*\))?$/i, (_m, p: string) => `varbit${p ?? ''}`);
  return out;
}
