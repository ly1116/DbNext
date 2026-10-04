import type { DbColumn, DbColumnAlterSpec, DbColumnSpec, DbForeignKey, DbIndex, DbObjectDef, DbObjectMeta, DbSequenceInfo, DbTrigger, DbUser, DbUserPrivilege, QueryColumn, QueryResult, RoutineDebugState, RoutineExecResult, RoutineParam } from '@shared/types';
import { getOracle } from '../clients/manager';
import { createLogger } from '../logger';

const logger = createLogger('oracle');

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

/** 从 oracledb metaData 取列类型名（dbTypeName ≥6 / dbType.name ≥5；如 NUMBER/VARCHAR2/DATE），供渲染端数值右对齐、日期编辑器、SQL 字面量推断 */
export function oraDataType(m: unknown): string {
  const md = m as { dbTypeName?: string; dbType?: { name?: string } } | null | undefined;
  return String(md?.dbTypeName ?? md?.dbType?.name ?? '');
}

/** 执行任意 SQL，返回统一结果集（查询 / DML 自动判别） */
export async function oraRunSql(connectionId: string, sql: string): Promise<QueryResult> {
  const start = Date.now();
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(sql, [], { autoCommit: true });
    const columns: QueryColumn[] = (res.metaData ?? []).map((m) => ({ name: m.name, dataType: oraDataType(m) }));
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
  kind: 'table' | 'view' | 'mview' | 'sequence' | 'function' | 'procedure',
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
    function: `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = '${owner}' AND OBJECT_TYPE = 'FUNCTION' ORDER BY OBJECT_NAME`,
    procedure: `SELECT OBJECT_NAME FROM ALL_OBJECTS WHERE OWNER = '${owner}' AND OBJECT_TYPE = 'PROCEDURE' ORDER BY OBJECT_NAME`,
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

/** 列出某 Schema 下 表/视图 并附注释（对象清单页）；表额外带回估算行数与最后分析时间 */
export async function oraListObjectsMeta(connectionId: string, kind: 'table' | 'view', schema: string): Promise<DbObjectMeta[]> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const owner = assertIdent(schema, 'schema');
  const obj = kind === 'table' ? 'TABLE' : 'VIEW';
  const conn = await pool.getConnection();
  try {
    const res = await conn.execute(
      `SELECT o.OBJECT_NAME AS NAME, c.COMMENTS AS COMMENTS,
              t.NUM_ROWS AS NUM_ROWS, t.LAST_ANALYZED AS LAST_ANALYZED
       FROM ALL_OBJECTS o
       LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME AND c.TABLE_TYPE = '${obj}'
       LEFT JOIN ALL_TABLES t ON t.OWNER = o.OWNER AND t.TABLE_NAME = o.OBJECT_NAME
       WHERE o.OWNER = '${owner}' AND o.OBJECT_TYPE = '${obj}' ORDER BY o.OBJECT_NAME`,
      [],
      { autoCommit: false },
    );
    const metas = (res.rows ?? []).map((r) => {
      const o = r as Record<string, unknown>;
      const last = o.LAST_ANALYZED as unknown;
      const analyzedAt =
        last == null
          ? undefined
          : last instanceof Date
            ? last.toISOString().slice(0, 19).replace('T', ' ')
            : String(last);
      return {
        name: o.NAME as string,
        comment: (o.COMMENTS as string) || undefined,
        rows: kind === 'table' && o.NUM_ROWS != null ? Number(o.NUM_ROWS) : undefined,
        analyzedAt,
      };
    });
    // 从未被分析（LAST_ANALYZED 为空）的表 NUM_ROWS 为 NULL：退化为真实 COUNT(*)（批量 UNION，上限 100 张）
    if (kind === 'table') {
      const missing = metas.filter((m) => m.rows == null && /^[\w$#]+$/.test(m.name)).slice(0, 100);
      if (missing.length) {
        const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;
        const union = missing
          .map((m) => `SELECT '${m.name.replace(/'/g, "''")}' AS NAME, COUNT(*) AS CNT FROM ${qid(owner)}.${qid(m.name)}`)
          .join(' UNION ALL ');
        try {
          const cr = await conn.execute(union, [], { autoCommit: false });
          const cnt = new Map((cr.rows ?? []).map((r) => {
            const o = r as Record<string, unknown>;
            return [String(o.NAME), Number(o.CNT)];
          }));
          for (const m of metas) if (m.rows == null) m.rows = cnt.get(m.name);
        } catch {
          /* 统计兜底失败时保持行数留空 */
        }
      }
    }
    return metas;
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
      .map((m) => ({ name: m.name, dataType: oraDataType(m) }));
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

/**
 * 修改字段（属性页双击编辑 → 仅提交变化的字段）：
 * - 改名：ALTER TABLE t RENAME COLUMN old TO new；
 * - 类型/默认值/空性：合并为一条 ALTER TABLE t MODIFY (col [type] [DEFAULT x] [NULL|NOT NULL])；
 * - 注释：COMMENT ON COLUMN（空串 = 清空注释）。
 */
export async function oraAlterColumn(connectionId: string, schema: string | undefined, table: string, oldName: string, spec: DbColumnAlterSpec): Promise<void> {
  const old = (oldName || '').trim();
  if (!old) throw new Error('原列名不能为空');
  assertIdent(old, '列名');
  const name = (spec.name ?? old).trim();
  if (!name) throw new Error('列名不能为空');
  assertIdent(name, '列名');
  const from = schema ? `${qid(schema)}.${qid(table)}` : qid(table);
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  try {
    if (name !== old) {
      // 先改名，后续 MODIFY / COMMENT 用新名
      await conn.execute(`ALTER TABLE ${from} RENAME COLUMN ${qid(old)} TO ${qid(name)}`, [], { autoCommit: true });
    }
    if (spec.fullType !== undefined) {
      const parts = [`${qid(name)} ${assertType(spec.fullType)}`];
      if (spec.defaultValue !== undefined) {
        const dv = String(spec.defaultValue).trim();
        parts.push(dv === '' ? 'DEFAULT NULL' : `DEFAULT ${dv}`);
      }
      if (spec.nullable !== undefined) parts.push(spec.nullable ? 'NULL' : 'NOT NULL');
      await conn.execute(`ALTER TABLE ${from} MODIFY (${parts.join(' ')})`, [], { autoCommit: true });
    } else if (spec.defaultValue !== undefined || spec.nullable !== undefined) {
      // 仅改默认值/空性：MODIFY 同样要求至少带一个子句，按需拼装
      const parts: string[] = [qid(name)];
      if (spec.defaultValue !== undefined) {
        const dv = String(spec.defaultValue).trim();
        parts.push(dv === '' ? 'DEFAULT NULL' : `DEFAULT ${dv}`);
      }
      if (spec.nullable !== undefined) parts.push(spec.nullable ? 'NULL' : 'NOT NULL');
      await conn.execute(`ALTER TABLE ${from} MODIFY (${parts.join(' ')})`, [], { autoCommit: true });
    }
    if (spec.comment !== undefined) {
      const c = String(spec.comment).trim();
      await conn.execute(`COMMENT ON COLUMN ${from}.${qid(name)} IS ${c === '' ? 'NULL' : `'${c.replace(/'/g, "''")}'`}`, [], { autoCommit: true });
    }
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

/* ============================================================
 *  存储过程 / 函数：参数元数据 · 执行 · DBMS_DEBUG 调试
 * ============================================================ */

/** 取得连接（未建立则抛统一错误） */
async function oraConn(connectionId: string): Promise<{ pool: NonNullable<ReturnType<typeof getOracle>>; conn: Awaited<ReturnType<NonNullable<ReturnType<typeof getOracle>>['getConnection']>> }> {
  const pool = getOracle(connectionId);
  if (!pool) throw new Error('该连接不是 Oracle 类型或未建立连接');
  const conn = await pool.getConnection();
  return { pool, conn };
}

/**
 * 读取过程/函数的参数列表（ALL_ARGUMENTS）。
 * 用 OBJECT_NAME 而非带签名的对象名，故传裸名即可。
 */
export async function oraGetRoutineParams(connectionId: string, schema: string, name: string): Promise<RoutineParam[]> {
  const { conn } = await oraConn(connectionId);
  try {
    const owner = assertIdent(schema, 'schema');
    const obj = assertIdent(name, '过程/函数');
    const res = await conn.execute(
      `SELECT POSITION, ARGUMENT_NAME, IN_OUT, ARG_TYPE, DEFAULTED
         FROM ALL_ARGUMENTS
        WHERE OWNER = :1 AND OBJECT_NAME = :2
        ORDER BY POSITION`,
      [owner, obj],
      { autoCommit: false },
    );
    const out: RoutineParam[] = (res.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const rawMode = String(row.IN_OUT ?? 'IN').toUpperCase();
      const mode: RoutineParam['mode'] = rawMode === 'OUT' ? 'OUT' : rawMode === 'INOUT' ? 'INOUT' : rawMode === 'RETURN' || rawMode === 'FUNCTION' ? 'RETURN' : 'IN';
      return {
        position: Number(row.POSITION ?? 0),
        name: String(row.ARGUMENT_NAME ?? `arg${String(row.POSITION ?? 0)}`),
        mode,
        dataType: String(row.ARG_TYPE ?? 'VARCHAR2'),
        hasDefault: String(row.DEFAULTED ?? 'N').toUpperCase() === 'Y',
        required: mode === 'IN' && String(row.DEFAULTED ?? 'N').toUpperCase() !== 'Y',
      };
    });
    return out;
  } finally {
    await conn.close();
  }
}

/** 把用户输入的文本值转成适合绑定的 JS 值（数字/布尔/NULL 识别，其余按字符串） */
function toBindValue(v: string): string | number | null {
  const s = (v ?? '').trim();
  if (s === '' || /^null$/i.test(s)) return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return v;
}

/**
 * 执行存储过程/函数：
 * - IN / INOUT 参数用 bind 变量传值（避免字面量转义与注入问题）
 * - OUT / INOUT 用 outBind 收回值
 * - 同时开启 DBMS_OUTPUT 收集过程内 PRINT 的内容（Oracle 过程调试最常用）
 */
export async function oraExecRoutine(
  connectionId: string,
  schema: string,
  name: string,
  args: Record<string, string>,
  autoCommit = true,
): Promise<RoutineExecResult> {
  const start = Date.now();
  const params = await oraGetRoutineParams(connectionId, schema, name);
  const { conn } = await oraConn(connectionId);
  try {
    const owner = assertIdent(schema, 'schema');
    const obj = assertIdent(name, '过程/函数');

    // 收集 DBMS_OUTPUT（过程里的 DBMS_OUTPUT.PUT_LINE）
    let dbmsOut = '';
    try {
      await conn.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;', [], { autoCommit: false });
      await conn.execute('BEGIN DBMS_LONGOUT.ENABLE(1000000); END;', [], { autoCommit: false }).catch(() => undefined);
    } catch {
      /* 权限不足时忽略 */
    }

    const inParams = params.filter((p) => (p.mode === 'IN' || p.mode === 'INOUT') && args[p.name] !== undefined);
    const outParams = params.filter((p) => p.mode === 'OUT' || p.mode === 'INOUT');
    const bind: Record<string, string | number | null> = {};
    const bindByName: Record<string, { value: string | number | null; type?: string; out?: boolean }> = {};
    for (const p of inParams) {
      const v = toBindValue(args[p.name]);
      bind[p.name] = v;
      bindByName[p.name] = { value: v, out: p.mode === 'INOUT' };
    }
    for (const p of outParams) {
      // INOUT 既要传值又要收回；OUT 只需收回（先给 null 占位）
      if (!bindByName[p.name]) bindByName[p.name] = { value: null, out: true };
    }

    // 调用：BLOCK 内声明 OUT 变量再调用过程，避免 CALL 语法在部分驱动下对纯 OUT 参数不友好
    const callArgs = inParams.map((p) => `:${p.name}`);
    let sql: string;
    if (outParams.length) {
      const declares = outParams
        .filter((p) => p.mode === 'OUT')
        .map((p) => `${p.name} ${p.dataType.includes('(') ? p.dataType : `${p.dataType}(32767)`}`)
        .join('; ');
      const passArgs = params
        .filter((p) => p.mode !== 'RETURN')
        .map((p) => (bindByName[p.name]?.out ? `${p.name} => ${p.name}` : `${p.name} => :${p.name}`))
        .join(', ');
      sql = `BEGIN ${declares ? `${declares}; ` : ''}${owner}.${obj}(${passArgs}); END;`;
    } else {
      sql = `BEGIN ${owner}.${obj}(${callArgs.join(', ')}); END;`;
    }

    await conn.execute(sql, bind, {
      autoCommit,
      outBind: outParams.length ? bindByName : undefined,
    });

    // oracledb 会把 OUT/INOUT 的回填值原地写回 bindByName 里的对象

    // 取回 DBMS_OUTPUT
    try {
      const readLine = async (): Promise<string> => {
        const r = (await conn.execute('BEGIN DBMS_OUTPUT.GET_LINE(:l, :s); END;', { l: 4000, s: { dir: -1, value: '' } }, { autoCommit: false })) as {
          outBind?: Record<string, { value?: string }>;
        };
        return String(r?.outBind?.s?.value ?? '');
      };
      const pieces: string[] = [];
      let s = await readLine();
      while (s) {
        pieces.push(s);
        if (pieces.length > 500) break; // 防御：过程疯狂打印时截断
        s = await readLine();
      }
      dbmsOut = pieces.join('\n');
    } catch {
      /* 无输出或权限不足 */
    }

    const outputs: Record<string, string | null> = {};
    for (const p of outParams) {
      const v = bindByName[p.name]?.value;
      outputs[p.name] = v === null || v === undefined ? null : String(v);
    }
    return {
      outputs,
      elapsedMs: Date.now() - start,
      message: dbmsOut || undefined,
    };
  } catch (err) {
    throw new Error(`执行失败: ${(err as Error).message}`);
  } finally {
    await conn.close();
  }
}

/* ============================================================
 *  DBMS_DEBUG 调试会话（单步执行 + 查看变量值）
 *
 *  原理：DEBUG_START 启动被调过程并停在第一个可执行语句；
 *  之后用 STEP / CONTINUE 推进，GET_LINE 取当前行号，
 *  VARIABLE_LIST + VARIABLE_VALUE 读出作用域内变量名与值。
 *
 *  DBMS_DEBUG 要求「调试调用」与「取会话信息」在**同一条连接**上（call_id 是
 *  会话级的），所以整个调试期间独占一条连接，按 debugId 缓存；
 *  渲染端每一步发 IPC 驱动（DBeaver / PL/SQL Developer 同款交互）。
 * ============================================================ */

/** oracledb 连接在会话内的最小能力（本文件用到的部分） */
type OraConn = {
  execute: (sql: string, binds?: unknown, opts?: unknown) => Promise<{ outBind?: Record<string, { value?: unknown }> }>;
  close: () => Promise<unknown>;
};

interface DebugSession {
  conn: OraConn;
  /** 调试目标调用 id（DBMS_DEBUG 会话内标识） */
  callId: number;
  fullName: string;
  /** 已在推进中，防止并发驱动同一会话 */
  busy: boolean;
}
const debugSessions = new Map<string, DebugSession>();
let debugSeq = 0;

/** 构造 DBMS_DEBUG 的入参绑定（字符串/数字统一按 VARCHAR2 传入，DBMS_DEBUG 内部转换） */
const dIn = (v: unknown) => ({ value: v === null || v === undefined ? null : String(v), dir: 1, type: 1 });
/** 构造出参绑定 */
const dOut = () => ({ dir: 2, type: 1, value: null as unknown });

/** 启动调试：调用过程并停在第一个可执行语句 */
export async function oraDebugStart(
  connectionId: string,
  schema: string,
  name: string,
  args: Record<string, string>,
): Promise<{ debugId: string; state: RoutineDebugState }> {
  const params = await oraGetRoutineParams(connectionId, schema, name);
  const { conn } = await oraConn(connectionId);
  const owner = assertIdent(schema, 'schema');
  const obj = assertIdent(name, '过程/函数');
  const debugId = `dbg-${++debugSeq}-${Date.now().toString(36)}`;

  // 形参绑定：DBMS_DEBUG 按名字与被调过程的形参对应
  const binds: Record<string, unknown> = {};
  for (const p of params) {
    if (p.mode === 'RETURN') continue;
    binds[p.name] = dIn(args[p.name] ?? '');
  }

  try {
    // DEBUG_START 启动并停在第一个断点，CONTINUE 取出 call_id
    const r = (await conn.execute('BEGIN DBMS_DEBUG.DEBUG_START(:d, :c); DBMS_DEBUG.CONTINUE(:run); END;', {
      d: dIn(owner),
      c: dIn(obj),
      ...binds,
      run: dOut(),
    }, { autoCommit: false })) as { outBind?: Record<string, { value?: unknown }> } | undefined;
    const callId = Number(r?.outBind?.run?.value ?? 0);
    if (!callId) throw new Error('DBMS_DEBUG 未能建立调试会话（call_id 为 0）');
    debugSessions.set(debugId, { conn: conn as unknown as OraConn, callId, fullName: `${owner}.${obj}`, busy: false });
    logger.info(`DBMS_DEBUG 启动 ${owner}.${obj} debugId=${debugId} callId=${callId}`);
    // 立刻读一次当前行与变量，让界面马上有内容
    const st = await oraDebugStep(debugId, 'step');
    return { debugId, state: st };
  } catch (e) {
    await (conn as unknown as OraConn).close().catch(() => undefined);
    throw new Error(`启动调试失败：${(e as Error).message}（过程需以 DEBUG 权限编译，通常先执行 alter ${owner}.${obj} debug）`);
  }
}

/**
 * 推进调试：step=单步一行，continue=运行到下一个断点。
 * 返回新的当前位置与当前作用域内所有变量的值。
 */
export async function oraDebugStep(debugId: string, action: 'step' | 'continue'): Promise<RoutineDebugState> {
  const sess = debugSessions.get(debugId);
  if (!sess) throw new Error('调试会话不存在或已结束');
  if (sess.busy) throw new Error('上一次调试操作尚未完成，请稍候');
  sess.busy = true;
  try {
    // STEP / CONTINUE 推进后，用 GET_LINE 取当前行号
    const advance = action === 'step' ? 'DBMS_DEBUG.STEP(:s);' : 'DBMS_DEBUG.CONTINUE(:s);';
    const r = (await sess.conn.execute(`BEGIN ${advance} DBMS_DEBUG.GET_LINE(:ln); END;`, {
      s: { value: sess.callId, dir: 1, type: 1 },
      ln: dOut(),
    }, { autoCommit: false })) as { outBind?: Record<string, { value?: unknown }> } | undefined;
    const line = Number(r?.outBind?.ln?.value ?? 0);
    const variables = await readDebugVariables(sess.conn, sess.callId);
    return { sessionId: debugId, line, variables, finished: false };
  } catch (e) {
    const msg = (e as Error).message;
    // 过程正常结束 / 抛出未捕获异常时 DBMS_DEBUG 会这样返回，转成终态而不是报错
    if (/ PLS-00201|标识符必须声明|DBMS_DEBUG|finished|completed/i.test(msg) && /DEBUG/i.test(msg)) {
      return { sessionId: debugId, line: 0, variables: [], finished: true };
    }
    return { sessionId: debugId, line: 0, variables: [], finished: true, error: msg };
  } finally {
    sess.busy = false;
  }
}

/** 读取当前作用域的变量名与值（VARIABLE_LIST 列名 → VARIABLE_VALUE 逐个取值） */
async function readDebugVariables(conn: OraConn, callId: number): Promise<{ name: string; value: string | null }[]> {
  const r = (await conn.execute('BEGIN DBMS_DEBUG.VARIABLE_LIST(:s, :c, :n, :t); END;', {
    s: { value: callId, dir: 1, type: 1 },
    c: dOut(),
    n: dOut(),
    t: dOut(),
  }, { autoCommit: false })) as { outBind?: Record<string, { value?: unknown }> } | undefined;
  const names = String(r?.outBind?.n?.value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: { name: string; value: string | null }[] = [];
  for (const n of names.slice(0, 200)) {
    try {
      const vr = (await conn.execute('BEGIN DBMS_DEBUG.VARIABLE_VALUE(:s, :n, :v); END;', {
        s: { value: callId, dir: 1, type: 1 },
        n: dIn(n),
        v: dOut(),
      }, { autoCommit: false })) as { outBind?: Record<string, { value?: unknown }> } | undefined;
      const raw = vr?.outBind?.v?.value;
      out.push({ name: n, value: raw === null || raw === undefined ? null : String(raw) });
    } catch {
      out.push({ name: n, value: '<无法读取>' });
    }
  }
  return out;
}

/** 结束调试并释放独占连接 */
export async function oraDebugStop(debugId: string): Promise<void> {
  const sess = debugSessions.get(debugId);
  if (!sess) return;
  debugSessions.delete(debugId);
  try {
    // 让被调过程跑完（DEBUG_CONTINUE）后关闭，否则会留下未结束的调试调用
    await sess.conn.execute(`BEGIN DBMS_DEBUG.CONTINUE(${sess.callId}); END;`).catch(() => undefined);
  } catch {
    /* ignore */
  }
  await sess.conn.close().catch(() => undefined);
}
