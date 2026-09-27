import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

/**
 * SQL 自定义补全源（覆盖 lang-sql 原生补全）。
 *
 * 原生补全只在「表.」后提示列，`WHERE id` 等场景没有字段提示；也不解析
 * `FROM t AS a` / `JOIN b ON ...` 的别名。这里通过解析光标前的 FROM/JOIN
 * 子句建立 表 ↔ 别名 映射：
 * - `别名.` / `表.` / `schema.表.` → 该表的字段；
 * - 普通单词 → 当前作用域所有表的字段 + 表名 + SQL 关键字。
 *
 * @since 0.5.0
 */

/** 常用 SQL 关键字（补全候选；列/表优先级更高） */
const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
  'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'OUTER', 'CROSS JOIN', 'ON', 'USING',
  'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL', 'AS', 'DISTINCT',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DESC', 'ASC',
  'PRIMARY KEY', 'FOREIGN KEY', 'REFERENCES', 'DEFAULT', 'COMMENT', 'COMMIT', 'ROLLBACK', 'TRUNCATE',
].map((k) => ({ label: k, type: 'keyword', boost: -99 }));

/** 这些词出现在「表名后」的位置时不是别名（而是子句引导词） */
const NON_ALIAS = new Set(
  ('where,on,left,right,inner,outer,cross,full,natural,join,group,order,limit,having,union,set,as,using,' +
    'select,from,and,or,comma,offset,when,then,else,end,asc,desc,insert,update,delete,values,returning').split(','),
);

/** 去掉标识符包裹符 */
function unquote(s: string): string {
  return s.replace(/[`"[\]]/g, '');
}

/** 解析光标前文本中的 FROM/JOIN 表与别名 */
function parseTables(before: string): { aliasMap: Record<string, string>; tables: string[] } {
  const aliasMap: Record<string, string> = {};
  const tables: string[] = [];
  const re = /\b(?:from|join)\s+([`"\[]?[\w$]+(?:\.[\w$]+)*[`"\]]?)(?:\s+(?:as\s+)?[`"\[]?([\w$]+)[`"\]]?)?/gi;
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

/** 由表名（可含 schema 前缀）在 schema 映射中查字段：精确键 → 「.表名」后缀键 */
function colsOfTable(table: string, schema: Record<string, string[]>): string[] {
  const t = table.toLowerCase();
  if (schema[t]) return schema[t];
  const key = Object.keys(schema).find((k) => k === t || k.endsWith(`.${t}`));
  return key ? schema[key] : [];
}

/** 去重保序 */
function dedup(list: string[]): string[] {
  return [...new Set(list)];
}

/** 构造补全源（schema 热更新时重建即可） */
export function makeSqlComplete(schema: Record<string, string[]>) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.state.sliceDoc(0, ctx.pos);
    // 光标前的当前 token：标识符（可带点号限定）
    const token = before.match(/[\w$]+(?:\.[\w$]+)*\.?$/)?.[0] ?? '';
    if (!token) return null;

    const { aliasMap, tables } = parseTables(before);

    // 「x.」形式：x 为别名 / 表名 / schema.table → 提示该表字段
    if (token.endsWith('.')) {
      const head = unquote(token.slice(0, -1)).toLowerCase();
      // 可能是 schema.table 的最后一段，也可能就是别名/表名
      const table = aliasMap[head] ?? head;
      const cols = dedup([
        ...colsOfTable(table, schema),
        ...(table.includes('.') ? colsOfTable(table.split('.').pop() as string, schema) : []),
      ]);
      if (!cols.length) return null;
      return {
        from: ctx.pos,
        options: cols.map((c) => ({ label: c, type: 'property', boost: 10 })),
        validFor: /^[\w$]*$/,
      };
    }

    // 普通单词：作用域内所有表字段 + 表名 + 关键字
    const word = unquote(token);
    const scopedTables = dedup([...tables, ...Object.values(aliasMap)]);
    const cols = dedup(scopedTables.flatMap((t) => colsOfTable(t, schema)));
    const tableNames = dedup([
      ...Object.keys(schema).map((k) => k.split('.').pop() as string),
      ...scopedTables.map((t) => t.split('.').pop() as string),
    ]).filter(Boolean);

    return {
      from: ctx.pos - word.length,
      options: [
        ...cols.map((c) => ({ label: c, type: 'property', boost: 10 })),
        ...tableNames.map((t) => ({ label: t, type: 'type', boost: 0 })),
        ...SQL_KEYWORDS,
      ],
      validFor: /^[\w$]*$/,
    };
  };
}
