import oracledb from 'oracledb';
import type { DataTransferMode, DataTransferProgress, DataTransferSpec, DbColumn, DbForeignKey, DbIndex } from '@shared/types';
import { getMysql, getPg, getOracle, getMysqlPool, getPgPool } from '../clients/manager';
import { getConnection } from '../services/connection-store';
import { listColumns, listIndexes, listForeignKeys } from './sql.service';

/**
 * 数据传输服务（真实实现）。
 *
 * 把源库（mysql / postgres / oracle）的若干张表传输到另一个库（任意方言组合）：
 * - 结构：源 information_schema / 系统视图内省列定义，按方言做类型映射后 CREATE TABLE
 *   （含主键 / 非空 / 可安全映射的默认值 / 列注释 / 表注释 / 自增-标识列）；
 *   索引在数据拷完后补建（避免拖慢插入），外键在全部表建完后统一补建（保证被引用表已存在）；
 * - 数据：按主键无关的 LIMIT/OFFSET（Oracle 用 ROWNUM）分页读取，分批参数化 INSERT 写入目标，
 *   BIGINT/CLOB/BLOB/JSON/日期等值做跨方言归一化；
 * - 进度：每张表先 COUNT 估总数，逐批推送 {@link DataTransferProgress}（当前表/行数/日志行）；
 * - 取消：渲染端可随时 cancel，读写在批间安全中止。
 *
 * 单表失败不中断整批任务，错误记入进度日志并继续下一张表。
 *
 * @since 0.1.0
 */

type Dialect = 'mysql' | 'pg' | 'oracle';

/** 已取消的任务集合（cancel 后批间检查即中止） */
const cancelled = new Set<string>();

/** 渲染端请求取消某次传输 */
export function cancelDataTransfer(taskId: string): void {
  cancelled.add(taskId);
}

/** 判定连接的方言（要求已建立真实连接） */
function dialectOf(connectionId: string, role: string): Dialect {
  if (getMysql(connectionId)) return 'mysql';
  if (getPg(connectionId)) return 'pg';
  if (getOracle(connectionId)) return 'oracle';
  throw new Error(`${role}连接不可用或不是数据库类型（mysql/postgres/oracle）`);
}

/** 标识符转义（按目标方言） */
function qi(d: Dialect, name: string): string {
  if (d === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 表限定名：mysql 用库前缀；pg/oracle 用模式前缀 */
function qt(d: Dialect, schema: string | undefined, table: string): string {
  const t = qi(d, table);
  const s = (schema || '').trim();
  return s ? `${qi(d, s)}.${t}` : t;
}

// ———————————————————————————— 类型映射 ————————————————————————————

/** 解析 fullType：base 类型名 + 可选 (精度) 或 (精度,刻度) */
function parseType(fullType: string | undefined, dataType: string): { base: string; p: number | null; s: number | null } {
  const raw = (fullType || dataType || '').toLowerCase().replace(/\s+unsigned$/, '').trim();
  const m = raw.match(/^([a-z_ ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\))?$/);
  if (!m) return { base: (dataType || 'text').toLowerCase(), p: null, s: null };
  return { base: m[1].trim(), p: m[2] ? Number(m[2]) : null, s: m[3] ? Number(m[3]) : null };
}

/** 跨方言列类型映射（尽量保真，无法等价时取最接近的承载类型） */
function mapType(src: Dialect, tgt: Dialect, col: DbColumn): string {
  const { base, p, s } = parseType(col.fullType, col.dataType);
  const withP = (t: string) => (p != null && s != null ? `${t}(${p},${s})` : p != null ? `${t}(${p})` : t);
  // 源 fullType 里显式携带的时间精度：timestamp(3) → 取 3（parseType 解析不了 "timestamp(3) without time zone" 这类带后缀的）
  const tsFsp = (col.fullType || '').match(/timestamp\s*\(\s*(\d)\s*\)/i)?.[1] ?? null;

  // —— 同方言（MySQL→MySQL / PG→PG / Oracle→Oracle）：原样保留类型定义 ——
  if (src === tgt) {
    const raw = (col.fullType || col.dataType || '').trim();
    if (raw) {
      if (tgt === 'oracle') return raw.toUpperCase();
      if (tgt === 'pg' && /^array$/i.test(raw)) return 'text'; // PG 数组列 information_schema 只报 ARRAY，透传会建表失败，降级 text（数据按 JSON 字符串写入）
      return raw.toLowerCase();
    }
  }

  // —— 源：MySQL ——
  if (src === 'mysql') {
    if (tgt === 'pg') {
      if (base === 'tinyint') return p === 1 ? 'boolean' : 'smallint';
      if (base === 'smallint' || base === 'year') return 'smallint';
      if (base === 'mediumint' || base === 'int' || base === 'integer') return 'integer';
      if (base === 'bigint') return 'bigint';
      if (base === 'float') return 'real';
      if (base === 'double') return 'double precision';
      if (base === 'decimal' || base === 'numeric') return withP('numeric');
      if (base === 'varchar' || base === 'char') return withP(base);
      if (base.includes('text')) return 'text';
      if (base.includes('blob') || base.includes('binary')) return 'bytea';
      if (base === 'json') return 'jsonb';
      if (base === 'date') return 'date';
      if (base === 'datetime' || base === 'timestamp') return 'timestamp';
      if (base === 'time') return 'time';
      return 'text';
    }
    // mysql -> oracle
    if (base === 'tinyint') return p === 1 ? 'NUMBER(1)' : 'NUMBER(3)';
    if (base === 'smallint') return 'NUMBER(5)';
    if (base === 'mediumint') return 'NUMBER(7)';
    if (base === 'int' || base === 'integer') return 'NUMBER(10)';
    if (base === 'bigint') return 'NUMBER(19)';
    if (base === 'float') return 'BINARY_FLOAT';
    if (base === 'double') return 'BINARY_DOUBLE';
    if (base === 'decimal' || base === 'numeric') return withP('NUMBER');
    if (base === 'varchar') return p != null && p <= 4000 ? `VARCHAR2(${p})` : 'CLOB';
    if (base === 'char') return withP('CHAR');
    if (base.includes('text')) return 'CLOB';
    if (base.includes('blob') || base.includes('binary')) return 'BLOB';
    if (base === 'json' || base === 'enum' || base === 'set') return 'CLOB';
    if (base === 'date') return 'DATE';
    if (base === 'datetime') return p != null && p > 0 ? `TIMESTAMP(${Math.min(p, 9)})` : 'DATE'; // 带小数秒精度才用 TIMESTAMP，避免丢微秒
    if (base === 'timestamp') return 'TIMESTAMP';
    if (base === 'time') return 'VARCHAR2(16)';
    if (base === 'year') return 'NUMBER(4)';
    return 'CLOB';
  }

  // —— 源：PostgreSQL ——
  if (src === 'pg') {
    const intish = base === 'smallint' || base === 'int2';
    const integerish = base === 'integer' || base === 'int4';
    const bigintish = base === 'bigint' || base === 'int8';
    if (tgt === 'mysql') {
      if (intish) return 'smallint';
      if (integerish) return 'int';
      if (bigintish) return 'bigint';
      if (base === 'real' || base === 'float4') return 'float';
      if (base === 'double precision' || base === 'float8') return 'double';
      if (base === 'numeric' || base === 'decimal') return withP('decimal');
      if (base === 'boolean' || base === 'bool') return 'tinyint(1)';
      if (base === 'bytea') return 'longblob';
      if (base === 'json' || base === 'jsonb') return 'json';
      if (base === 'date') return 'date';
      if (base.startsWith('timestamp')) return tsFsp ? `datetime(${tsFsp})` : 'datetime(6)'; // 保留源精度：PG 裸 timestamp 本身就是微秒(6)
      if (base === 'time' || base === 'timetz') return 'time';
      if (base === 'uuid') return 'varchar(36)';
      if (base === 'varchar' || base === 'character varying' || base === 'bpchar' || base === 'char' || base === 'character') return withP(base === 'bpchar' || base === 'char' || base === 'character' ? 'char' : 'varchar');
      if (base === 'money') return 'decimal(19,2)';
      if (base === 'inet' || base === 'cidr' || base === 'macaddr') return 'varchar(64)';
      return 'longtext';
    }
    // pg -> oracle
    if (intish) return 'NUMBER(5)';
    if (integerish) return 'NUMBER(10)';
    if (bigintish) return 'NUMBER(19)';
    if (base === 'real' || base === 'float4') return 'BINARY_FLOAT';
    if (base === 'double precision' || base === 'float8') return 'BINARY_DOUBLE';
    if (base === 'numeric' || base === 'decimal') return withP('NUMBER');
    if (base === 'boolean' || base === 'bool') return 'NUMBER(1)';
    if (base === 'bytea') return 'BLOB';
    if (base === 'json' || base === 'jsonb') return 'CLOB';
    if (base === 'date') return 'DATE';
    if (base.startsWith('timestamp')) return tsFsp ? `TIMESTAMP(${tsFsp})` : 'TIMESTAMP';
    if (base === 'time' || base === 'timetz') return 'VARCHAR2(16)';
    if (base === 'uuid') return 'VARCHAR2(36)';
    if (base === 'varchar' || base === 'character varying' || base === 'bpchar' || base === 'char' || base === 'character') return withP('VARCHAR2');
    if (base === 'money') return 'NUMBER(19,2)';
    return 'CLOB';
  }

  // —— 源：Oracle ——
  if (tgt === 'mysql') {
    if (base === 'number') {
      if (p == null) return 'decimal(38,10)';
      if (s != null && s > 0) return `decimal(${Math.min(p, 65)},${Math.min(s, 30)})`;
      if (p <= 9) return 'int';
      if (p <= 18) return 'bigint';
      return `decimal(${Math.min(p, 65)},0)`;
    }
    if (base === 'float') return 'double';
    if (base === 'binary_float') return 'float';
    if (base === 'binary_double') return 'double';
    if (base === 'varchar2' || base === 'nvarchar2') return p != null ? `varchar(${Math.min(p, 16383)})` : 'varchar(255)';
    if (base === 'char' || base === 'nchar') return withP('char');
    if (base === 'clob' || base === 'nclob' || base === 'long') return 'longtext';
    if (base === 'blob' || base === 'raw' || base === 'long raw') return 'longblob';
    if (base === 'date') return 'datetime';
    if (base.startsWith('timestamp')) return tsFsp ? `datetime(${tsFsp})` : 'datetime(6)';
    return 'longtext';
  }
  // oracle -> pg
  if (base === 'number') {
    if (p == null) return 'numeric';
    if (s != null && s > 0) return `numeric(${p},${s})`;
    if (p <= 4) return 'smallint';
    if (p <= 9) return 'integer';
    if (p <= 18) return 'bigint';
    return `numeric(${p},0)`;
  }
  if (base === 'float') return 'double precision';
  if (base === 'binary_float') return 'real';
  if (base === 'binary_double') return 'double precision';
  if (base === 'varchar2' || base === 'nvarchar2') return p != null ? `varchar(${p})` : 'varchar(255)';
  if (base === 'char' || base === 'nchar') return withP('char');
  if (base === 'clob' || base === 'nclob' || base === 'long') return 'text';
  if (base === 'blob' || base === 'raw' || base === 'long raw') return 'bytea';
  if (base === 'date') return 'timestamp(0)';
  if (base.startsWith('timestamp')) return tsFsp ? `timestamp(${tsFsp})` : 'timestamp';
  return 'text';
}

/** 目标类型的大类（默认值是否合法按类判断） */
function typeClassOf(mapped: string): 'datetime' | 'date' | 'time' | 'numeric' | 'str' | 'lob' {
  const t = mapped.toLowerCase().trim();
  if (t.startsWith('datetime') || t.startsWith('timestamp')) return 'datetime';
  if (t === 'date') return 'date';
  if (t === 'time' || t.startsWith('time(')) return 'time';
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|float|real|double|decimal|numeric|number|boolean|bool)/.test(t)) return 'numeric';
  if (/^(char|varchar|character|varchar2|nvarchar|nchar|uuid)/.test(t)) return 'str';
  return 'lob'; // text/clob/blob/bytea/json/longtext/longblob 等：MySQL 与 Oracle 均不允许 DEFAULT，直接不给
}

/** datetime/timestamp 类型的小数秒精度（datetime=0、datetime(6)=6；其他类型返回 null）。MySQL 要求 DEFAULT 的 fsp 与列完全一致 */
function typeFsp(mapped: string): number | null {
  const t = mapped.toLowerCase().trim();
  const m = t.match(/^(?:datetime|timestamp)\s*\(\s*(\d)\s*\)$/);
  if (m) return Number(m[1]);
  if (/^(?:datetime|timestamp)$/.test(t)) return 0;
  return null;
}

/**
 * 可安全跨方言映射的默认值（按目标方言 + 目标类型校验，不合法则返回 null 跳过）。
 * 关键规则：
 * - 时间函数族（now()/current_timestamp/localtimestamp/sysdate/systimestamp）归一化为目标方言写法；
 *   MySQL 下 CURRENT_TIMESTAMP 的 fsp 必须与列定义一致（如 datetime(6) 必须 DEFAULT CURRENT_TIMESTAMP(6)，
 *   否则报 1067 Invalid default value —— PG 裸 timestamp(6)→datetime(6) 正踩这个坑）；
 * - 布尔字面量 true/false/'t'/'f' → 1/0（仅数值类目标）；PG cast 字面量 'x'::type 取引号内部分；
 * - text/blob/json 目标不给默认值；MySQL 的 DATE/TIME 列不允许时间函数默认值（裸 CURRENT_DATE/CURRENT_TIMESTAMP 非法）。
 */
function safeDefault(d: string | undefined, tgt: Dialect, mappedType: string): string | null {
  let s = (d ?? '').trim();
  if (!s || /^null$/i.test(s)) return null;

  // PG cast 字面量：'x'::type → 'x'；内层本身是数字的（'-1'::int）还原为裸数字；数组/复杂表达式带 cast 一律跳过
  const lit = s.match(/^('((?:[^']|'')*)')::[a-z_ ]+$/i);
  if (lit) {
    const inner = lit[2].replace(/''/g, "'");
    s = /^-?\d+(\.\d+)?$/.test(inner) ? inner : `'${lit[2]}'`;
  }

  const cls = typeClassOf(mappedType);
  const numLit = /^-?\d+(\.\d+)?$/.test(s);
  const strLit = /^'(?:[^']|'')*'$/i.test(s);

  // 布尔语义 → 数字（仅数值类目标；避免把 varchar 的字面 'true' 误转）
  if (cls === 'numeric') {
    const bare = /^'((?:[^']|'')*)'$/.test(s) ? s.slice(1, -1) : s;
    if (/^(true|t|yes|on)$/i.test(bare)) s = '1';
    else if (/^(false|f|no|off)$/i.test(bare)) s = '0';
  }

  const isNow = /^(now\(\)|current_timestamp(\s*\(\s*\d\s*\))?|localtimestamp(\s*\(\s*\d\s*\))?|systimestamp|getdate\(\))$/i.test(s);
  const isCurDate = /^(current_date|curdate\(\))$/i.test(s);
  const isCurTime = /^current_time(\s*\(\s*\d\s*\))?$/i.test(s);

  if (cls === 'datetime') {
    if (isNow) {
      if (tgt === 'oracle') return 'SYSTIMESTAMP';
      if (tgt === 'pg') return 'CURRENT_TIMESTAMP';
      const fsp = typeFsp(mappedType); // mysql：fsp 必须与列一致
      return fsp && fsp > 0 ? `CURRENT_TIMESTAMP(${fsp})` : 'CURRENT_TIMESTAMP';
    }
    return strLit ? s : null;
  }
  if (cls === 'date') {
    if (isNow || isCurDate) {
      if (tgt === 'oracle') return 'SYSDATE';
      if (tgt === 'pg') return 'CURRENT_DATE';
      return null; // mysql 的 DATE 不允许裸 CURRENT_TIMESTAMP / CURRENT_DATE 默认值
    }
    return strLit ? s : null;
  }
  if (cls === 'time') {
    if (isNow || isCurTime) return tgt === 'pg' ? 'CURRENT_TIME' : null; // mysql 的 TIME 无函数默认值
    return strLit ? s : null;
  }
  if (cls === 'numeric') return numLit ? s : null;
  if (cls === 'str') return strLit || numLit ? s : null;
  return null; // lob：不给默认值最稳
}

/** 源列是否自增/标识列 */
function isAutoInc(col: DbColumn): boolean {
  return !!col.extra && (col.extra.includes('auto_increment') || col.extra.includes('identity'));
}

// ———————————————————————————— 源侧读取 ————————————————————————————

/** 源表行数估算 */
async function srcCount(d: Dialect, connId: string, schema: string | undefined, db: string | undefined, table: string): Promise<number | null> {
  try {
    if (d === 'mysql') {
      const pool = await getMysqlPool(connId, db);
      const [rows] = (await pool.query(`SELECT COUNT(*) AS c FROM ${qt('mysql', schema, table)}`)) as [Record<string, unknown>[], unknown[]];
      return Number(rows[0]?.c ?? 0);
    }
    if (d === 'pg') {
      const pool = await getPgPool(connId, db);
      const r = await pool.query(`SELECT COUNT(*)::bigint AS c FROM ${qt('pg', schema, table)}`);
      return Number(r.rows[0]?.c ?? 0);
    }
    const pool = getOracle(connId)!;
    const conn = await pool.getConnection();
    try {
      const r = await conn.execute(`SELECT COUNT(*) AS C FROM ${qt('oracle', schema, table)}`, [], { autoCommit: false });
      return Number((r.rows?.[0] as Record<string, unknown> | undefined)?.C ?? 0);
    } finally {
      await conn.close();
    }
  } catch {
    return null; // count 失败不阻断，进度条退化为按表数推进
  }
}

/** 分页读源表数据（每页 limit 行，offset 起始） */
async function srcReadPage(d: Dialect, connId: string, schema: string | undefined, db: string | undefined, table: string, offset: number, limit: number): Promise<Record<string, unknown>[]> {
  if (d === 'mysql') {
    const pool = await getMysqlPool(connId, db);
    const [rows] = (await pool.query(`SELECT * FROM ${qt('mysql', schema, table)} LIMIT ${limit} OFFSET ${offset}`)) as [Record<string, unknown>[], unknown[]];
    return rows;
  }
  if (d === 'pg') {
    const pool = await getPgPool(connId, db);
    const r = await pool.query(`SELECT * FROM ${qt('pg', schema, table)} LIMIT ${limit} OFFSET ${offset}`);
    return r.rows as Record<string, unknown>[];
  }
  const pool = getOracle(connId)!;
  const conn = await pool.getConnection();
  try {
    const sql = `SELECT * FROM (SELECT sub.*, ROWNUM AS __RN__ FROM ${qt('oracle', schema, table)} sub WHERE ROWNUM <= ${offset + limit}) WHERE __RN__ > ${offset}`;
    const r = await conn.execute(sql, [], { autoCommit: false, fetchArraySize: 500 });
    return (r.rows ?? []).map((row) => {
      const c = { ...(row as Record<string, unknown>) };
      for (const k of Object.keys(c)) if (k.toUpperCase() === '__RN__') delete c[k];
      return c;
    });
  } finally {
    await conn.close();
  }
}

/** Oracle 主键列（源侧 PK 内省；mysql/pg 由 listColumns 的 key 字段给出） */
async function oraPkCols(connId: string, schema: string, table: string): Promise<string[]> {
  try {
    const pool = getOracle(connId)!;
    const conn = await pool.getConnection();
    try {
      const r = await conn.execute(
        `SELECT cc.COLUMN_NAME FROM ALL_CONSTRAINTS con
         JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = con.OWNER AND cc.CONSTRAINT_NAME = con.CONSTRAINT_NAME
         WHERE con.CONSTRAINT_TYPE = 'P' AND con.OWNER = :o AND con.TABLE_NAME = :t
         ORDER BY cc.POSITION`,
        [schema.toUpperCase(), table.toUpperCase()],
        { autoCommit: false },
      );
      return (r.rows ?? []).map((row) => String((row as Record<string, unknown>).COLUMN_NAME));
    } finally {
      await conn.close();
    }
  } catch {
    return [];
  }
}

// ———————————————————————————— 注释 / 索引 / 外键 ————————————————————————————

/** 源表注释（MySQL information_schema / PG obj_description / Oracle ALL_TAB_COMMENTS；取不到返回 null） */
async function srcTableComment(d: Dialect, connId: string, schema: string | undefined, db: string | undefined, table: string): Promise<string | null> {
  try {
    if (d === 'mysql') {
      const pool = await getMysqlPool(connId, db);
      const [rows] = (await pool.query(
        'SELECT TABLE_COMMENT AS c FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [schema, table],
      )) as [Record<string, unknown>[], unknown[]];
      const c = String(rows[0]?.c ?? '').trim();
      if (!c || /^innodb free/i.test(c) || /^view/i.test(c)) return null; // 过滤老版 InnoDB 容量噪音
      return c;
    }
    if (d === 'pg') {
      const pool = await getPgPool(connId, db);
      const r = await pool.query(
        `SELECT obj_description(to_regclass(format('%I.%I', $1, $2)), 'pg_class') AS c`,
        [schema || 'public', table],
      );
      return String(r.rows[0]?.c ?? '').trim() || null;
    }
    const pool = getOracle(connId)!;
    const conn = await pool.getConnection();
    try {
      const r = await conn.execute(
        `SELECT COMMENTS AS C FROM all_tab_comments WHERE owner = :o AND table_name = :t`,
        [(schema || '').toUpperCase(), table.toUpperCase()],
        { autoCommit: false },
      );
      return String((r.rows?.[0] as Record<string, unknown> | undefined)?.C ?? '').trim() || null;
    } finally {
      await conn.close();
    }
  } catch {
    return null; // 注释读取失败不阻断传输
  }
}

/** 目标方言的表注释 DDL */
function tableCommentSql(tgt: Dialect, schema: string | undefined, table: string, comment: string): string {
  const lit = `'${comment.replace(/'/g, "''")}'`;
  if (tgt === 'mysql') return `ALTER TABLE ${qt('mysql', undefined, table)} COMMENT ${lit}`;
  return `COMMENT ON TABLE ${qt(tgt, schema, table)} IS ${lit}`;
}

/** 该索引是否已随主键约束存在（避免重复建 PRIMARY/_pkey/同列唯一索引） */
function isPkIndex(table: string, idx: DbIndex, pkCols: string[]): boolean {
  if (/^primary$/i.test(idx.name) || idx.name === `${table}_pkey`) return true;
  if (!pkCols.length || !idx.unique) return false;
  const a = idx.columns.map((c) => c.toLowerCase()).sort().join(',');
  const b = pkCols.map((c) => c.toLowerCase()).sort().join(',');
  return a === b;
}

/** 目标方言的索引 DDL（indexName 允许与源不同名：PG/Oracle 索引名全局共享，重名时调用方会改前缀重试） */
function indexSql(tgt: Dialect, schema: string | undefined, table: string, idx: DbIndex, indexName: string): string {
  const cols = idx.columns.map((c) => qi(tgt, c)).join(', ');
  if (tgt === 'mysql') {
    const kind = /^fulltext$/i.test(idx.method ?? '') ? 'FULLTEXT ' : /^spatial$/i.test(idx.method ?? '') ? 'SPATIAL ' : idx.unique ? 'UNIQUE ' : '';
    return `CREATE ${kind}INDEX ${qi('mysql', indexName)} ON ${qt('mysql', undefined, table)} (${cols})`;
  }
  if (tgt === 'pg') {
    const method = idx.method && /^(btree|hash|gist|gin|brin|spgist)$/i.test(idx.method) ? ` USING ${idx.method.toLowerCase()}` : '';
    return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${qi('pg', indexName)} ON ${qt('pg', schema, table)} (${cols})${method}`;
  }
  const bitmap = /^bitmap$/i.test(idx.method ?? '') ? 'BITMAP ' : '';
  return `CREATE ${idx.unique ? 'UNIQUE ' : ''}${bitmap}INDEX ${qi('oracle', indexName)} ON ${qt('oracle', schema, table)} (${cols})`;
}

/** 外键引用表的限定名（跨库目标统一落到目标模式，保证被引用表可解析） */
function qualifiedRef(tgt: Dialect, schema: string | undefined, refTable: string): string {
  const parts = refTable.split('.').map((p) => p.replace(/^[`"]|[`"]$/g, '')).filter(Boolean);
  const name = parts[parts.length - 1] ?? refTable;
  if (tgt === 'mysql') return parts.length === 2 ? `${qi(tgt, parts[0])}.${qi(tgt, parts[1])}` : qi(tgt, name);
  if (parts.length === 2) return `${qi(tgt, parts[0])}.${qi(tgt, parts[1])}`;
  return qt(tgt, schema, name);
}

/** 目标方言的外键 DDL（Oracle 不支持 ON UPDATE，仅保留 ON DELETE 规则） */
function fkSql(tgt: Dialect, schema: string | undefined, table: string, fk: DbForeignKey): string {
  const cols = fk.columns.map((c) => qi(tgt, c)).join(', ');
  const refCols = fk.refColumns.map((c) => qi(tgt, c)).join(', ');
  let rules = '';
  if (fk.onUpdate && !/^no action$/i.test(fk.onUpdate) && tgt !== 'oracle') rules += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`;
  if (fk.onDelete && !/^no action$/i.test(fk.onDelete)) rules += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
  return `ALTER TABLE ${qt(tgt, schema, table)} ADD CONSTRAINT ${qi(tgt, fk.name)} FOREIGN KEY (${cols}) REFERENCES ${qualifiedRef(tgt, schema, fk.refTable)} (${refCols})${rules}`;
}

// ———————————————————————————— 目标侧写入 ————————————————————————————

/** 目标库写入器（按方言分批 INSERT） */
class TargetWriter {
  constructor(
    private d: Dialect,
    private connId: string,
    private schema: string | undefined,
    private db: string | undefined,
  ) {}

  /** 执行任意目标侧 DDL/DML */
  async exec(sql: string): Promise<void> {
    if (this.d === 'mysql') {
      const pool = await getMysqlPool(this.connId, this.db);
      await pool.query(sql);
      return;
    }
    if (this.d === 'pg') {
      const pool = await getPgPool(this.connId, this.db);
      await pool.query(sql);
      return;
    }
    const pool = getOracle(this.connId)!;
    const conn = await pool.getConnection();
    try {
      await conn.execute(sql, [], { autoCommit: true });
    } finally {
      await conn.close();
    }
  }

  /** 目标表是否存在（Oracle 无 IF NOT EXISTS，需要先探测） */
  async tableExists(table: string): Promise<boolean> {
    if (this.d === 'oracle') {
      const pool = getOracle(this.connId)!;
      const conn = await pool.getConnection();
      try {
        const owner = ((this.schema || this.oraOwner()).trim() || '').toUpperCase();
        const r = await conn.execute(`SELECT COUNT(*) AS C FROM all_tables WHERE owner = :o AND table_name = :t`, [owner, table.toUpperCase()], { autoCommit: false });
        return Number((r.rows?.[0] as Record<string, unknown> | undefined)?.C ?? 0) > 0;
      } finally {
        await conn.close();
      }
    }
    return false; // mysql/pg 用 IF NOT EXISTS，无需探测
  }

  /** Oracle 当前登录用户（目标模式缺省时） */
  private oraOwner(): string {
    return getConnection(this.connId)?.username ?? '';
  }

  /** 分批参数化插入一批行（rows 键大小写不敏感匹配列名） */
  async insertRows(table: string, cols: DbColumn[], rows: Record<string, unknown>[]): Promise<void> {
    if (!rows.length) return;
    const names = cols.map((c) => c.name);
    const colList = names.map((n) => qi(this.d, n)).join(', ');

    if (this.d === 'mysql') {
      const pool = await getMysqlPool(this.connId, this.db);
      const ph = `(${names.map(() => '?').join(',')})`;
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const sql = `INSERT INTO ${qt('mysql', this.schema, table)} (${colList}) VALUES ${batch.map(() => ph).join(',')}`;
        const params: unknown[] = [];
        for (const r of batch) for (const n of names) params.push(normVal(pick(r, n), 'mysql'));
        await pool.query(sql, params);
      }
      return;
    }
    if (this.d === 'pg') {
      const pool = await getPgPool(this.connId, this.db);
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const ph = batch
          .map((_, ri) => `(${names.map((_, ci) => `$${ri * names.length + ci + 1}`).join(',')})`)
          .join(',');
        const sql = `INSERT INTO ${qt('pg', this.schema, table)} (${colList}) VALUES ${ph}`;
        const params: unknown[] = [];
        for (const r of batch) for (const n of names) params.push(normVal(pick(r, n), 'pg'));
        await pool.query(sql, params);
      }
      return;
    }
    // Oracle：executeMany 批量绑定
    const pool = getOracle(this.connId)!;
    const conn = await pool.getConnection();
    try {
      const sql = `INSERT INTO ${qt('oracle', this.schema, table)} (${colList}) VALUES (${names.map((_, i) => `:${i + 1}`).join(',')})`;
      const binds = rows.map((r) => names.map((n) => normVal(pick(r, n), 'oracle')));
      await conn.executeMany(sql, binds as never[], { autoCommit: true, batchErrors: false });
    } finally {
      await conn.close();
    }
  }
}

/** 行取值：键大小写不敏感（Oracle 返回大写键） */
function pick(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name];
  const up = name.toUpperCase();
  if (up in row) return row[up];
  const low = name.toLowerCase();
  if (low in row) return row[low];
  return null;
}

/** 值归一化（跨方言写入前的类型整理） */
function normVal(v: unknown, tgt: Dialect): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v;
  if (Buffer.isBuffer(v)) return tgt === 'oracle' ? { val: v, type: oracledb.BLOB } : v;
  if (typeof v === 'boolean') {
    if (tgt === 'pg') return v; // pg 原生接受 boolean 绑定
    return v ? 1 : 0; // mysql tinyint(1) / oracle NUMBER(1)
  }
  if (typeof v === 'object') return JSON.stringify(v); // json/jsonb/数组 等结构化值
  return v;
}

// ———————————————————————————— 建表 ————————————————————————————

/** 按目标方言生成 CREATE TABLE（含主键/非空/可映射默认值/注释/自增-标识列）；omitDefaults 用于「默认值不被目标接受」时的兜底重建 */
function buildCreateTable(src: Dialect, tgt: Dialect, table: string, cols: DbColumn[], pkCols: string[], dropIfExists: boolean, omitDefaults = false): { sql: string; after: string[]; pk: string[] } {
  const comments: string[] = [];
  const effectivePk = pkCols.filter((p) => cols.some((c) => c.name === p));
  const defs: string[] = [];

  for (const col of cols) {
    const mapped = mapType(src, tgt, col);
    const parts = [`${qi(tgt, col.name)} ${mapped}`];
    if (!col.nullable) parts.push('NOT NULL');
    const dv = omitDefaults ? null : safeDefault(col.defaultValue, tgt, mapped);
    if (dv) parts.push(`DEFAULT ${dv}`);
    if (isAutoInc(col)) {
      if (tgt === 'mysql') parts.push('AUTO_INCREMENT');
      else if (tgt === 'pg' && /^(smallint|integer|bigint)/i.test(mapped)) parts.push('GENERATED BY DEFAULT AS IDENTITY');
      else if (tgt === 'oracle' && /^NUMBER/i.test(mapped)) parts.push('GENERATED BY DEFAULT ON NULL AS IDENTITY');
    }
    if (tgt === 'mysql' && col.comment) parts.push(`COMMENT '${col.comment.replace(/'/g, "''")}'`);
    defs.push(parts.join(' '));
  }
  if (effectivePk.length) defs.push(`PRIMARY KEY (${effectivePk.map((c) => qi(tgt, c)).join(', ')})`);

  const head = tgt === 'oracle' ? `CREATE TABLE` : `CREATE TABLE IF NOT EXISTS`;
  const sql = `${head} ${qt(tgt, undefined, table)} (\n  ${defs.join(',\n  ')}\n)`;
  for (const col of cols) {
    if (!col.comment) continue;
    if (tgt === 'pg') comments.push(`COMMENT ON COLUMN ${qt('pg', undefined, table)}.${qi('pg', col.name)} IS '${col.comment.replace(/'/g, "''")}'`);
    else if (tgt === 'oracle') comments.push(`COMMENT ON COLUMN ${qt('oracle', undefined, table)}.${qi('oracle', col.name)} IS '${col.comment.replace(/'/g, "''")}'`);
  }
  const after = dropIfExists ? comments : comments; // 注释语句统一在 create 后执行
  return { sql, after, pk: effectivePk };
}

// ———————————————————————————— 主流程 ————————————————————————————

/** 进度推送的简化回调签名 */
type Emit = (p: Partial<DataTransferProgress> & { message?: string }) => void;

/**
 * 执行一次数据传输（真实跨库拷贝）。
 * @returns 完成摘要 { tables, rows, errors }
 */
export async function runDataTransfer(spec: DataTransferSpec, taskId: string, emit: Emit): Promise<{ tables: number; rows: number; errors: string[] }> {
  const src = dialectOf(spec.sourceConnId, '源');
  const tgt = dialectOf(spec.targetConnId, '目标');
  if (spec.sourceConnId === spec.targetConnId && src === tgt) {
    throw new Error('源连接与目标连接相同：请选择不同的连接作为目标');
  }
  const tables = (spec.tables || []).filter(Boolean);
  if (!tables.length) throw new Error('未选择任何要传输的表');

  const srcSchema = src === 'mysql' ? spec.sourceDb : spec.sourceSchema;
  // 源库名：MySQL=库名；PG=跨库名（getPgPool 建附加池）；Oracle 忽略（连接串已含服务名）
  const srcDb = spec.sourceDb;
  const wantStructure = spec.mode !== 'data';
  const wantData = spec.mode !== 'structure';
  const errors: string[] = [];
  let rowsDone = 0;

  emit({ status: 'running', phase: 'prepare', currentTable: null, tablesTotal: tables.length, tablesDone: 0, rowsDone: 0, message: `准备：${tables.length} 张表，模式=${modeLabel(spec.mode)}` });

  // 1) 估算总行数（仅进度展示用；失败不影响传输）
  let rowsTotal = 0;
  const tableTotal = new Map<string, number | null>();
  for (const t of tables) {
    const c = await srcCount(src, spec.sourceConnId, srcSchema, srcDb, t);
    tableTotal.set(t, c);
    rowsTotal += c ?? 0;
  }
  emit({ phase: 'prepare', rowsTotal, message: `行数估算完成：约 ${rowsTotal} 行` });

  const writer = new TargetWriter(tgt, spec.targetConnId, tgt === 'mysql' ? undefined : spec.targetSchema, spec.targetDb);
  const ddlSchema = tgt === 'mysql' ? undefined : spec.targetSchema;

  // 2) 逐表：建表（结构）→ 拷数据
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (cancelled.has(taskId)) {
      emit({ status: 'cancelled', phase: 'finish', currentTable: null, message: '已取消' });
      throw new Error('传输已取消');
    }
    emit({ phase: wantStructure ? 'structure' : 'data', currentTable: t, currentRows: 0, currentRowsTotal: tableTotal.get(t) ?? null, message: `【${i + 1}/${tables.length}】开始处理表 ${t}` });

    try {
      // 2.1 源列定义
      const cols: DbColumn[] = await listColumns(spec.sourceConnId, srcSchema || '', t, srcDb);
      if (!cols.length) throw new Error('源表无列定义（表可能不存在或无权限）');

      let pkCols: string[] = cols.filter((c) => c.key === 'PRI').map((c) => c.name);
      if (src === 'oracle' && !pkCols.length) pkCols = await oraPkCols(spec.sourceConnId, srcSchema || '', t);

      // 2.2 建表（仅结构 / 结构和数据）
      if (wantStructure) {
        const exists = tgt === 'oracle' ? await writer.tableExists(t) : false;
        if (exists && spec.dropIfExists) {
          await writer.exec(`DROP TABLE ${qt(tgt, spec.targetSchema, t)}${tgt === 'pg' ? ' CASCADE' : tgt === 'oracle' ? ' CASCADE CONSTRAINTS PURGE' : ''}`);
          emit({ message: `  ${t}: 已删除旧表，重建` });
        } else if (exists) {
          emit({ message: `  ${t}: 目标表已存在，沿用其结构` });
        }
        if (!exists || spec.dropIfExists) {
          const { sql, after } = buildCreateTable(src, tgt, t, cols, pkCols, !!spec.dropIfExists);
          try {
            await writer.exec(sql);
          } catch (e) {
            const msg = String((e as Error).message || e);
            // 兜底：目标方言/版本不接受某个 DEFAULT（如 MySQL 1067 Invalid default value），去默认值重建，保证表结构走得通
            if (/invalid default/i.test(msg)) {
              const retry = buildCreateTable(src, tgt, t, cols, pkCols, !!spec.dropIfExists, true);
              await writer.exec(retry.sql);
              emit({ message: `  ${t}: 目标库不接受默认值定义，已改为不带默认值建表（${msg.split('\n')[0].slice(0, 120)}）` });
            } else {
              throw e;
            }
          }
          for (const c of after) await writer.exec(c);
          // 表注释（失败不阻断）
          try {
            const tc = await srcTableComment(src, spec.sourceConnId, srcSchema, srcDb, t);
            if (tc) await writer.exec(tableCommentSql(tgt, ddlSchema, t, tc));
          } catch { /* 注释失败不阻断 */ }
          emit({ message: `  ${t}: 建表完成（${cols.length} 列${pkCols.length ? `，主键 ${pkCols.join(',')}` : ''}）` });
        }
      }

      // 2.3 拷数据（仅数据 / 结构和数据）
      if (wantData) {
        const total = tableTotal.get(t) ?? null;
        let off = 0;
        const BATCH = 200;
        let cur = 0;
        while (true) {
          if (cancelled.has(taskId)) {
            emit({ status: 'cancelled', phase: 'finish', currentTable: null, message: '已取消' });
            throw new Error('传输已取消');
          }
          const page = await srcReadPage(src, spec.sourceConnId, srcSchema, srcDb, t, off, BATCH);
          if (!page.length) break;
          await writer.insertRows(t, cols, page);
          off += page.length;
          cur += page.length;
          rowsDone += page.length;
          emit({ phase: 'data', currentRows: cur, rowsDone, message: `  ${t}: 已传 ${cur}${total != null ? `/${total}` : ''} 行` });
          if (page.length < BATCH) break;
        }
        emit({ message: `  ${t}: 完成，共 ${cur} 行` });
      }

      // 2.4 索引（数据拷完后建，避免逐行插入被索引拖慢）；主键索引已随 PRIMARY KEY 约束存在，跳过
      if (wantStructure) {
        let idxs: DbIndex[] = [];
        try {
          idxs = await listIndexes(spec.sourceConnId, srcSchema || '', t, srcDb);
        } catch { /* 源索引内省失败，跳过该表索引 */ }
        for (const idx of idxs) {
          if (!idx.columns.length || isPkIndex(t, idx, pkCols)) continue;
          // PG/Oracle 索引名全 schema 共享，源里不同表可能同名：先原名，重名改「表名_索引名」重试
          let ok = false;
          for (const nm of [idx.name, `${t}_${idx.name}`]) {
            try {
              await writer.exec(indexSql(tgt, ddlSchema, t, idx, nm));
              ok = true;
              break;
            } catch { /* 同名冲突等，换下一个名字重试 */ }
          }
          emit({ message: ok ? `  ${t}: 索引 ${idx.name}${idx.unique ? '（唯一）' : ''} 已创建` : `  ${t}: 索引 ${idx.name} 创建失败，已跳过` });
        }
      }
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (msg === '传输已取消') throw err;
      errors.push(`${t}: ${msg}`);
      emit({ message: `  ${t}: 失败 — ${msg}` });
      continue;
    } finally {
      emit({ tablesDone: i + 1 });
    }
  }

  // 3) 外键补建（所有表建完后再加，避免被引用表尚不存在；单条失败只记日志）
  if (wantStructure) {
    emit({ phase: 'structure', currentTable: null, message: '开始创建外键约束…' });
    const seen = new Set<string>();
    let fkOk = 0;
    for (const t of tables) {
      if (cancelled.has(taskId)) {
        emit({ status: 'cancelled', phase: 'finish', currentTable: null, message: '已取消' });
        throw new Error('传输已取消');
      }
      let fks: DbForeignKey[] = [];
      try {
        fks = await listForeignKeys(spec.sourceConnId, srcSchema || '', t, srcDb);
      } catch { continue; }
      for (const fk of fks) {
        if (!fk.columns?.length || seen.has(fk.name)) continue;
        seen.add(fk.name);
        try {
          await writer.exec(fkSql(tgt, ddlSchema, t, fk));
          fkOk++;
          emit({ message: `  ${t}: 外键 ${fk.name}（→ ${fk.refTable}）已创建` });
        } catch (e) {
          emit({ message: `  ${t}: 外键 ${fk.name} 创建失败，已跳过（${String((e as Error).message || e).split('\n')[0].slice(0, 120)}）` });
        }
      }
    }
    if (fkOk) emit({ message: `外键创建完成：${fkOk} 条` });
  }

  emit({ status: 'done', phase: 'finish', currentTable: null, rowsDone, rowsTotal, message: `传输完成：${tables.length - errors.length}/${tables.length} 张表成功，共 ${rowsDone} 行${errors.length ? `，${errors.length} 张表失败` : ''}` });
  return { tables: tables.length, rows: rowsDone, errors };
}

/** 模式中文标签（日志用） */
function modeLabel(m: DataTransferMode): string {
  return m === 'structure' ? '仅结构' : m === 'data' ? '仅数据' : '结构和数据';
}
