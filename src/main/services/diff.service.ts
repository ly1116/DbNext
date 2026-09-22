import type { SchemaDiffItem, SchemaDiffResult } from '@shared/types';
import { createLogger } from '../logger';
import { getMysql, getPg } from '../clients/manager';

/**
 * 结构对比服务（真实实现）。
 *
 * 对两个已连接的数据库（mysql / postgres 均可，类型需一致）做真实库内省：
 * 取各自的表清单与列定义，比较「表存在性」与「列增删/类型变化」。
 *
 * @since 0.1.0
 */
const logger = createLogger('diff');

interface TableMeta {
  columns: Map<string, string>; // column -> dataType
}

/** 内省一侧数据库，返回 表 -> 列类型映射 */
async function introspect(connectionId: string): Promise<Map<string, TableMeta>> {
  const mysqlPool = getMysql(connectionId);
  const pgPool = getPg(connectionId);
  if (!mysqlPool && !pgPool) throw new Error('该连接不是数据库类型或未建立连接');

  if (mysqlPool) {
    const [rows] = (await mysqlPool.query(
      `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    )) as [Record<string, unknown>[], unknown[]];
    return group(rows);
  }
  const res = await pgPool!.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' ORDER BY table_name, ordinal_position`,
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

/** 对比两个连接的结构 */
export async function runDiff(leftId: string, rightId: string): Promise<SchemaDiffResult> {
  const [left, right] = await Promise.all([introspect(leftId), introspect(rightId)]);
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
