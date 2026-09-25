import type { DbColumn, DbColumnSpec, QueryColumn, QueryResult } from '@shared/types';
import { getMysql, getPg, getPgPool } from '../clients/manager';

/**
 * SQL 执行服务（真实实现）。
 *
 * 按 connectionId 取已建立的 mysql2 / pg 连接，执行真实 SQL，
 * 把驱动返回的结果映射为统一 {@link QueryResult}（列定义 + 行 + 耗时）。
 * 写操作（INSERT/UPDATE/DELETE）返回 affectedRows。无任何假结果集。
 *
 * @since 0.1.0
 */

/** 把字段名（可能是 Buffer）转字符串 */
function colName(n: unknown): string {
  return Buffer.isBuffer(n as Buffer) ? (n as Buffer).toString('utf-8') : String(n ?? '?');
}

/** 常见 pg 类型 OID -> 名称（节选高频类型） */
const PG_OID: Record<number, string> = {
  16: 'bool', 17: 'bytea', 20: 'int8', 21: 'int2', 23: 'int4', 25: 'text', 114: 'json', 3802: 'jsonb',
  700: 'float4', 701: 'float8', 1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time', 1114: 'timestamp', 1184: 'timestamptz', 1700: 'numeric', 2950: 'uuid',
};

/** 执行任意 SQL，返回真实结果集 */
export async function runSql(connectionId: string, sql: string): Promise<QueryResult> {
  const start = Date.now();
  const sqlText = (sql || '').trim();
  if (!sqlText) throw new Error('SQL 为空');

  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (!mysqlPool && !pgPool) throw new Error('该连接不是数据库类型或未建立连接');

  try {
    if (mysqlPool) {
      const [rows, fields] = (await mysqlPool.query({ sql: sqlText, rowsAsArray: false })) as [Record<string, unknown>[], unknown[]];
      const columns: QueryColumn[] = (fields as Record<string, unknown>[]).map((f) => ({
        name: colName(f.name),
        dataType: String((f as Record<string, unknown>).columnType ?? ''),
      }));
      return {
        columns,
        rows: rows as Record<string, unknown>[],
        rowCount: (rows as unknown[]).length,
        elapsedMs: Date.now() - start,
        sql: sqlText,
      };
    } else {
      return mapPgResult(await pgPool!.query({ text: sqlText }), sqlText, start);
    }
  } catch (err) {
    throw new Error(`SQL 执行失败: ${(err as Error).message}`);
  }
}

/** 把 node-postgres 结果映射为统一 QueryResult（runSql / tableData 共用） */
function mapPgResult(res: { fields: Array<{ name: string; dataTypeID: number }>; rows: Record<string, unknown>[]; rowCount?: number | null }, sqlText: string, start: number): QueryResult {
  const columns: QueryColumn[] = res.fields.map((f) => ({
    name: f.name,
    dataType: PG_OID[f.dataTypeID] ?? `oid:${f.dataTypeID}`,
  }));
  return {
    columns,
    rows: res.rows,
    rowCount: res.rowCount ?? res.rows.length,
    elapsedMs: Date.now() - start,
    sql: sqlText,
    affectedRows: res.rowCount ?? undefined,
  };
}

/** 列出数据库（MySQL 列出全部；PG 仅当前连接库可浏览，故返回当前库名） */
export async function listDatabases(connectionId: string): Promise<string[]> {
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query('SHOW DATABASES')) as [Record<string, unknown>[], unknown[]];
    return rows.map((r) => Object.values(r)[0] as string).sort();
  }
  if (pgPool) {
    const res = await pgPool.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname');
    return res.rows.map((r: Record<string, unknown>) => r.datname as string);
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 新建数据库（数据库侧的「创建目录」：MySQL=CREATE DATABASE；PG=CREATE DATABASE） */
export async function createDatabase(connectionId: string, name: string): Promise<void> {
  const safe = (name || '').trim();
  if (!safe) throw new Error('数据库名不能为空');
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (mysqlPool) {
    await mysqlPool.query(`CREATE DATABASE IF NOT EXISTS \`${safe.replace(/`/g, '``')}\``);
    return;
  }
  if (pgPool) {
    // CREATE DATABASE 不能在事务块内执行；node-postgres 的 pool.query 默认不在事务中，直接下发
    await pgPool.query(`CREATE DATABASE "${safe.replace(/"/g, '""')}"`);
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出库内表（指定 database/schema 时按 information_schema 内省，否则用 SHOW TABLES） */
export async function listTables(connectionId: string, database?: string): Promise<string[]> {
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (mysqlPool) {
    if (database) {
      const [rows] = (await mysqlPool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type='BASE TABLE' ORDER BY table_name",
        [database],
      )) as [Record<string, unknown>[], unknown[]];
      return rows.map((r) => r.table_name as string);
    }
    const [rows] = (await mysqlPool.query('SHOW TABLES')) as [Record<string, unknown>[], unknown[]];
    return rows.map((r) => Object.values(r)[0] as string);
  }
  if (pgPool) {
    const res = await pgPool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE' ORDER BY table_name",
    );
    return res.rows.map((r: Record<string, unknown>) => r.table_name as string);
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出表字段（真实 information_schema 内省；PG 的 schema 参数=模式、db 参数=库名，可跨库）。含注释/默认值/自增等属性元数据 */
export async function listColumns(connectionId: string, schema: string, table: string, db?: string): Promise<DbColumn[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT ordinal_position, column_name, column_type, is_nullable, column_key, extra, column_default, column_comment
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [schema, table],
    )) as [Record<string, unknown>[], unknown[]];
    return rows.map((r) => ({
      name: r.column_name as string,
      dataType: r.data_type as string,
      nullable: (r.is_nullable as string) === 'YES',
      key: (r.column_key as string) || undefined,
      ordinal: Number(r.ordinal_position),
      fullType: (r.column_type as string) || undefined,
      extra: (r.extra as string) || undefined,
      defaultValue: r.column_default === null ? undefined : String(r.column_default),
      comment: (r.column_comment as string) || undefined,
    }));
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    // schema 精确匹配；schema 为空时退化为排除系统模式的全局查找。
    // col_description 取列注释；information_schema 无注释信息，需走 pg_description
    const s = schema?.trim();
    const cols = (
      s
        ? await pgPool.query(
            `SELECT c.ordinal_position, c.column_name, c.data_type, c.is_nullable,
                    c.character_maximum_length, c.numeric_precision, c.column_default,
                    col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS col_comment
             FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`,
            [s, table],
          )
        : await pgPool.query(
            `SELECT c.ordinal_position, c.column_name, c.data_type, c.is_nullable,
                    c.character_maximum_length, c.numeric_precision, c.column_default,
                    col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS col_comment
             FROM information_schema.columns c
             WHERE c.table_schema NOT IN ('pg_catalog','information_schema') AND c.table_name = $1 ORDER BY c.ordinal_position`,
            [table],
          )
    ).rows as Record<string, unknown>[];
    // 主键识别（pg_index）：PG 的 information_schema 不暴露 column_key，单独查一次
    const pk = s
      ? (
          await pgPool.query(
            `SELECT a.attname AS col
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
             WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2`,
            [s, table],
          )
        ).rows.map((r: Record<string, unknown>) => r.col as string)
      : [];
    return cols.map((r) => {
      const maxLen = r.character_maximum_length as number | null;
      const numPrec = r.numeric_precision as number | null;
      const fullType = maxLen ? `${r.data_type}(${maxLen})` : numPrec ? `${r.data_type}(${numPrec})` : (r.data_type as string);
      const def = r.column_default as string | null;
      // nextval(...) 序列默认值即 PG 的 auto_increment 等价物
      const extra = def && /nextval\(/i.test(def) ? 'auto_increment' : undefined;
      return {
        name: r.column_name as string,
        dataType: r.data_type as string,
        nullable: (r.is_nullable as string) === 'YES',
        key: pk.includes(r.column_name as string) ? ('PRI' as const) : undefined,
        ordinal: Number(r.ordinal_position),
        fullType,
        extra,
        defaultValue: def ?? undefined,
        comment: (r.col_comment as string) || undefined,
      };
    });
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出库内的模式（PG 专有层级：库 → 模式 → 对象；MySQL 无模式概念返回空数组）。db 指定跨库内省目标 */
export async function listSchemas(connectionId: string, db?: string): Promise<string[]> {
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (!pgPool) return [];
  // public 排最前（Navicat 习惯），排除 pg_ 内部模式
  const res = await pgPool.query(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg\\_%'
     ORDER BY (nspname <> 'public'), nspname`,
  );
  return res.rows.map((r: Record<string, unknown>) => r.nspname as string);
}

/** 可内省的数据库对象类型（树上的固定分类节点） */
export type DbObjKind = 'table' | 'view' | 'mview' | 'sequence' | 'function';

/**
 * 按模式 + 类型列出对象名（真实系统表内省；PG 可经 db 参数跨库）。
 * - PG：information_schema / pg_matviews / pg_sequences / pg_proc；
 * - MySQL：仅支持 table / view（schema 参数 = 数据库名）。
 */
export async function listObjects(connectionId: string, kind: DbObjKind, schema: string, db?: string): Promise<string[]> {
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  const s = (schema || '').trim();
  if (!s) throw new Error('模式名为空');
  if (pgPool) {
    switch (kind) {
      case 'table':
        return (
          await pgPool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
            [s],
          )
        ).rows.map((r: Record<string, unknown>) => r.table_name as string);
      case 'view':
        return (
          await pgPool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'VIEW' ORDER BY table_name",
            [s],
          )
        ).rows.map((r: Record<string, unknown>) => r.table_name as string);
      case 'mview':
        return (
          await pgPool.query('SELECT matviewname FROM pg_matviews WHERE schemaname = $1 ORDER BY matviewname', [s])
        ).rows.map((r: Record<string, unknown>) => r.matviewname as string);
      case 'sequence':
        return (
          await pgPool.query('SELECT sequencename FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename', [s])
        ).rows.map((r: Record<string, unknown>) => r.sequencename as string);
      case 'function':
        // 带参数签名（Navicat 风格：name(args)），按 oid 去重后按名排序
        return (
          await pgPool.query(
            `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS fname
             FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
             WHERE n.nspname = $1 ORDER BY fname`,
            [s],
          )
        ).rows.map((r: Record<string, unknown>) => r.fname as string);
    }
  }
  if (mysqlPool) {
    if (kind === 'table' || kind === 'view') {
      const type = kind === 'table' ? 'BASE TABLE' : 'VIEW';
      const [rows] = (await mysqlPool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = ? ORDER BY table_name',
        [s, type],
      )) as [Record<string, unknown>[], unknown[]];
      return rows.map((r) => r.table_name ?? r.TABLE_NAME).filter(Boolean).map(String);
    }
    return []; // MySQL 无物化视图/序列/函数树（存储过程暂不展开）
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 预览单表数据（MySQL：db.table；PG：schema.table 限定、db 参数选库（跨库，直接在目标库池上执行）；限制行数） */
export async function tableData(connectionId: string, schema: string | undefined, table: string, limit = 200, db?: string): Promise<QueryResult> {
  const start = Date.now();
  if (getMysql(connectionId)) {
    const sql = schema
      ? `SELECT * FROM \`${schema.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\` LIMIT ${limit}`
      : `SELECT * FROM ${quoteIdent(table)} LIMIT ${limit}`;
    return runSql(connectionId, sql);
  }
  if (getPg(connectionId)) {
    const pool = await getPgPool(connectionId, db);
    const sql = schema
      ? `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${limit}`
      : `SELECT * FROM ${quoteIdent(table)} LIMIT ${limit}`;
    try {
      return mapPgResult(await pool.query({ text: sql }), sql, start);
    } catch (err) {
      throw new Error(`SQL 执行失败: ${(err as Error).message}`);
    }
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 标识符转义（防注入式表名拼接，仅用于内部生成 SQL） */
function quoteIdent(name: string): string {
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 校验列类型文本（防注入：仅允许 类型名 / 多词类型 / 长度精度括号，如 varchar(64)、timestamp with time zone） */
function assertColumnType(t: string): string {
  const s = (t || '').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_ ]*(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?$/.test(s)) {
    throw new Error(`不支持的列类型：${t}（示例：varchar(64) / integer / timestamp）`);
  }
  return s;
}

/** 表限定名（MySQL：`db`.`table`；PG：schema.table） */
function qualifiedTable(dialect: 'mysql' | 'pg', schema: string | undefined, table: string): string {
  const t = dialect === 'mysql' ? `\`${table.replace(/`/g, '``')}\`` : quoteIdent(table);
  if (!schema?.trim()) return t;
  const s = dialect === 'mysql' ? `\`${schema.replace(/`/g, '``')}\`` : quoteIdent(schema);
  return `${s}.${t}`;
}

/** 新增表字段（属性页「新增字段」→ ALTER TABLE ADD COLUMN；PG 注释另发 COMMENT ON COLUMN） */
export async function addColumn(connectionId: string, schema: string | undefined, table: string, col: DbColumnSpec, db?: string): Promise<void> {
  const name = (col?.name || '').trim();
  if (!name) throw new Error('列名不能为空');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`非法列名：${name}`);
  const type = assertColumnType(col?.fullType || '');

  const mysqlPool = getMysql(connectionId);
  const parts = [`${quoteIdent(name)} ${type}`];
  if (!col.nullable) parts.push('NOT NULL');
  if (col.defaultValue != null && String(col.defaultValue).trim() !== '') parts.push(`DEFAULT ${String(col.defaultValue).trim()}`);

  if (mysqlPool) {
    const colDef = `${parts.join(' ')}${col.comment ? ` COMMENT '${col.comment.replace(/'/g, "''")}'` : ''}`;
    await mysqlPool.query(`ALTER TABLE ${qualifiedTable('mysql', schema, table)} ADD COLUMN ${colDef}`);
    return;
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    await pgPool.query(`ALTER TABLE ${qualifiedTable('pg', schema, table)} ADD COLUMN ${parts.join(' ')}`);
    if (col.comment) {
      await pgPool.query(`COMMENT ON COLUMN ${qualifiedTable('pg', schema, table)}."${name.replace(/"/g, '""')}" IS '${col.comment.replace(/'/g, "''")}'`);
    }
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 删除表字段（属性页行内「删除」→ ALTER TABLE DROP COLUMN） */
export async function dropColumn(connectionId: string, schema: string | undefined, table: string, column: string, db?: string): Promise<void> {
  const name = (column || '').trim();
  if (!name) throw new Error('列名不能为空');
  const mysqlPool = getMysql(connectionId);
  const qCol = mysqlPool ? `\`${name.replace(/`/g, '``')}\`` : quoteIdent(name);
  if (mysqlPool) {
    await mysqlPool.query(`ALTER TABLE ${qualifiedTable('mysql', schema, table)} DROP COLUMN ${qCol}`);
    return;
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    await pgPool.query(`ALTER TABLE ${qualifiedTable('pg', schema, table)} DROP COLUMN ${qCol}`);
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}
