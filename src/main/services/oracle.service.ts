import type { DbColumn, DbColumnSpec, DbForeignKey, DbIndex, DbObjectDef, DbObjectMeta, DbSequenceInfo, DbTrigger, DbUser, DbUserPrivilege, QueryColumn, QueryResult } from '@shared/types';
import { getOracle } from '../clients/manager';

/**
 * Oracle 内省 / 执行服务（真实实现，oracledb thin 模式）。
 *
 * Oracle 概念映射到 Navicat 树：
 * - 「数据库」节点 → 用户/Schema（ALL_USERS）；
 * - 「表/视图/序列/函数/存储过程」→ 各用户下的数据字典（ALL_TABLES / ALL_VIEWS / …）；
 * - 连接串：SID 优先，否则 database 作服务名（已在 manager 构造）。
 *
 * Oracle 列名默认大写；CLOB 已在 manager 全局设为以字符串读取。
 *
 * @since 0.1.0
 */

function assertIdent(v: string, field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(v)) throw new Error(`非法${field}：${v}`);
  return v;
}

function assertType(t: string): string {
  const s = (t || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_ ]*(\s*\(\s*\d+(\s*,\s*\d+)?\s*\))?$/.test(s)) {
    throw new Error(`不支持的列类型：${t}（示例：VARCHAR2(64) / NUMBER / DATE）`);
  }
  return s;
}

function qid(n: string): string {
  return `"${assertIdent(n, '标识符').replace(/"/g, '""')}"`;
}

/** 执行任意 SQL，返回统一结果集（查询 / DML 自动判别） */
export async function oraRunSql(connectionId: string, sql: string): Promise<QueryResult> {
  const start = Date.now();
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(sql, [], { autoCommit: true });
    const columns: QueryColumn[] = (res.metaData ?? []).map((m) => ({ name: m.name, dataType: '' }));
    const rows = (res.rows ?? []).map((r) => ({ ...(r as Record<string, unknown>) }));
    return {
      columns,
      rows,
      rowCount: res.rowsAffected ?? rows.length,
      elapsedMs: Date.now() - start,
      sql,
      affectedRows: res.rowsAffected ?? undefined,
    };
  } catch (err) {
    throw new Error(`SQL 执行失败: ${(err as Error).message}`);
  } finally {
    await conn.close();
  }
}

/** 列出可访问的用户/Schema（ALL_USERS） */
export async function oraListSchemas(connectionId: string): Promise<string[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute('SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME', [], { autoCommit: false });
    return (res.rows ?? []).map((r) => (r as Record<string, unknown>).USERNAME as string);
  } finally {
    await conn.close();
  }
}

/** 列出某 Schema 下的对象（table/view/mview/sequence/function/procedure） */
export async function oraListObjects(
  connectionId: string,
  kind: 'table' | 'view' | 'mview' | 'sequence' | 'function',
  schema: string,
): Promise<string[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const sqlByKind: Record<typeof kind, string> = {
    table: `SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = '${owner}' ORDER BY TABLE_NAME`,
    view: `SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = '${owner}' ORDER BY VIEW_NAME`,
    mview: `SELECT MVIEW_NAME FROM ALL_MVIEWS WHERE OWNER = '${owner}' ORDER BY MVIEW_NAME`,
    sequence: `SELECT SEQUENCE_NAME FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${owner}' ORDER BY SEQUENCE_NAME`,
    function: `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = '${owner}' AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_NAME`,
  };
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(sqlByKind[kind], [], { autoCommit: false });
    const key =
      kind === 'table' ? 'TABLE_NAME' : kind === 'view' ? 'VIEW_NAME' : kind === 'mview' ? 'MVIEW_NAME' : kind === 'sequence' ? 'SEQUENCE_NAME' : 'OBJECT_NAME';
    return (res.rows ?? []).map((r) => (r as Record<string, unknown>)[key] as string);
  } finally {
    await conn.close();
  }
}

/** 列出某 Schema 下 表/视图 并附注释（对象清单页） */
export async function oraListObjectsMeta(connectionId: string, kind: 'table' | 'view', schema: string): Promise<DbObjectMeta[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const obj = kind === 'table' ? 'TABLE' : 'VIEW';
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT o.OBJECT_NAME AS NAME, c.COMMENTS AS COMMENTS
       FROM ALL_OBJECTS o LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME AND c.TABLE_TYPE = '${obj}'
       WHERE o.OWNER = '${owner}' AND o.OBJECT_TYPE = '${obj}' ORDER BY o.OBJECT_NAME`,
      [],
      { autoCommit: false },
    );
    return (res.rows ?? []).map((r) => {
      const o = r as Record<string, unknown>;
      return { name: o.NAME as string, comment: (o.COMMENTS as string) || undefined };
    });
  } finally {
    await conn.close();
  }
}

/** 列出表字段（ALL_TAB_COLUMNS + 注释） */
export async function oraListColumns(connectionId: string, schema: string, table: string): Promise<DbColumn[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const tbl = assertIdent(table, '表');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.NULLABLE, c.DATA_DEFAULT, cm.COMMENTS
       FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cm ON cm.OWNER = c.OWNER AND cm.TABLE_NAME = c.TABLE_NAME AND cm.COLUMN_NAME = c.COLUMN_NAME
       WHERE c.OWNER = '${owner}' AND c.TABLE_NAME = '${tbl}' ORDER BY c.COLUMN_ID`,
      [],
      { autoCommit: false },
    );
    return (res.rows ?? []).map((r) => {
      const o = r as Record<string, unknown>;
      const dt = (o.DATA_TYPE as string) || 'VARCHAR2';
      const len = o.DATA_LENGTH as number | null;
      const prec = o.DATA_PRECISION as number | null;
      const scale = o.DATA_SCALE as number | null;
      let fullType = dt;
      if (prec != null && scale != null && scale > 0) fullType = `${dt}(${prec},${scale})`;
      else if (prec != null) fullType = `${dt}(${prec})`;
      else if (len != null && /CHAR|RAW/.test(dt)) fullType = `${dt}(${len})`;
      const def = o.DATA_DEFAULT as string | null;
      return {
        name: o.COLUMN_NAME as string,
        dataType: dt,
        nullable: (o.NULLABLE as string) === 'Y',
        ordinal: Number(o.COLUMN_ID),
        fullType,
        defaultValue: def == null ? undefined : String(def).trim(),
        comment: (o.COMMENTS as string) || undefined,
      };
    });
  } finally {
    await conn.close();
  }
}

/** 校验用户输入的原生 WHERE / ORDER BY 片段（拦截多语句分号与 SQL 注释，语义与 MySQL/PG 版 sanitizeFilterFragment 一致） */
function sanitizeOraFragment(kind: 'where' | 'order by', raw: string | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/;/.test(s) || /--/.test(s) || /\/\*/.test(s)) throw new Error(`${kind} 条件中不允许包含分号或 SQL 注释（-- /*）`);
  return s;
}

/** 预览单表数据（ROWNUM 限制；offset>0 或有排序时用 ROWNUM 包子查询翻页（排序在最内层，保证翻页顺序正确），配合前端滚动加载；filter.where/order by 为原生 SQL 片段） */
export async function oraTableData(connectionId: string, schema: string | undefined, table: string, limit = 200, offset = 0, filter?: { where?: string; orderBy?: string }): Promise<QueryResult> {
  const start = Date.now();
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const from = schema ? `${qid(schema)}.${qid(table)}` : qid(table);
  const where = sanitizeOraFragment('where', filter?.where);
  const orderBy = sanitizeOraFragment('order by', filter?.orderBy);
  const whereCl = where ? ` WHERE ${where}` : '';
  const orderCl = orderBy ? ` ORDER BY ${orderBy}` : '';
  const off = Math.max(0, Math.trunc(offset) || 0);
  const lim = Math.max(1, Math.trunc(limit) || 200);
  const sql =
    off > 0 || orderCl
      ? `SELECT * FROM (SELECT sub.*, ROWNUM AS __ROWNUM__ FROM (SELECT * FROM ${from}${whereCl}${orderCl}) sub WHERE ROWNUM <= ${off + lim}) WHERE __ROWNUM__ > ${off}`
      : `SELECT * FROM ${from}${whereCl}${whereCl ? ' AND' : ' WHERE'} ROWNUM <= ${lim}`;
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(sql, [], { autoCommit: false });
    const columns: QueryColumn[] = (res.metaData ?? [])
      .filter((m) => m.name.toUpperCase() !== '__ROWNUM__')
      .map((m) => ({ name: m.name, dataType: '' }));
    const rows = (res.rows ?? []).map((r) => {
      const c = { ...(r as Record<string, unknown>) };
      for (const k of Object.keys(c)) if (k.toUpperCase() === '__ROWNUM__') delete c[k];
      return c;
    });
    return { columns, rows, rowCount: rows.length, elapsedMs: Date.now() - start, sql };
  } catch (err) {
    throw new Error(`SQL 执行失败: ${(err as Error).message}`);
  } finally {
    await conn.close();
  }
}

/** 新增字段（ALTER TABLE ... ADD (col type ...)） */
export async function oraAddColumn(connectionId: string, schema: string | undefined, table: string, col: DbColumnSpec): Promise<void> {
  const name = (col?.name || '').trim();
  if (!name) throw new Error('列名不能为空');
  assertIdent(name, '列名');
  const type = assertType(col?.fullType || '');
  const parts = [`${qid(name)} ${type}`];
  if (!col.nullable) parts.push('NOT NULL');
  if (col.defaultValue != null && String(col.defaultValue).trim() !== '') parts.push(`DEFAULT ${String(col.defaultValue).trim()}`);
  const from = schema ? `${qid(schema)}.${qid(table)}` : qid(table);
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  try {
    await conn.execute(`ALTER TABLE ${from} ADD (${parts.join(' ')})`, [], { autoCommit: true });
    if (col.comment) {
      await conn.execute(`COMMENT ON COLUMN ${from}.${qid(name)} IS '${col.comment.replace(/'/g, "''")}'`, [], { autoCommit: true });
    }
  } finally {
    await conn.close();
  }
}

/** 删除字段（ALTER TABLE ... DROP COLUMN） */
export async function oraDropColumn(connectionId: string, schema: string | undefined, table: string, column: string): Promise<void> {
  const name = (column || '').trim();
  if (!name) throw new Error('列名不能为空');
  const from = schema ? `${qid(schema)}.${qid(table)}` : qid(table);
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  try {
    await conn.execute(`ALTER TABLE ${from} DROP COLUMN ${qid(name)}`, [], { autoCommit: true });
  } finally {
    await conn.close();
  }
}

/** 列出表索引（ALL_INDEXES + ALL_IND_COLUMNS） */
export async function oraListIndexes(connectionId: string, schema: string, table: string): Promise<DbIndex[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const tbl = assertIdent(table, '表');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT i.INDEX_NAME AS name, DECODE(i.UNIQUENESS, 'UNIQUE', 'Y', 'N') AS is_unique,
              LISTAGG(c.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY c.COLUMN_POSITION) AS cols
       FROM ALL_INDEXES i
       JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME
       WHERE i.TABLE_OWNER = '${owner}' AND i.TABLE_NAME = '${tbl}' AND i.INDEX_TYPE != 'LOB'
       GROUP BY i.INDEX_NAME, i.UNIQUENESS
       ORDER BY i.INDEX_NAME`,
      [],
      { autoCommit: false },
    );
    return (res.rows ?? []).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        name: o.INDEX_NAME as string,
        columns: String(o.COLS ?? '').split(',').filter(Boolean),
        unique: (o.IS_UNIQUE as string) === 'Y',
      };
    });
  } finally {
    await conn.close();
  }
}

/** 列出表外键（ALL_CONSTRAINTS 自连接） */
export async function oraListForeignKeys(connectionId: string, schema: string, table: string): Promise<DbForeignKey[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const tbl = assertIdent(table, '表');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT a.CONSTRAINT_NAME AS name,
              LISTAGG(a.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY a.POSITION) AS cols,
              c.TABLE_NAME AS ref_table,
              LISTAGG(b.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY a.POSITION) AS ref_cols,
              c.DELETE_RULE AS on_delete
       FROM ALL_CONSTRAINTS a
       JOIN ALL_CONSTRAINTS c ON c.CONSTRAINT_NAME = a.R_CONSTRAINT_NAME AND c.OWNER = a.R_OWNER
       JOIN ALL_CONS_COLUMNS b ON b.OWNER = c.OWNER AND b.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND b.POSITION = a.POSITION
       WHERE a.CONSTRAINT_TYPE = 'R' AND a.OWNER = '${owner}' AND a.TABLE_NAME = '${tbl}'
       GROUP BY a.CONSTRAINT_NAME, c.TABLE_NAME, c.DELETE_RULE
       ORDER BY a.CONSTRAINT_NAME`,
      [],
      { autoCommit: false },
    );
    return (res.rows ?? []).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        name: o.NAME as string,
        columns: String(o.COLS ?? '').split(',').filter(Boolean),
        refTable: o.REF_TABLE as string,
        refColumns: String(o.REF_COLS ?? '').split(',').filter(Boolean),
        onDelete: (o.ON_DELETE as string) || undefined,
      };
    });
  } finally {
    await conn.close();
  }
}

/** 列出表触发器（ALL_TRIGGERS） */
export async function oraListTriggers(connectionId: string, schema: string, table: string): Promise<DbTrigger[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const tbl = assertIdent(table, '表');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT TRIGGER_NAME AS name, TABLE_NAME AS tbl, TRIGGER_TYPE AS timing,
              TRIGGERING_EVENT AS events, TRIGGER_BODY AS body
       FROM ALL_TRIGGERS
       WHERE OWNER = '${owner}' AND TABLE_NAME = '${tbl}'
       ORDER BY TRIGGER_NAME`,
      [],
      { autoCommit: false },
    );
    return (res.rows ?? []).map((r) => {
      const o = r as Record<string, unknown>;
      const timingRaw = (o.TIMING as string) || '';
      const timing = timingRaw.includes('BEFORE') ? 'BEFORE' : timingRaw.includes('AFTER') ? 'AFTER' : timingRaw.includes('INSTEAD') ? 'INSTEAD OF' : timingRaw;
      return {
        name: o.NAME as string,
        table: o.TBL as string,
        timing,
        events: (o.EVENTS as string) || '',
        body: (o.BODY as string) || undefined,
      };
    });
  } finally {
    await conn.close();
  }
}

/** 获取视图/物化视图定义（DBMS_METADATA.GET_DDL） */
export async function oraGetViewDef(connectionId: string, kind: 'view' | 'mview', schema: string, name: string): Promise<DbObjectDef> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const obj = assertIdent(name, '视图');
  const objType = kind === 'mview' ? 'MATERIALIZED_VIEW' : 'VIEW';
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(`SELECT DBMS_METADATA.GET_DDL('${objType}', '${obj}', '${owner}') AS ddl FROM dual`, [], { autoCommit: false });
    return { name, kind, ddl: String((res.rows?.[0] as Record<string, unknown>)?.DDL ?? '') };
  } finally {
    await conn.close();
  }
}

/** 获取函数/存储过程定义（ALL_SOURCE 拼接；未知 func/proc 时回退到 PROCEDURE） */
export async function oraGetFunctionDef(connectionId: string, schema: string, name: string): Promise<DbObjectDef> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const obj = assertIdent(name, '函数');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${obj}' ORDER BY LINE`,
      [],
      { autoCommit: false },
    );
    const lines = (res.rows ?? []).map((r) => (r as Record<string, unknown>).TEXT as string);
    if (lines.length) return { name, kind: 'function', ddl: lines.join('') };
    // 回退：尝试存储过程
    const res2 = await conn.execute(
      `SELECT DBMS_METADATA.GET_DDL('PROCEDURE', '${obj}', '${owner}') AS ddl FROM dual`,
      [],
      { autoCommit: false },
    );
    return { name, kind: 'function', ddl: String((res2.rows?.[0] as Record<string, unknown>)?.DDL ?? `-- 未找到定义：${name}`) };
  } finally {
    await conn.close();
  }
}

/** 获取序列信息（ALL_SEQUENCES） */
export async function oraGetSequenceInfo(connectionId: string, schema: string, name: string): Promise<DbSequenceInfo> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const obj = assertIdent(name, '序列');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT MIN_VALUE, MAX_VALUE, INCREMENT_BY, LAST_NUMBER, CYCLE_FLAG FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${owner}' AND SEQUENCE_NAME = '${obj}'`,
      [],
      { autoCommit: false },
    );
    const r = res.rows?.[0] as Record<string, unknown> | undefined;
    if (!r) throw new Error(`序列不存在：${owner}.${obj}`);
    const num = (v: unknown) => (v == null ? null : Number(v));
    return {
      name,
      currentValue: num(r.LAST_NUMBER),
      minValue: num(r.MIN_VALUE),
      maxValue: num(r.MAX_VALUE),
      increment: num(r.INCREMENT_BY),
      cycle: (r.CYCLE_FLAG as string) === 'Y',
    };
  } finally {
    await conn.close();
  }
}

/** 列出 Oracle 用户（DBA_USERS 优先，无权限回退 ALL_USERS 仅取用户名） */
export async function oraListUsers(connectionId: string): Promise<DbUser[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  try {
    try {
      const res = await conn.execute(
        `SELECT USERNAME, ACCOUNT_STATUS, CREATED, DEFAULT_TABLESPACE, AUTHENTICATION_TYPE
         FROM DBA_USERS WHERE ORACLE_MAINTAINED = 'N' ORDER BY USERNAME`,
        [],
        { autoCommit: false },
      );
      return (res.rows ?? []).map((r) => {
        const o = r as Record<string, unknown>;
        const status = String(o.ACCOUNT_STATUS ?? '');
        return {
          name: o.USERNAME as string,
          locked: status.includes('LOCKED'),
          created: o.CREATED ? String(o.CREATED) : undefined,
          home: o.DEFAULT_TABLESPACE ? String(o.DEFAULT_TABLESPACE) : undefined,
          auth: o.AUTHENTICATION_TYPE ? String(o.AUTHENTICATION_TYPE) : undefined,
        };
      });
    } catch {
      // 无 DBA 视图权限：仅列用户名
      const res = await conn.execute(`SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME`, [], { autoCommit: false });
      return (res.rows ?? []).map((r) => ({ name: (r as Record<string, unknown>).USERNAME as string }));
    }
  } finally {
    await conn.close();
  }
}

/** 获取 Oracle 用户权限（DBA_* 优先，无权限回退 USER_* 仅查当前用户自身） */
export async function oraGetUserPrivileges(connectionId: string, name: string): Promise<DbUserPrivilege[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const g = assertIdent(name, '用户');
  const conn = await pool.getConnection();
  const out: DbUserPrivilege[] = [];
  try {
    const run = async (sql: string): Promise<Record<string, unknown>[]> => {
      try {
        const res = await conn.execute(sql, [], { autoCommit: false });
        return (res.rows ?? []) as Record<string, unknown>[];
      } catch {
        return [];
      }
    };
    // 系统权限
    for (const r of await run(`SELECT PRIVILEGE, ADMIN_OPTION FROM DBA_SYS_PRIVS WHERE GRANTEE = '${g}'`)) {
      out.push({ privilege: String(r.PRIVILEGE), target: '*.*', grantable: r.ADMIN_OPTION === 'YES' });
    }
    // 角色权限
    for (const r of await run(`SELECT GRANTED_ROLE, ADMIN_OPTION FROM DBA_ROLE_PRIVS WHERE GRANTEE = '${g}'`)) {
      out.push({ privilege: String(r.GRANTED_ROLE), target: 'ROLE', grantable: r.ADMIN_OPTION === 'YES' });
    }
    // 对象权限
    for (const r of await run(
      `SELECT PRIVILEGE, OWNER, TABLE_NAME, GRANTABLE FROM DBA_TAB_PRIVS WHERE GRANTEE = '${g}'`,
    )) {
      out.push({
        privilege: String(r.PRIVILEGE),
        target: `${r.OWNER}.${r.TABLE_NAME}`,
        grantable: r.GRANTABLE === 'YES',
      });
    }
    // 无 DBA 权限时回退：当前用户自身权限
    if (out.length === 0) {
      for (const r of await run(`SELECT PRIVILEGE, ADMIN_OPTION FROM USER_SYS_PRIVS`)) {
        out.push({ privilege: String(r.PRIVILEGE), target: '*.*', grantable: r.ADMIN_OPTION === 'YES' });
      }
      for (const r of await run(`SELECT GRANTED_ROLE, ADMIN_OPTION FROM USER_ROLE_PRIVS`)) {
        out.push({ privilege: String(r.GRANTED_ROLE), target: 'ROLE', grantable: r.ADMIN_OPTION === 'YES' });
      }
    }
    return out;
  } finally {
    await conn.close();
  }
}

/** 新建 Oracle 用户（DEFAULT TABLESPACE + 基础 CONNECT/RESOURCE；superuser 授 DBA） */
export async function oraCreateUser(connectionId: string, spec: { name: string; password?: string; superuser?: boolean; tablespace?: string }): Promise<void> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const u = assertIdent(spec.name, '用户名');
  const pwd = assertIdent(spec.password || spec.name, '口令');
  const ts = spec.tablespace?.trim() ? `${qid(spec.tablespace.trim())}` : 'USERS';
  const conn = await pool.getConnection();
  try {
    await conn.execute(`CREATE USER ${qid(u)} IDENTIFIED BY "${pwd.replace(/"/g, '""')}" DEFAULT TABLESPACE ${ts} QUOTA UNLIMITED ON ${ts}`, [], { autoCommit: true });
    await conn.execute(`GRANT CREATE SESSION, RESOURCE TO ${qid(u)}`, [], { autoCommit: true });
    if (spec.superuser) await conn.execute(`GRANT DBA TO ${qid(u)}`, [], { autoCommit: true });
  } finally {
    await conn.close();
  }
}

/** 删除 Oracle 用户（CASCADE 一并清理其对象） */
export async function oraDropUser(connectionId: string, name: string): Promise<void> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const u = assertIdent(name, '用户名');
  const conn = await pool.getConnection();
  try {
    await conn.execute(`DROP USER ${qid(u)} CASCADE`, [], { autoCommit: true });
  } finally {
    await conn.close();
  }
}
