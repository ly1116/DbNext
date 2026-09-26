import type { DbColumn, DbColumnSpec, DbCreateOptions, DbCreateSpec, DbForeignKey, DbIndex, DbObjectDef, DbObjectMeta, DbSequenceInfo, DbTrigger, DbUser, DbUserPrivEdit, DbUserPrivilege, DbUserSpec, PagedSqlResult, QueryColumn, QueryResult } from '@shared/types';
import { getMysql, getPg, getPgPool, getMysqlPool, getOracle, getConnDatabase } from '../clients/manager';
import {
  oraRunSql,
  oraListSchemas,
  oraListObjects,
  oraListObjectsMeta,
  oraListColumns,
  oraTableData,
  oraAddColumn,
  oraDropColumn,
  oraListIndexes,
  oraListForeignKeys,
  oraListTriggers,
  oraGetViewDef,
  oraGetFunctionDef,
  oraGetSequenceInfo,
  oraListUsers,
  oraGetUserPrivileges,
  oraCreateUser,
  oraDropUser,
} from './oracle.service';

/** 标识符白名单（用户管理：用户名/角色名，仅允许字母数字下划线，防注入） */
function assertUserName(v: string, field: string): string {
  const s = (v || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(s)) throw new Error(`非法${field}：${s}`);
  return s;
}

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

/** 执行任意 SQL，返回真实结果集。MySQL / PG 传 db 时路由到对应库的连接池 */
export async function runSql(connectionId: string, sql: string, db?: string): Promise<QueryResult> {
  const start = Date.now();
  const sqlText = (sql || '').trim();
  if (!sqlText) throw new Error('SQL 为空');

  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (getOracle(connectionId)) return oraRunSql(connectionId, sqlText);
  if (!mysqlPool && !pgPool) throw new Error('该连接不是数据库类型或未建立连接');

  try {
    if (mysqlPool) {
      const pool = db ? await getMysqlPool(connectionId, db) : mysqlPool;
      const [rows, fields] = (await pool.query({ sql: sqlText, rowsAsArray: false })) as [Record<string, unknown>[], unknown[]];
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
      const pool = db ? await getPgPool(connectionId, db) : pgPool!;
      return mapPgResult(await pool.query({ text: sqlText }), sqlText, start);
    }
  } catch (err) {
    throw new Error(`SQL 执行失败: ${(err as Error).message}`);
  }
}

/**
 * 分页执行 SQL（SQL 查询编辑器专用）。
 *
 * 对 SELECT/WITH 类查询：自动包一层 COUNT(*) 拿总行数 + LIMIT/OFFSET 取当页（默认 200 行/页），
 * 前端滚动到底部时以 offset 递增加载下一页；非查询语句（DML/DDL）直接执行、不分页。
 * MySQL / PG 传 db 时路由到对应库的连接池（查询编辑器内切库，不依赖会话 USE）。
 */
export async function runSqlPaged(connectionId: string, sql: string, offset = 0, limit = 200, db?: string): Promise<PagedSqlResult> {
  const start = Date.now();
  // 去掉结尾分号再包子查询，避免 `...;` 直接跟 `) sub` 语法错误
  const sqlText = (sql || '').trim().replace(/;+\s*$/, '');
  if (!sqlText) throw new Error('SQL 为空');
  const safeOffset = Math.max(0, Math.trunc(offset) || 0);
  const safeLimit = Math.min(2000, Math.max(1, Math.trunc(limit) || 200));
  const isRead = /^(select|with|\(select)\b/i.test(sqlText);

  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  const oraPool = getOracle(connectionId);
  if (!mysqlPool && !pgPool && !oraPool) throw new Error('该连接不是数据库类型或未建立连接');

  try {
    // —— 非查询语句：直接执行，不分页 ——
    if (!isRead) {
      const result = await runSql(connectionId, sqlText, db);
      return { result, total: null, hasMore: false, offset: 0 };
    }

    if (mysqlPool) {
      const pool = db ? await getMysqlPool(connectionId, db) : mysqlPool;
      const [countRows] = (await pool.query(`SELECT COUNT(*) AS total FROM (${sqlText}) sub`)) as [Record<string, unknown>[], unknown[]];
      const total = Number(countRows[0]?.total ?? 0);
      const [rows, fields] = (await pool.query(`SELECT * FROM (${sqlText}) sub LIMIT ${safeLimit} OFFSET ${safeOffset}`)) as [Record<string, unknown>[], unknown[]];
      const columns: QueryColumn[] = (fields as Record<string, unknown>[]).map((f) => ({
        name: colName(f.name),
        dataType: String((f as Record<string, unknown>).columnType ?? ''),
      }));
      return {
        result: { columns, rows: rows as Record<string, unknown>[], rowCount: (rows as unknown[]).length, elapsedMs: Date.now() - start, sql: sqlText },
        total,
        hasMore: safeOffset + (rows as unknown[]).length < total,
        offset: safeOffset,
      };
    }

    if (pgPool) {
      const pool = db ? await getPgPool(connectionId, db) : pgPool;
      const countRes = await pool.query(`SELECT COUNT(*)::bigint AS total FROM (${sqlText}) sub`);
      const total = Number(countRes.rows[0]?.total ?? 0);
      const pageRes = await pool.query({ text: `SELECT * FROM (${sqlText}) sub LIMIT ${safeLimit} OFFSET ${safeOffset}` });
      const result = mapPgResult(pageRes, sqlText, start);
      return { result, total, hasMore: safeOffset + result.rows.length < total, offset: safeOffset };
    }

    // Oracle：ROWNUM 分页；count 同样包子查询
    const conn = await oraPool!.getConnection();
    try {
      const countRes = await conn.execute(`SELECT COUNT(*) AS TOTAL FROM (${sqlText}) SUB`, [], { autoCommit: false });
      const total = Number((countRes.rows?.[0] as Record<string, unknown> | undefined)?.TOTAL ?? 0);
      const pageSql = `SELECT * FROM (SELECT sub.*, ROWNUM AS __ROWNUM__ FROM (${sqlText}) sub WHERE ROWNUM <= ${safeOffset + safeLimit}) WHERE __ROWNUM__ > ${safeOffset}`;
      const res = await conn.execute(pageSql, [], { autoCommit: false });
      // 过滤掉辅助列 __ROWNUM__
      const columns: QueryColumn[] = (res.metaData ?? [])
        .filter((m) => m.name.toUpperCase() !== '__ROWNUM__')
        .map((m) => ({ name: m.name, dataType: '' }));
      const rows = (res.rows ?? []).map((r) => {
        const c = { ...(r as Record<string, unknown>) };
        for (const k of Object.keys(c)) if (k.toUpperCase() === '__ROWNUM__') delete c[k];
        return c;
      });
      return {
        result: { columns, rows, rowCount: rows.length, elapsedMs: Date.now() - start, sql: sqlText },
        total,
        hasMore: safeOffset + rows.length < total,
        offset: safeOffset,
      };
    } finally {
      await conn.close();
    }
  } catch (err) {
    throw new Error(`SQL 执行失败: ${(err as Error).message}`);
  }
}

/**
 * 拉取当前库/模式下所有表和视图的列清单（SQL 编辑器智能提示数据源）。
 * 返回 { 表名(小写): [列名...] }。
 */
export async function listSchemaColumns(connectionId: string, db?: string): Promise<Record<string, string[]>> {
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  const oraPool = getOracle(connectionId);
  if (!mysqlPool && !pgPool && !oraPool) throw new Error('该连接不是数据库类型或未建立连接');

  const map: Record<string, string[]> = {};
  const put = (t: unknown, c: unknown) => {
    if (t == null || c == null) return;
    const table = String(t).toLowerCase();
    (map[table] ??= []).push(String(c));
  };

  if (mysqlPool) {
    // 有 db（查询页切库）走对应库的池并按库过滤；否则退回当前会话 DATABASE()（可能为空 = 未选库）
    const pool = db ? await getMysqlPool(connectionId, db) : mysqlPool;
    const [rows] = (await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = COALESCE(?, DATABASE()) ORDER BY table_name, ordinal_position`,
      [db || null],
    )) as [Record<string, unknown>[], unknown[]];
    rows.forEach((r) => put(r.table_name, r.column_name));
  } else if (pgPool) {
    // PG：内省目标库的**全部用户 schema**（排除系统 schema），返回两种键：
    //   "schema.table" -> 列数组（支持 schema.table 限定名补全）
    //   "table"        -> 跨同名表合并的列集（裸表名补全，search_path 内可直接用）
    const pool = db ? await getPgPool(connectionId, db) : pgPool;
    const res = await pool.query(
      `SELECT table_schema, table_name, column_name FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`,
    );
    for (const r of res.rows) {
      const s = String(r.table_schema).toLowerCase();
      const t = String(r.table_name).toLowerCase();
      const c = String(r.column_name);
      (map[`${s}.${t}`] ??= []).push(c);
      const bare = (map[t] ??= []);
      if (!bare.includes(c)) bare.push(c);
    }
  } else {
    const conn = await oraPool!.getConnection();
    try {
      const res = await conn.execute(`SELECT table_name, column_name FROM user_tab_columns ORDER BY table_name, column_id`, [], { autoCommit: false });
      (res.rows ?? []).forEach((r) => put((r as Record<string, unknown>).TABLE_NAME, (r as Record<string, unknown>).COLUMN_NAME));
    } finally {
      await conn.close();
    }
  }
  return map;
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
    // 连接配置指定了「数据库」→ 只显示该库，其余全部隐藏（Navicat 语义：按指定库连接）
    const configured = getConnDatabase(connectionId);
    if (configured) return [configured];
    // 未指定 → 按当前连接账号权限过滤（CONNECT）：无权限的库不显示
    const res = await pgPool.query(
      `SELECT datname FROM pg_database
       WHERE NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
       ORDER BY datname`,
    );
    return res.rows.map((r: Record<string, unknown>) => r.datname as string);
  }
  if (getOracle(connectionId)) return oraListSchemas(connectionId);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 建库选项的值校验（标识符宽松白名单：字母/数字/_.-$空格/中文，防注入；PG 编码/排序规则也走此校验） */
function assertSafeIdent(v: string, field: string): string {
  if (!/^[a-zA-Z0-9_.$\-一-龥 ]+$/.test(v)) throw new Error(`非法${field}：${v}`);
  return v;
}

/** 新建数据库（Navicat 风格方言化表单：MySQL=字符集/排序规则；PG=属主/编码/排序规则/模板/表空间/连接数上限） */
export async function createDatabase(connectionId: string, spec: DbCreateSpec): Promise<void> {
  const safe = (spec?.name || '').trim();
  if (!safe) throw new Error('数据库名不能为空');
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (mysqlPool) {
    let sql = `CREATE DATABASE IF NOT EXISTS \`${safe.replace(/`/g, '``')}\``;
    if (spec.charset?.trim()) sql += ` DEFAULT CHARACTER SET ${assertSafeIdent(spec.charset.trim(), '字符集')}`;
    if (spec.collation?.trim()) sql += ` DEFAULT COLLATE ${assertSafeIdent(spec.collation.trim(), '排序规则')}`;
    await mysqlPool.query(sql);
    return;
  }
  if (pgPool) {
    // CREATE DATABASE 不能在事务块内执行；node-postgres 的 pool.query 默认不在事务中，直接下发
    const opts: string[] = [];
    if (spec.template?.trim()) opts.push(`TEMPLATE "${assertSafeIdent(spec.template.trim(), '模板').replace(/"/g, '')}"`);
    if (spec.encoding?.trim()) opts.push(`ENCODING '${assertSafeIdent(spec.encoding.trim(), '编码')}'`);
    if (spec.lcCollate?.trim()) opts.push(`LC_COLLATE '${assertSafeIdent(spec.lcCollate.trim(), '排序规则')}'`);
    if (spec.lcCtype?.trim()) opts.push(`LC_CTYPE '${assertSafeIdent(spec.lcCtype.trim(), '字符类型')}'`);
    if (spec.owner?.trim()) opts.push(`OWNER "${assertSafeIdent(spec.owner.trim(), '属主').replace(/"/g, '')}"`);
    if (spec.tablespace?.trim()) opts.push(`TABLESPACE "${assertSafeIdent(spec.tablespace.trim(), '表空间').replace(/"/g, '')}"`);
    if (spec.connectionLimit != null && Number.isFinite(spec.connectionLimit)) opts.push(`CONNECTION LIMIT ${Math.trunc(spec.connectionLimit)}`);
    await pgPool.query(`CREATE DATABASE "${safe.replace(/"/g, '""')}"${opts.length ? ` WITH ${opts.join(' ')}` : ''}`);
    return;
  }
  if (getOracle(connectionId)) {
    // Oracle 无「数据库」概念，Navicat 的「新建数据库」等价于新建用户/Schema
    const pool = getOracle(connectionId)!;
    const ts = spec.tablespace?.trim() ? `"${assertSafeIdent(spec.tablespace.trim(), '表空间')}"` : 'USERS';
    const conn = await pool.getConnection();
    try {
      await conn.execute(`CREATE USER "${safe}" IDENTIFIED BY "${safe}123" DEFAULT TABLESPACE ${ts} QUOTA UNLIMITED ON ${ts}`, [], { autoCommit: true });
      await conn.execute(`GRANT CREATE SESSION, RESOURCE, UNLIMITED TABLESPACE TO "${safe}"`, [], { autoCommit: true });
    } finally {
      await conn.close();
    }
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 建库对话框下拉数据源（MySQL 字符集/排序规则；PG 角色/表空间/模板库/可用排序规则） */
export async function listDbCreateOptions(connectionId: string): Promise<DbCreateOptions> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [chRows] = (await mysqlPool.query(`SHOW CHARACTER SET`)) as [Record<string, unknown>[], unknown[]];
    const [collRows] = (await mysqlPool.query(`SHOW COLLATION`)) as [Record<string, unknown>[], unknown[]];
    return {
      kind: 'mysql',
      charsets: chRows.map((r) => r.Charset as string),
      collations: collRows.map((r) => ({ name: r.Collation as string, charset: r.Charset as string })),
    };
  }
  if (getPg(connectionId)) {
    const pool = await getPgPool(connectionId);
    const [owners, tablespaces, templates, coll] = await Promise.all([
      pool.query(`SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1`),
      pool.query(`SELECT spcname FROM pg_tablespace ORDER BY (spcname <> 'pg_default'), spcname`),
      pool.query(`SELECT datname FROM pg_database WHERE datistemplate ORDER BY (datname <> 'template1'), datname`),
      pool.query(
        `SELECT DISTINCT collname FROM pg_collation
         WHERE collname IN ('C','POSIX') OR collname ~* '^[a-z]{2}[_.]' ORDER BY 1 LIMIT 300`,
      ),
    ]);
    return {
      kind: 'postgres',
      owners: owners.rows.map((r: Record<string, unknown>) => r.rolname as string),
      tablespaces: tablespaces.rows.map((r: Record<string, unknown>) => r.spcname as string),
      templates: templates.rows.map((r: Record<string, unknown>) => r.datname as string),
      encodings: ['UTF8', 'SQL_ASCII', 'LATIN1', 'LATIN2', 'ISO_8859_5', 'WIN1250', 'WIN1251', 'WIN1252', 'KOI8R', 'EUC_CN', 'GBK', 'GB18030'],
      pgCollations: coll.rows.map((r: Record<string, unknown>) => r.collname as string),
    };
  }
  if (getOracle(connectionId)) {
    const pool = getOracle(connectionId)!;
    const conn = await pool.getConnection();
    try {
      const res = await conn.execute('SELECT tablespace_name FROM user_tablespaces ORDER BY tablespace_name', [], { autoCommit: false });
      return {
        kind: 'oracle',
        tablespaces: (res.rows ?? []).map((r) => (r as Record<string, unknown>).TABLESPACE_NAME as string),
      };
    } finally {
      await conn.close();
    }
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
  if (getOracle(connectionId)) {
    if (!database) throw new Error('Oracle 需指定用户/Schema');
    return oraListObjects(connectionId, 'table', database);
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出表字段（真实 information_schema 内省；PG 的 schema 参数=模式、db 参数=库名，可跨库）。含注释/默认值/自增等属性元数据 */
export async function listColumns(connectionId: string, schema: string, table: string, db?: string): Promise<DbColumn[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT 
        ordinal_position AS ordinal_position,
        column_name AS column_name,
        data_type AS data_type,
        column_type AS column_type,
        is_nullable AS is_nullable,
        column_key AS column_key,
        extra AS extra,
        column_default AS column_default,
        column_comment AS column_comment,
        collation_name AS collation_name
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
      collation: (r.collation_name as string) || undefined,
    }));
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    // schema 精确匹配；schema 为空时退化为排除系统模式的全局查找。
    // col_description 取列注释；information_schema 无注释信息，需走 pg_description
    const s = schema?.trim();
    const colSelect = `SELECT c.ordinal_position, c.column_name, c.data_type, c.is_nullable,
                    c.character_maximum_length, c.numeric_precision, c.column_default,
                    c.collation_name, c.is_identity,
                    col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS col_comment`;
    const cols = (
      s
        ? await pgPool.query(
            `${colSelect}
             FROM information_schema.columns c
             WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position`,
            [s, table],
          )
        : await pgPool.query(
            `${colSelect}
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
      // nextval(...) 序列默认值即 PG 的 auto_increment 等价物；GENERATED AS IDENTITY 标识列单独标记
      const isIdentity = (r.is_identity as string) === 'YES';
      const extra = isIdentity ? 'identity' : def && /nextval\(/i.test(def) ? 'auto_increment' : undefined;
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
        collation: (r.collation_name as string) || undefined,
      };
    });
  }
  if (getOracle(connectionId)) return oraListColumns(connectionId, schema, table);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出库内的模式（PG 专有层级：库 → 模式 → 对象；MySQL 无模式概念返回空数组）。db 指定跨库内省目标 */
export async function listSchemas(connectionId: string, db?: string): Promise<string[]> {
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (!pgPool) return [];
  // public 排最前（Navicat 习惯），排除 pg_ 内部模式与 information_schema（Navicat 默认隐藏系统模式），
  // 并仅列出当前连接账号对该模式有 USAGE 权限者（按账号权限过滤）
  const res = await pgPool.query(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
       AND has_schema_privilege(nspname, 'USAGE')
     ORDER BY (nspname <> 'public'), nspname`,
  );
  return res.rows.map((r: Record<string, unknown>) => r.nspname as string);
}

/** 可内省的数据库对象类型（树上的固定分类节点） */
export type DbObjKind = 'table' | 'view' | 'mview' | 'sequence' | 'function';

/** PG 库节点下的元数据分类（Navicat 风格：模式之外的服务器级对象） */
export type PgMetaKind = 'event_trigger' | 'extension' | 'tablespace' | 'role' | 'sysinfo';

/**
 * 列出 PG 库节点的元数据分类内容（跨库时真实连到目标库）：
 * - event_trigger: pg_event_trigger 事件触发器名；
 * - extension: pg_extension 已安装扩展；
 * - tablespace: pg_tablespace 表空间（存储）；
 * - role: pg_roles 角色（排除 pg_ 内置）；
 * - sysinfo: 系统信息（库名/用户/主机/版本）。
 */
export async function listPgMeta(connectionId: string, db: string | undefined, kind: PgMetaKind): Promise<string[]> {
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (!pgPool) throw new Error('该连接不是 PostgreSQL 类型或未建立连接');
  if (kind === 'sysinfo') {
    const r = await pgPool.query(
      `SELECT current_database() AS db, current_user AS usr, version() AS ver,
              inet_server_addr()::text AS addr, inet_server_port() AS port`,
    );
    const v = (r.rows[0] ?? {}) as Record<string, unknown>;
    return [
      `数据库: ${String(v.db ?? '')}`,
      `用户: ${String(v.usr ?? '')}`,
      `主机: ${v.addr ? String(v.addr) : 'localhost'}:${v.port ? String(v.port) : '5432'}`,
      `版本: ${String(v.ver ?? '').split(',')[0].split(' on ')[0]}`,
    ];
  }
  const sql: Record<Exclude<PgMetaKind, 'sysinfo'>, string> = {
    event_trigger: `SELECT evtname AS n FROM pg_event_trigger ORDER BY 1`,
    extension: `SELECT extname AS n FROM pg_extension ORDER BY 1`,
    tablespace: `SELECT spcname AS n FROM pg_tablespace ORDER BY (spcname <> 'pg_default'), spcname`,
    role: `SELECT rolname AS n FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1`,
  };
  const res = await pgPool.query(sql[kind]);
  return res.rows.map((r: Record<string, unknown>) => r.n as string);
}

/** 可带注释内省的对象类型（表/视图/物化视图清单页） */
export type DbMetaKind = 'table' | 'view' | 'mview';

/**
 * 按模式 + 类型列出对象并附注释（DBeaver 点击「表」分类的编辑器清单；PG 可经 db 参数跨库）。
 * - PG：pg_class + obj_description（table 含分区表 r/p；view=v；mview=m）；
 * - MySQL：information_schema.tables（table_comment / 视图无注释）。
 */
export async function listObjectsMeta(connectionId: string, kind: DbMetaKind, schema: string, db?: string): Promise<DbObjectMeta[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const type = kind === 'table' ? 'BASE TABLE' : 'VIEW';
    const [rows] = (await mysqlPool.query(
      `SELECT table_name AS name, table_comment AS comment
       FROM information_schema.tables
       WHERE table_schema = ? AND table_type = ?
       ORDER BY table_name`,
      [schema, type],
    )) as [Record<string, unknown>[], unknown[]];
    return rows.map((r) => ({ name: r.name as string, comment: (r.comment as string) || undefined }));
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const relkind = kind === 'table' ? "('r','p')" : kind === 'view' ? "('v')" : "('m')";
    const res = await pgPool.query(
      `SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ${relkind}
       ORDER BY c.relname`,
      [schema],
    );
    return res.rows.map((r: Record<string, unknown>) => ({ name: r.name as string, comment: (r.comment as string) || undefined }));
  }
  if (getOracle(connectionId)) return oraListObjectsMeta(connectionId, kind === 'mview' ? 'table' : kind, schema);
  throw new Error('该连接不是数据库类型或未建立连接');
}

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
  if (getOracle(connectionId)) return oraListObjects(connectionId, kind, s);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/**
 * 校验用户输入的原生 WHERE / ORDER BY 片段（Navicat 风格筛选栏）。
 * 只拦截明显危险内容（多语句分号、SQL 注释），其余作为合法 SQL 表达式拼进查询——
 * 本身是数据库管理工具，用户有完整的查询权限，这里防的是误操作而非恶意用户。
 */
function sanitizeFilterFragment(kind: 'where' | 'order by', raw: string | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/;/.test(s) || /--/.test(s) || /\/\*/.test(s)) throw new Error(`${kind} 条件中不允许包含分号或 SQL 注释（-- /*）`);
  return s;
}

/** 预览单表数据（MySQL：db.table；PG：schema.table 限定、db 参数选库（跨库，直接在目标库池上执行）；限制行数；offset>0 翻页（滚动加载）；filter.where/order by 为原生 SQL 片段，回车触发） */
export async function tableData(connectionId: string, schema: string | undefined, table: string, limit = 200, db?: string, offset = 0, filter?: { where?: string; orderBy?: string }): Promise<QueryResult> {
  const start = Date.now();
  const off = Math.max(0, Math.trunc(offset) || 0);
  const where = sanitizeFilterFragment('where', filter?.where);
  const orderBy = sanitizeFilterFragment('order by', filter?.orderBy);
  const whereCl = where ? ` WHERE ${where}` : '';
  const orderCl = orderBy ? ` ORDER BY ${orderBy}` : '';
  if (getMysql(connectionId)) {
    const sql = schema
      ? `SELECT * FROM \`${schema.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\`${whereCl}${orderCl} LIMIT ${limit} OFFSET ${off}`
      : `SELECT * FROM ${quoteIdent(table)}${whereCl}${orderCl} LIMIT ${limit} OFFSET ${off}`;
    return runSql(connectionId, sql);
  }
  if (getPg(connectionId)) {
    const pool = await getPgPool(connectionId, db);
    const sql = schema
      ? `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)}${whereCl}${orderCl} LIMIT ${limit} OFFSET ${off}`
      : `SELECT * FROM ${quoteIdent(table)}${whereCl}${orderCl} LIMIT ${limit} OFFSET ${off}`;
    try {
      return mapPgResult(await pool.query({ text: sql }), sql, start);
    } catch (err) {
      throw new Error(`SQL 执行失败: ${(err as Error).message}`);
    }
  }
  if (getOracle(connectionId)) return oraTableData(connectionId, schema, table, limit, off, filter);
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

/** 校验排序规则名（防注入：仅允许字母数字下划线点，如 C / zh_CN.utf8 / utf8mb4_general_ci） */
function assertCollation(c: string): string {
  const s = (c || '').trim();
  if (!/^[a-zA-Z0-9_.]+$/.test(s)) throw new Error(`非法排序规则：${c}`);
  return s;
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
    if (col.autoIncrement) parts.push('AUTO_INCREMENT');
    const colDef = `${parts.join(' ')}${col.comment ? ` COMMENT '${col.comment.replace(/'/g, "''")}'` : ''}`;
    try {
      await mysqlPool.query(`ALTER TABLE ${qualifiedTable('mysql', schema, table)} ADD COLUMN ${colDef}`);
    } catch (err) {
      const msg = (err as Error).message || '';
      // MySQL 约束：自增列必须是键（主键/唯一索引），报错时给可操作的提示
      if (col.autoIncrement && /key|index|auto_increment/i.test(msg)) {
        throw new Error(`${msg}（提示：MySQL 自增列必须定义为主键或唯一索引，可先不加自增，或随后为其建主键）`);
      }
      throw err;
    }
    return;
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    // PG 专属：标识列（GENERATED ... AS IDENTITY，仅整型）与排序规则（COLLATE）
    if (col.identity) {
      if (!/^(smallint|integer|bigint)/i.test(type)) throw new Error('PG 标识列仅支持 smallint / integer / bigint 类型');
      parts.push(col.identity === 'always' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY');
    }
    const collation = col.collation?.trim() ? `"${assertCollation(col.collation)}"` : '';
    const colDef = collation ? `${parts[0]} COLLATE ${collation} ${parts.slice(1).join(' ')}` : parts.join(' ');
    await pgPool.query(`ALTER TABLE ${qualifiedTable('pg', schema, table)} ADD COLUMN ${colDef}`);
    if (col.comment) {
      await pgPool.query(`COMMENT ON COLUMN ${qualifiedTable('pg', schema, table)}.${quoteIdent(name)} IS '${col.comment.replace(/'/g, "''")}'`);
    }
    return;
  }
  if (getOracle(connectionId)) {
    await oraAddColumn(connectionId, schema, table, col);
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
  if (getOracle(connectionId)) {
    await oraDropColumn(connectionId, schema, table, column);
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 删除对象（表/视图/物化视图/序列/函数） */
export async function dropObject(
  connectionId: string,
  kind: 'table' | 'view' | 'mview' | 'sequence' | 'function',
  schema: string,
  name: string,
  db?: string
): Promise<void> {
  const n = (name || '').trim();
  if (!n) throw new Error('对象名不能为空');
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const qName = `\`${n.replace(/`/g, '``')}\``;
    const qSchema = schema ? `\`${schema.replace(/`/g, '``')}\`` : '`information_schema`';
    if (kind === 'table') await mysqlPool.query(`DROP TABLE ${qSchema}.${qName}`);
    else if (kind === 'view') await mysqlPool.query(`DROP VIEW ${qSchema}.${qName}`);
    else throw new Error(`MySQL 不支持删除 ${kind}`);
    return;
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const qName = quoteIdent(n);
    const qSchema = quoteIdent(schema);
    if (kind === 'table') await pgPool.query(`DROP TABLE ${qSchema}.${qName}`);
    else if (kind === 'view') await pgPool.query(`DROP VIEW ${qSchema}.${qName}`);
    else if (kind === 'mview') await pgPool.query(`DROP MATERIALIZED VIEW ${qSchema}.${qName}`);
    else if (kind === 'sequence') await pgPool.query(`DROP SEQUENCE ${qSchema}.${qName}`);
    else if (kind === 'function') await pgPool.query(`DROP FUNCTION ${qSchema}.${qName}`);
    else throw new Error(`PG 不支持删除 ${kind}`);
    return;
  }
  if (getOracle(connectionId)) {
    if (kind === 'table') await oraRunSql(connectionId, `DROP TABLE "${schema}"."${n}"`);
    else if (kind === 'view') await oraRunSql(connectionId, `DROP VIEW "${schema}"."${n}"`);
    else if (kind === 'mview') await oraRunSql(connectionId, `DROP MATERIALIZED VIEW "${schema}"."${n}"`);
    else if (kind === 'sequence') await oraRunSql(connectionId, `DROP SEQUENCE "${schema}"."${n}"`);
    else throw new Error(`Oracle 不支持删除 ${kind}`);
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出表索引（表设计器「索引」子页；PG/MySQL 经 information_schema，Oracle 经 ALL_INDEXES） */
export async function listIndexes(connectionId: string, schema: string, table: string, db?: string): Promise<DbIndex[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT s.INDEX_NAME AS name, s.NON_UNIQUE AS non_unique, s.COLUMN_NAME AS col, s.INDEX_TYPE AS method, s.SEQ_IN_INDEX AS seq
       FROM information_schema.STATISTICS s
       WHERE s.TABLE_SCHEMA = ? AND s.TABLE_NAME = ?
       ORDER BY s.INDEX_NAME, s.SEQ_IN_INDEX`,
      [schema, table],
    )) as [Record<string, unknown>[], unknown[]];
    const map = new Map<string, DbIndex>();
    for (const r of rows) {
      const n = r.name as string;
      if (!map.has(n)) map.set(n, { name: n, columns: [], unique: (r.non_unique as number) === 0, method: (r.method as string) || undefined });
      map.get(n)!.columns.push(r.col as string);
    }
    return [...map.values()];
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT i.relname AS name, idx.indisunique AS is_unique, am.amname AS method,
              string_agg(a.attname, ',' ORDER BY array_position(idx.indkey, a.attnum)) AS cols
       FROM pg_index idx
       JOIN pg_class t ON t.oid = idx.indrelid
       JOIN pg_class i ON i.oid = idx.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_am am ON am.oid = i.relam
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(idx.indkey)
       WHERE n.nspname = $1 AND t.relname = $2
       GROUP BY i.relname, idx.indisunique, am.amname
       ORDER BY i.relname`,
      [schema, table],
    );
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      name: r.name as string,
      columns: String(r.cols ?? '').split(',').filter(Boolean),
      unique: (r.is_unique as boolean) === true,
      method: (r.method as string) || undefined,
    }));
  }
  if (getOracle(connectionId)) return oraListIndexes(connectionId, schema, table);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出表外键（表设计器「外键」子页；PG/MySQL 经 information_schema，Oracle 经 ALL_CONSTRAINTS） */
export async function listForeignKeys(connectionId: string, schema: string, table: string, db?: string): Promise<DbForeignKey[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col,
              k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col,
              r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [schema, table],
    )) as [Record<string, unknown>[], unknown[]];
    const map = new Map<string, DbForeignKey>();
    for (const r of rows) {
      const n = r.name as string;
      if (!map.has(n)) {
        map.set(n, {
          name: n,
          columns: [],
          refTable: r.ref_table as string,
          refColumns: [],
          onUpdate: (r.on_update as string) || undefined,
          onDelete: (r.on_delete as string) || undefined,
        });
      }
      map.get(n)!.columns.push(r.col as string);
      map.get(n)!.refColumns.push(r.ref_col as string);
    }
    return [...map.values()];
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT con.conname AS name,
              array_agg(la.attname ORDER BY ck.conpos) AS cols,
              fc.relname AS ref_table,
              array_agg(fa.attname ORDER BY ck.conpos) AS ref_cols,
              con.confupdtype::text AS on_update,
              con.confdeltype::text AS on_delete
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS ck(attnum, conpos) ON true
       JOIN pg_attribute la ON la.attrelid = t.oid AND la.attnum = ck.attnum
       JOIN pg_class fc ON fc.oid = con.confrelid
       JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS ckf(attnum, conpos2) ON ck.conpos = ckf.conpos2
       JOIN pg_attribute fa ON fa.attrelid = fc.oid AND fa.attnum = ckf.attnum
       WHERE con.contype = 'f' AND n.nspname = $1 AND t.relname = $2
       GROUP BY con.conname, fc.relname, con.confupdtype, con.confdeltype`,
      [schema, table],
    );
    const mapUpd: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      name: r.name as string,
      columns: (r.cols as unknown[]).map(String),
      refTable: r.ref_table as string,
      refColumns: (r.ref_cols as unknown[]).map(String),
      onUpdate: mapUpd[r.on_update as string] ?? (r.on_update as string),
      onDelete: mapUpd[r.on_delete as string] ?? (r.on_delete as string),
    }));
  }
  if (getOracle(connectionId)) return oraListForeignKeys(connectionId, schema, table);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 列出表触发器（表设计器「触发器」子页；PG/MySQL/Oracle 各走系统视图） */
export async function listTriggers(connectionId: string, schema: string, table: string, db?: string): Promise<DbTrigger[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing,
              EVENT_MANIPULATION AS events, ACTION_STATEMENT AS body
       FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
       ORDER BY TRIGGER_NAME`,
      [schema, table],
    )) as [Record<string, unknown>[], unknown[]];
    return rows.map((r) => ({
      name: r.name as string,
      table: r.tbl as string,
      timing: (r.timing as string) || '',
      events: (r.events as string) || '',
      body: (r.body as string) || undefined,
    }));
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT t.tgname AS name, c.relname AS tbl, t.tgtype::int AS tgtype, pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal
       ORDER BY t.tgname`,
      [schema, table],
    );
    return (res.rows as Record<string, unknown>[]).map((r) => {
      const ty = Number(r.tgtype);
      const timing = ty & 2 ? 'BEFORE' : ty & 64 ? 'INSTEAD OF' : 'AFTER';
      const ev: string[] = [];
      if (ty & 4) ev.push('INSERT');
      if (ty & 8) ev.push('DELETE');
      if (ty & 16) ev.push('UPDATE');
      return {
        name: r.name as string,
        table: r.tbl as string,
        timing,
        events: ev.join(' OR '),
        body: (r.def as string) || undefined,
      };
    });
  }
  if (getOracle(connectionId)) return oraListTriggers(connectionId, schema, table);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 获取视图/物化视图定义（视图浏览器：可查看与编辑重建） */
export async function getViewDefinition(connectionId: string, kind: 'view' | 'mview', schema: string, name: string, db?: string): Promise<DbObjectDef> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(`SHOW CREATE VIEW \`${schema.replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``)) as [Record<string, unknown>[], unknown[]];
    const r = rows[0] ?? {};
    return { name, kind, ddl: String(r['Create View'] ?? '') };
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const def = (
      await pgPool.query(`SELECT pg_get_viewdef(format('%I.%I', $1, $2)::regclass, true) AS def`, [schema, name])
    ).rows[0]?.def as string | null;
    const head = kind === 'mview' ? `CREATE OR REPLACE MATERIALIZED VIEW ${quoteIdent(schema)}.${quoteIdent(name)} AS` : `CREATE OR REPLACE VIEW ${quoteIdent(schema)}.${quoteIdent(name)} AS`;
    return { name, kind, ddl: def ? `${head}\n${String(def)}` : head };
  }
  if (getOracle(connectionId)) return oraGetViewDef(connectionId, kind, schema, name);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 获取函数/存储过程定义（函数浏览器） */
export async function getFunctionDefinition(connectionId: string, schema: string, name: string, db?: string): Promise<DbObjectDef> {
  // name 可能带参数签名（PG：name(args)）
  const m = name.match(/^([^(]+)(?:\s*\((.*)\))?$/);
  const bare = (m?.[1] ?? name).trim();
  const args = (m?.[2] ?? '').trim();
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT ROUTINE_DEFINITION AS def, ROUTINE_TYPE AS rtype, DTD_IDENTIFIER AS ret
       FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?`,
      [schema, bare],
    )) as [Record<string, unknown>[], unknown[]];
    const r = rows[0] ?? {};
    const def = String(r.def ?? '');
    const rtype = String(r.rtype ?? 'FUNCTION');
    const ret = r.ret ? ` RETURNS ${r.ret}` : '';
    return { name, kind: 'function', ddl: `CREATE ${rtype} ${quoteIdent(schema)}.${quoteIdent(bare)}${ret}\nBEGIN\n${def}\nEND` };
  }
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const res = args
      ? await pgPool.query(
          `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
           WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3`,
          [schema, bare, args],
        )
      : await pgPool.query(
          `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
           WHERE n.nspname = $1 AND p.proname = $2 LIMIT 1`,
          [schema, bare],
        );
    return { name, kind: 'function', ddl: String((res.rows[0]?.def as string) ?? `-- 未找到函数定义：${name}`) };
  }
  if (getOracle(connectionId)) return oraGetFunctionDef(connectionId, schema, bare);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/** 获取序列信息（序列浏览器：当前值/上下限/步长；MySQL 不支持序列） */
export async function getSequenceInfo(connectionId: string, schema: string, name: string, db?: string): Promise<DbSequenceInfo> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) throw new Error('MySQL 不支持序列对象（使用 AUTO_INCREMENT 自增列替代）');
  const pgPool = getPg(connectionId) ? await getPgPool(connectionId, db) : undefined;
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT min_value, max_value, increment_by, last_value, is_cycled FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`,
      [schema, name],
    );
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) throw new Error(`序列不存在：${schema}.${name}`);
    return {
      name,
      currentValue: r.last_value == null ? null : Number(r.last_value),
      minValue: r.min_value == null ? null : Number(r.min_value),
      maxValue: r.max_value == null ? null : Number(r.max_value),
      increment: r.increment_by == null ? null : Number(r.increment_by),
      cycle: (r.is_cycled as boolean) === true,
    };
  }
  if (getOracle(connectionId)) return oraGetSequenceInfo(connectionId, schema, name);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/**
 * 用户与权限管理：列出全部用户/角色。
 * - PG：pg_roles（排除 pg_ 内置）；
 * - MySQL：mysql.user（account_locked / password_expired / plugin / Super_priv）；
 * - Oracle：DBA_USERS（无权限回退 ALL_USERS 仅用户名）。
 * 跨方言统一为 {@link DbUser}。
 */
export async function listUsers(connectionId: string): Promise<DbUser[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT User, Host, account_locked, password_expired, plugin, Super_priv
       FROM mysql.user ORDER BY User, Host`,
    )) as [Record<string, unknown>[], unknown[]];
    return rows.map((r) => ({
      name: String(r.User ?? ''),
      host: String(r.Host ?? ''),
      locked: String(r.account_locked ?? 'N') === 'Y',
      expired: String(r.password_expired ?? 'N') === 'Y',
      auth: r.plugin ? String(r.plugin) : undefined,
      superuser: String(r.Super_priv ?? 'N') === 'Y',
      canLogin: true,
    }));
  }
  const pgPool = getPg(connectionId);
  if (pgPool) {
    const res = await pgPool.query(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolvaliduntil
       FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`,
    );
    const now = Date.now();
    return (res.rows as Record<string, unknown>[]).map((r) => {
      const valid = r.rolvaliduntil ? new Date(String(r.rolvaliduntil)).getTime() : null;
      return {
        name: String(r.rolname),
        canLogin: (r.rolcanlogin as boolean) === true,
        superuser: (r.rolsuper as boolean) === true,
        createDb: (r.rolcreatedb as boolean) === true,
        expired: valid != null && valid < now,
      };
    });
  }
  if (getOracle(connectionId)) return oraListUsers(connectionId);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/**
 * 用户与权限管理：获取指定用户的权限/授权清单。
 * - PG：角色属性（SUPERUSER/CREATEDB/...）+ 被授予的角色（pg_auth_members）；
 * - MySQL：SHOW GRANTS FOR 'u'@'h'（整行）；
 * - Oracle：DBA_SYS_PRIVS / DBA_ROLE_PRIVS / DBA_TAB_PRIVS（无权限回退 USER_* 仅自身）。
 */
export async function getUserPrivileges(connectionId: string, name: string, host?: string): Promise<DbUserPrivilege[]> {
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const u = assertUserName(name, '用户名');
    const h = (host || '%').replace(/'/g, "''");
    const [rows] = (await mysqlPool.query(`SHOW GRANTS FOR ?@?`, [u, h])) as [Record<string, unknown>[], unknown[]];
    return rows.map((r) => {
      const raw = Object.values(r)[0] != null ? String(Object.values(r)[0]) : '';
      return {
        privilege: raw,
        target: raw.includes('ON *.*') ? '*.*' : raw.includes('ON ') ? raw.split(' ON ')[1]?.replace(/ TO .*$/, '') ?? '' : '',
        grantable: /WITH GRANT OPTION/i.test(raw),
        raw,
      };
    });
  }
  const pgPool = getPg(connectionId);
  if (pgPool) {
    const u = assertUserName(name, '角色名');
    const attrs = await pgPool.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolreplication, rolinherit
       FROM pg_roles WHERE rolname = $1`,
      [u],
    );
    const a = (attrs.rows[0] ?? {}) as Record<string, unknown>;
    const out: DbUserPrivilege[] = [];
    const map: [boolean, string][] = [
      [a.rolsuper as boolean, 'SUPERUSER'],
      [a.rolcreatedb as boolean, 'CREATEDB'],
      [a.rolcreaterole as boolean, 'CREATEROLE'],
      [a.rolcanlogin as boolean, 'LOGIN'],
      [a.rolreplication as boolean, 'REPLICATION'],
      [a.rolinherit as boolean === false, 'NOINHERIT'],
    ];
    for (const [on, priv] of map) if (on) out.push({ privilege: priv, target: '全局' });
    const mem = await pgPool.query(
      `SELECT r.rolname AS role FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.roleid
       WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = $1) ORDER BY r.rolname`,
      [u],
    );
    for (const r of mem.rows as Record<string, unknown>[]) out.push({ privilege: String(r.role), target: 'ROLE' });
    return out;
  }
  if (getOracle(connectionId)) return oraGetUserPrivileges(connectionId, name);
  throw new Error('该连接不是数据库类型或未建立连接');
}

/**
 * 用户与权限管理：修改用户权限（差量，按方言执行不同语句）。
 * - PG：属性开关 → ALTER ROLE ... WITH [NO]XXX；成员角色 → GRANT/REVOKE role TO/FROM user；
 * - MySQL：全局权限差量 → GRANT privs ON *.* TO 'u'@'h' [WITH GRANT OPTION] / REVOKE priv ON *.* FROM 'u'@'h'；
 * - Oracle：系统权限/角色差量 → GRANT/REVOKE "priv[,priv]" TO/FROM "u"。
 */
export async function updateUserPrivileges(connectionId: string, name: string, host: string | undefined, edit: DbUserPrivEdit): Promise<void> {
  const u = assertUserName(name, '用户名');
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const h = (host || '%').replace(/'/g, "''");
    const target = `'${u}'@'${h}'`;
    for (const p of edit.revokePrivs ?? []) {
      if (/^GRANT OPTION$/i.test(p)) await mysqlPool.query(`REVOKE GRANT OPTION ON *.* FROM ${target}`);
      else await mysqlPool.query(`REVOKE ${assertSafeIdent(p, '权限名')} ON *.* FROM ${target}`);
    }
    if (edit.grantPrivs?.length) {
      const privs = edit.grantPrivs.map((p) => assertSafeIdent(p, '权限名')).join(', ');
      await mysqlPool.query(`GRANT ${privs} ON *.* TO ${target}${edit.grantOption ? ' WITH GRANT OPTION' : ''}`);
    }
    return;
  }
  const pgPool = getPg(connectionId);
  if (pgPool) {
    const q = `"${u.replace(/"/g, '""')}"`;
    const a = edit.attrs ?? {};
    const opts: string[] = [];
    if (a.login !== undefined) opts.push(a.login ? 'LOGIN' : 'NOLOGIN');
    if (a.superuser !== undefined) opts.push(a.superuser ? 'SUPERUSER' : 'NOSUPERUSER');
    if (a.createDb !== undefined) opts.push(a.createDb ? 'CREATEDB' : 'NOCREATEDB');
    if (a.createRole !== undefined) opts.push(a.createRole ? 'CREATEROLE' : 'NOCREATEROLE');
    if (a.replication !== undefined) opts.push(a.replication ? 'REPLICATION' : 'NOREPLICATION');
    if (a.inherit !== undefined) opts.push(a.inherit ? 'INHERIT' : 'NOINHERIT');
    if (opts.length) await pgPool.query(`ALTER ROLE ${q} WITH ${opts.join(' ')}`);
    for (const r of edit.grantRoles ?? []) await pgPool.query(`GRANT "${r.replace(/"/g, '""')}" TO ${q}`);
    for (const r of edit.revokeRoles ?? []) await pgPool.query(`REVOKE "${r.replace(/"/g, '""')}" FROM ${q}`);
    return;
  }
  if (getOracle(connectionId)) {
    const pool = getOracle(connectionId)!;
    const conn = await pool.getConnection();
    try {
      const q = `"${u}"`;
      if (edit.revokePrivs?.length) {
        const privs = edit.revokePrivs.map((p) => `"${assertSafeIdent(p, '权限名')}"`).join(', ');
        await conn.execute(`REVOKE ${privs} FROM ${q}`, [], { autoCommit: true });
      }
      if (edit.grantPrivs?.length) {
        const privs = edit.grantPrivs.map((p) => `"${assertSafeIdent(p, '权限名')}"`).join(', ');
        await conn.execute(`GRANT ${privs} TO ${q}`, [], { autoCommit: true });
      }
      return;
    } finally {
      await conn.close();
    }
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/**
 * 用户与权限管理：新建用户（按方言差异化）。
 * - PG：CREATE ROLE ... WITH [SUPERUSER] [CREATEDB] [LOGIN] PASSWORD '...'；
 * - MySQL：CREATE USER 'u'@'h' IDENTIFIED BY '...'，superuser 额外 GRANT ALL PRIVILEGES ON *.*；
 * - Oracle：CREATE USER ... IDENTIFIED BY ... [DEFAULT TABLESPACE]，基础 CONNECT/RESOURCE，superuser 授 DBA。
 */
export async function createUser(connectionId: string, spec: DbUserSpec): Promise<void> {
  const name = assertUserName(spec.name, '用户名');
  if (!spec.password || !spec.password.trim()) throw new Error('口令不能为空');
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const h = (spec.host || '%').replace(/'/g, "''");
    await mysqlPool.query(`CREATE USER ?@? IDENTIFIED BY ?`, [name, h, spec.password]);
    if (spec.superuser) {
      await mysqlPool.query(`GRANT ALL PRIVILEGES ON *.* TO ?@? WITH GRANT OPTION`, [name, h]);
    }
    return;
  }
  const pgPool = getPg(connectionId);
  if (pgPool) {
    const opts: string[] = [];
    if (spec.canLogin !== false) opts.push('LOGIN');
    if (spec.superuser) opts.push('SUPERUSER');
    if (spec.createDb) opts.push('CREATEDB');
    // PG 角色名/口令：双引号转义；PG 工具语句（CREATE ROLE）不支持绑定参数，口令须内联（单引号成对转义防注入）
    const pgPwd = spec.password.replace(/'/g, "''");
    await pgPool.query(
      `CREATE ROLE "${name.replace(/"/g, '""')}"${opts.length ? ` WITH ${opts.join(' ')}` : ''} PASSWORD '${pgPwd}'`,
    );
    return;
  }
  if (getOracle(connectionId)) {
    await oraCreateUser(connectionId, { name, password: spec.password, superuser: spec.superuser, tablespace: spec.tablespace });
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}

/**
 * 用户与权限管理：删除用户。
 * - PG：DROP ROLE；
 * - MySQL：DROP USER 'u'@'h'（host 缺省 %）；
 * - Oracle：DROP USER ... CASCADE。
 */
export async function dropUser(connectionId: string, name: string, host?: string): Promise<void> {
  const un = assertUserName(name, '用户名');
  const mysqlPool = getMysql(connectionId);
  if (mysqlPool) {
    const h = (host || '%').replace(/'/g, "''");
    await mysqlPool.query(`DROP USER ?@?`, [un, h]);
    return;
  }
  const pgPool = getPg(connectionId);
  if (pgPool) {
    await pgPool.query(`DROP ROLE "${un.replace(/"/g, '""')}"`);
    return;
  }
  if (getOracle(connectionId)) {
    await oraDropUser(connectionId, un);
    return;
  }
  throw new Error('该连接不是数据库类型或未建立连接');
}
