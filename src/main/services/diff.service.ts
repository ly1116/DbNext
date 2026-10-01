import type { SchemaDiffItem, SchemaDiffResult } from '@shared/types';
import { createLogger } from '../logger';
import { getMysql, getPg, getMysqlPool, getPgPool } from '../clients/manager';

/**
 * 结构对比服务（真实实现）。
 *
 * 对两个已连接的数据库（mysql / postgres 均可，类型需一致）做真实库内省：
 * 取各自的表清单与列定义，比较「表存在性」与「列增删/类型变化」。
 * PG 支持指定 库（database）+ 模式（schema）：不传时 库=连接配置库、模式=public；
 * 仅统计 BASE TABLE（排除视图/物化视图，避免 PostGIS 系统视图等噪音）。
 *
 * @since 0.1.0
 */
const logger = createLogger('diff');

/** 一侧对比的目标：PG=库+模式；MySQL=库（不传=连接配置的库） */
export interface DiffSideOptions {
  database?: string;
  schema?: string;
}

interface TableMeta {
  columns: Map<string, string>; // column -> dataType
}

/** 内省一侧数据库，返回 表 -> 列类型映射 */
async function introspect(connectionId: string, opts?: DiffSideOptions): Promise<Map<string, TableMeta>> {
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (!mysqlPool && !pgPool) throw new Error('该连接不是数据库类型或未建立连接');

  if (mysqlPool) {
    // 支持跨库：不传 database 时用连接配置库（getMysqlPool 语义：空/同库=主池）
    const pool = await getMysqlPool(connectionId, opts?.database || undefined);
    const [rows] = (await pool.query(
      `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t
         ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    )) as [Record<string, unknown>[], unknown[]];
    return group(rows);
  }
  // PG：指定库（默认连接库）+ 指定模式（默认 public），仅取实体表
  const pool = await getPgPool(connectionId, opts?.database || undefined);
  const schema = (opts?.schema || '').trim() || 'public';
  const res = await pool.query(
    `SELECT c.table_name, c.column_name, c.data_type
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`,
    [schema],
  );
  return group(res.rows as Record<string, unknown>[]);
}

function group(rows: Record<string, unknown>[]): Map<string, TableMeta> {
  const map = new Map<string, TableMeta>();
  for (const r of rows) {
    const t = String(r.TABLE_NAME ?? r.table_name);
    const c = String(r.COLUMN_NAME ?? r.column_name);
    const d = String(r.DATA_TYPE ?? r.data_type);
    if (!map.has(t)) map.set(t, { columns: new Map() });
    map.get(t)!.columns.set(c, d);
  }
  return map;
}

/** 对比两个连接的结构（可分别为两侧指定 库/模式；PG 不传模式默认 public） */
export async function runDiff(
  leftId: string,
  rightId: string,
  leftOpts?: DiffSideOptions,
  rightOpts?: DiffSideOptions,
): Promise<SchemaDiffResult> {
  const [left, right] = await Promise.all([
    introspect(leftId, leftOpts),
    introspect(rightId, rightOpts),
  ]);
  const names = new Set<string>([...left.keys(), ...right.keys()]);
  const items: SchemaDiffItem[] = [];
  for (const name of [...names].sort()) {
    const l = left.get(name);
    const r = right.get(name);
    const changes: string[] = [];
    if (!l) changes.push('右侧存在，左侧缺失该表');
    else if (!r) changes.push('左侧存在，右侧缺失该表');
    else {
      const cols = new Set<string>([...l.columns.keys(), ...r.columns.keys()]);
      for (const col of cols) {
        const lt = l.columns.get(col);
        const rt = r.columns.get(col);
        if (lt && !rt) changes.push(`列 ${col} 仅存在于左侧`);
        else if (!lt && rt) changes.push(`列 ${col} 仅存在于右侧`);
        else if (lt !== rt) changes.push(`列 ${col} 类型不一致：左 ${lt} / 右 ${rt}`);
      }
    }
    items.push({ name, inLeft: !!l, inRight: !!r, changes });
  }
  logger.info(`结构对比完成：${items.length} 个对象，${items.filter((i) => i.changes.length).length} 个有差异`);
  return { items };
}
