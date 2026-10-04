import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

/**
 * SQL 自定义补全源（覆盖 lang-sql 原生补全）。
 *
 * 原生补全只在「表.」后提示列，`WHERE id` 等场景没有字段提示；也不解析
 * `FROM t AS a` / `JOIN b ON ...` 的别名。这里通过解析光标前的 FROM/JOIN
 * 子句建立 表 ↔ 别名 映射：
 * - `别名.` / `表.` / `schema.表.` → 该表的字段；
 * - `schema.`            → 该 schema 下的全部表（PG 常用限定名补全）；
 * - 普通单词            → 当前作用域所有表的字段 + 表名 + 函数 + 关键字。
 *
 * 方言感知：postgres / mysql 各自补充专属关键字与函数（如 PG 的 RETURNING /
 * ILIKE / `::` 转换 / DATE_TRUNC / STRING_AGG，MySQL 的 GROUP_CONCAT / IFNULL）。
 *
 * @since 0.5.0
 */

type Dialect = 'postgres' | 'mysql' | undefined;

/** 通用 SQL 关键字（补全候选；列/表优先级更高，关键字 boost 最低） */
const BASE_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'OUTER', 'CROSS JOIN', 'ON', 'USING',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'AS', 'DISTINCT',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DESC', 'ASC',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'DEFAULT', 'COMMENT', 'COMMIT', 'ROLLBACK', 'TRUNCATE',
];

/** 各方言专属关键字（按需追加，避免与通用重复） */
const DIALECT_KEYWORDS: Record<Exclude<Dialect, undefined>, string[]> = {
  postgres: [
    'RETURNING', 'ILIKE', 'SIMILAR TO', 'WITH', 'RECURSIVE', 'LATERAL',
    'DISTINCT ON', 'FILTER', 'OVER', 'PARTITION BY', 'WINDOW',
    'NULLS FIRST', 'NULLS LAST', 'ON CONFLICT', 'DO NOTHING', 'EXCLUDE',
    'SERIAL', 'BIGSERIAL', 'JSONB', 'JSON', 'UUID', 'BOOLEAN', 'TIMESTAMPTZ', 'TEXT', 'ARRAY',
    'ANALYZE', 'VACUUM', 'EXPLAIN', 'CAST', 'USING INDEX',
  ],
  mysql: [
    'SHOW', 'DESCRIBE', 'REPLACE INTO', 'IGNORE', 'STRAIGHT_JOIN', 'SQL_CALC_FOUND_ROWS',
    'ENGINE', 'CHARSET', 'AUTO_INCREMENT', 'UNSIGNED', 'ZEROFILL', 'INDEX', 'UNIQUE',
    'TINYINT', 'INT', 'BIGINT', 'VARCHAR', 'TEXT', 'DATETIME', 'TIMESTAMP',
  ],
};

/** 通用 SQL 函数（带签名 detail 作为「参数提示」；detail 在补全列表右侧显示） */
const BASE_FUNCTIONS: Array<[string, string]> = [
  ['COUNT', 'COUNT(expr)'],
  ['SUM', 'SUM(expr)'],
  ['AVG', 'AVG(expr)'],
  ['MIN', 'MIN(expr)'],
  ['MAX', 'MAX(expr)'],
  ['COALESCE', 'COALESCE(a, b, ...)'],
  ['CONCAT', 'CONCAT(a, b, ...)'],
  ['NULLIF', 'NULLIF(a, b)'],
  ['NOW', 'NOW()'],
  ['CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP'],
  ['CURRENT_DATE', 'CURRENT_DATE'],
  ['DATE', 'DATE(expr)'],
  ['LOWER', 'LOWER(str)'],
  ['UPPER', 'UPPER(str)'],
  ['LENGTH', 'LENGTH(str)'],
  ['SUBSTRING', 'SUBSTRING(str, start, len)'],
  ['REPLACE', 'REPLACE(str, from, to)'],
  ['ROUND', 'ROUND(num, decimals)'],
  ['ABS', 'ABS(num)'],
  ['CAST', 'CAST(expr AS type)'],
  ['GREATEST', 'GREATEST(a, b, ...)'],
  ['LEAST', 'LEAST(a, b, ...)'],
];

/** 各方言专属函数 */
const DIALECT_FUNCTIONS: Record<Exclude<Dialect, undefined>, Array<[string, string]>> = {
  postgres: [
    ['DATE_TRUNC', 'DATE_TRUNC(field, source)'],
    ['STRING_AGG', 'STRING_AGG(expr, sep)'],
    ['ARRAY_AGG', 'ARRAY_AGG(expr)'],
    ['JSONB_AGG', 'JSONB_AGG(expr)'],
    ['TO_CHAR', 'TO_CHAR(value, format)'],
    ['TO_DATE', 'TO_DATE(str, format)'],
    ['TO_TIMESTAMP', 'TO_TIMESTAMP(str, format)'],
    ['EXTRACT', 'EXTRACT(field FROM source)'],
    ['AGE', 'AGE(d1, d2)'],
    ['GENERATE_SERIES', 'GENERATE_SERIES(start, stop, step)'],
    ['ROW_NUMBER', 'ROW_NUMBER() OVER (...)'],
    ['RANK', 'RANK() OVER (...)'],
    ['DENSE_RANK', 'DENSE_RANK() OVER (...)'],
    ['LAG', 'LAG(expr, offset) OVER (...)'],
    ['LEAD', 'LEAD(expr, offset) OVER (...)'],
  ],
  mysql: [
    ['GROUP_CONCAT', 'GROUP_CONCAT(expr SEPARATOR sep)'],
    ['IFNULL', 'IFNULL(expr, alt)'],
    ['IF', 'IF(cond, a, b)'],
    ['DATE_FORMAT', 'DATE_FORMAT(date, format)'],
    ['IFNULL', 'IFNULL(expr, alt)'],
    ['FIND_IN_SET', 'FIND_IN_SET(str, strlist)'],
    ['JSON_EXTRACT', 'JSON_EXTRACT(json, path)'],
  ],
};

/** 这些词出现在「表名后」的位置时不是别名（而是子句引导词） */
const NON_ALIAS = new Set(
  ('where,on,left,right,inner,outer,cross,full,natural,join,group,order,limit,having,union,set,as,using,' +
    'select,from,and,or,comma,offset,when,then,else,end,asc,desc,insert,update,delete,values,returning,into').split(','),
);

/** 去掉标识符包裹符 */
function unquote(s: string): string {
  return s.replace(/[`"[\]]/g, '');
}

/** 解析光标前文本中的 FROM/JOIN 表与别名 */
function parseTables(before: string): { aliasMap: Record<string, string>; tables: string[] } {
  const aliasMap: Record<string, string> = {};
  const tables: string[] = [];
  const re = /\b(?:from|join|,)\s+([`"\[]?[\w$]+(?:\.[\w$]+)*[`"\]]?)(?:\s+(?:as\s+)?[`"\[]?([\w$]+)[`"\]]?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(before))) {
    const table = unquote(m[1]);
    if (!table) continue;
    tables.push(table);
    const alias = m[2] ? unquote(m[2]) : '';
    if (alias && !NON_ALIAS.has(alias.toLowerCase())) aliasMap[alias.toLowerCase()] = table;
  }
  return { aliasMap, tables };
}

/** 预处理 schema：拆出 裸表名→列、schema.表→列、schema→表集合 */
function indexSchema(schema: Record<string, string[]>) {
  const tableCols: Record<string, string[]> = {}; // 裸表名（小写）→ 列
  const fqCols: Record<string, string[]> = {}; // schema.table（小写）→ 列
  const schemaTables: Record<string, Set<string>> = {}; // schema（小写）→ 表集合（裸名）
  for (const [key, cols] of Object.entries(schema)) {
    if (key.includes('.')) {
      const [s, t] = key.split('.');
      const sl = s.toLowerCase();
      const tl = t.toLowerCase();
      fqCols[key.toLowerCase()] = cols;
      (schemaTables[sl] ??= new Set()).add(tl);
      // 裸名仅在尚无裸键时补一份（避免 public.users / users 重复列集）
      if (!tableCols[tl]) tableCols[tl] = cols;
    } else {
      tableCols[key.toLowerCase()] = cols;
    }
  }
  return { tableCols, fqCols, schemaTables };
}

/** 由表名（可含 schema 前缀）在 schema 映射中查字段：精确键 → 「.表名」后缀键 → 别名解析后的表 */
function colsOfTable(table: string, idx: ReturnType<typeof indexSchema>): string[] {
  const t = table.toLowerCase();
  if (idx.tableCols[t]) return idx.tableCols[t];
  if (idx.fqCols[t]) return idx.fqCols[t];
  const key = Object.keys(idx.fqCols).find((k) => k === t || k.endsWith(`.${t}`));
  return key ? idx.fqCols[key] : [];
}

/** 去重保序 */
function dedup(list: string[]): string[] {
  return [...new Set(list)];
}

/** 构造补全源（schema / dialect 热更新时重建即可） */
export function makeSqlComplete(schema: Record<string, string[]>, dialect?: Dialect) {
  const idx = indexSchema(schema);
  const keywords = dedup([
    ...BASE_KEYWORDS,
    ...(dialect ? DIALECT_KEYWORDS[dialect] : []),
  ]).map((k) => ({ label: k, type: 'keyword', boost: -99 }));
  // 按 label 去重（BASE 与方言可能同名，避免重复候选）
  const funcMap = new Map<string, string>();
  for (const [label, detail] of BASE_FUNCTIONS) if (!funcMap.has(label)) funcMap.set(label, detail);
  if (dialect) for (const [label, detail] of DIALECT_FUNCTIONS[dialect]) if (!funcMap.has(label)) funcMap.set(label, detail);
  const functions = [...funcMap.entries()].map(([label, detail]) => ({ label, detail, type: 'function', boost: -50 }));

  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(0, ctx.pos);
    // 光标前的当前 token：标识符（可带点号限定）
    const token = before.match(/[\w$]+(?:\.[\w$]+)*\.?$/)?.[0] ?? '';
    const { aliasMap, tables } = parseTables(before);

    // 「x.」形式：x 为别名 / 表名 / schema / schema.table
    if (token.endsWith('.')) {
      const head = unquote(token.slice(0, -1)).toLowerCase();
      // schema.table. → 该表字段
      if (head.includes('.')) {
        const cols = colsOfTable(head, idx);
        return cols.length
          ? { from: ctx.pos, options: cols.map((c) => ({ label: c, type: 'property', boost: 10 })), validFor: /^[\w$]*$/ }
          : null;
      }
      // schema. → 列出该 schema 下的表
      if (idx.schemaTables[head]) {
        const opts = [...idx.schemaTables[head]].map((t) => ({ label: t, type: 'type', boost: 5 }));
        return { from: ctx.pos, options: opts, validFor: /^[\w$]*$/ };
      }
      // 表名 / 别名 → 该表字段
      const tgt = aliasMap[head] ?? head;
      const cols = colsOfTable(tgt, idx);
      return cols.length
        ? { from: ctx.pos, options: cols.map((c) => ({ label: c, type: 'property', boost: 10 })), validFor: /^[\w$]*$/ }
        : null;
    }

    // 普通单词（或空 token——Ctrl+Space / 显式触发时给完整候选）
    const word = unquote(token);
    const scopedTables = dedup([...tables, ...Object.values(aliasMap)]);
    const cols = dedup(scopedTables.flatMap((t) => colsOfTable(t, idx)));
    const tableNames = dedup([
      ...Object.keys(idx.tableCols),
      ...Object.keys(idx.schemaTables),
      ...scopedTables.map((t) => t.split('.').pop() as string),
    ]).filter(Boolean);

    return {
      from: token ? ctx.pos - word.length : ctx.pos,
      options: [
        ...cols.map((c) => ({ label: c, type: 'property', boost: 10 })),
        ...functions,
        ...tableNames.map((t) => ({ label: t, type: 'type', boost: 0 })),
        ...keywords,
      ],
      validFor: /^[\w$]*$/,
    };
  };
}
