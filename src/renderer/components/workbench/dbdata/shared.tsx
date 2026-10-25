export function fmtBytes(n?: number): string {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 数字千分位格式化（行数等） */
export function fmtNum(n?: number): string {
  if (n == null || isNaN(n)) return '';
  return n.toLocaleString('en-US');
}

/** 从 SQL 提取来源表名（导出文件名 / 结果条来源标签共用）；无 FROM/INTO/UPDATE 时回退 query_result */
export function sqlSourceTable(sql: string): string {
  return sql.match(/(?:from|into|update)\s+(`?[\w$]+`?(?:\s*\.\s*`?[\w$]+`?)?)/i)?.[1]?.replace(/[`"\s]/g, '') || 'query_result';
}

/** 是否展示存储类列（行数/大小/引擎）：视图无存储，不展示 */
export function hasStorage(kind: 'table' | 'view' | 'mview'): boolean {
  return kind !== 'view';
}

/** 对象图标片配色：按名称哈希从柔和色板取色（同一对象颜色固定） */
export const OBJ_HUES = ['59 130 246', '139 92 246', '14 165 233', '22 163 74', '217 119 6', '225 29 72', '20 184 166'];
export function objHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return OBJ_HUES[h % OBJ_HUES.length];
}

/** 对象清单筛选关键字缓存（按标签 id）：切换标签页 / 右键刷新重挂载后恢复，不清空（会话内有效） */
export const objFilterCache = new Map<string, string>();

export const EMPTY_EDITS: Record<string, string> = {};
export const EMPTY_SET_NUM = new Set<number>();
export const EMPTY_SET_STR = new Set<string>();

/** 触发浏览器下载（查询结果 / 表数据导出共用） */
export function downloadFile(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 日期/时间格式化（本地时区 → YYYY-MM-DD HH:MM:SS；纯 date 仅日期）；供 sqlLiteral 复用 */
function fmtDateValue(d: Date, dataType?: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = p(d.getMonth() + 1);
  const da = p(d.getDate());
  const hh = p(d.getHours());
  const mm = p(d.getMinutes());
  const ss = p(d.getSeconds());
  const t = (dataType ?? '').toLowerCase();
  if (/^date(?!time)/.test(t) || /time/.test(t) === false) {
    // 纯日期列只取日期部分
    if (/^date$/.test(t)) return `${y}-${mo}-${da}`;
  }
  return `${y}-${mo}-${da} ${hh}:${mm}:${ss}`;
}

/**
 * SQL 字面量生成（表数据页 / 查询结果页提交共用）：
 * - Date：先格式化为本地时区 YYYY-MM-DD HH:MM:SS，再按字符串字面量加引号，避免 Date.toString() 污染 SQL
 * - 空值 → NULL；数字类型原样输出（超长 bigint 不经 Number 转换，避免精度丢失）；其余加单引号并转义
 */
export function sqlLiteral(dataType: string, raw: unknown): string {
  if (raw instanceof Date) {
    const s = Number.isNaN(raw.getTime()) ? '' : fmtDateValue(raw, dataType);
    return s ? `'${s.replace(/'/g, "''")}'` : 'NULL';
  }
  const v = raw == null ? '' : String(raw).trim();
  if (v === '') return 'NULL';
  const numeric = /int|decimal|float|double|numeric|real|serial|money|smallint|tinyint|year/i.test(dataType);
  if (numeric) {
    if (/^[+-]?\d+$/.test(v)) return v.replace(/^[+]/, '');
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  return `'${v.replace(/'/g, "''")}'`;
}

/** 编辑态 → 写 SQL 生成（纯函数，表数据页与查询结果页共用）。键约定：edits 以 `${ri}::${col}` 为键，ri 为展示行索引 */
export function buildChangeStatements(params: {
  q: (name: string) => string;
  qTable: string;
  columns: { name: string; dataType?: string }[];
  pkCols: string[];
  baseRows: Record<string, unknown>[];
  edits: Record<string, string>;
  deleted: Set<number>;
  newRows: Record<string, string>[];
}): string[] {
  const { q, qTable, columns, pkCols, baseRows, edits, deleted, newRows } = params;
  const colType = (c: string) => columns.find((x) => x.name === c)?.dataType ?? '';
  const stmts: string[] = [];
  // 编辑：按基础行分组（已删除的行不生成 UPDATE）
  const byRow = new Map<number, Record<string, string>>();
  for (const [k, v] of Object.entries(edits)) {
    const [riStr, col] = k.split('::');
    const ri = Number(riStr);
    if (deleted.has(ri)) continue;
    if (!byRow.has(ri)) byRow.set(ri, {});
    byRow.get(ri)![col] = v;
  }
  for (const [ri, cols] of byRow) {
    const row = baseRows[ri];
    if (!row) continue;
    const sets = Object.entries(cols).map(([col, val]) => `${q(col)} = ${sqlLiteral(colType(col), val)}`).join(', ');
    const wheres = pkCols.map((pk) => `${q(pk)} = ${sqlLiteral(colType(pk), row[pk])}`).join(' AND ');
    stmts.push(`UPDATE ${qTable} SET ${sets} WHERE ${wheres}`);
  }
  for (const nr of newRows) {
    const keys = Object.keys(nr).filter((k) => (nr[k] ?? '').trim() !== '');
    if (keys.length === 0) continue;
    const cols = keys.map((k) => q(k)).join(', ');
    const vals = keys.map((k) => sqlLiteral(colType(k), nr[k])).join(', ');
    stmts.push(`INSERT INTO ${qTable} (${cols}) VALUES (${vals})`);
  }
  for (const ri of deleted) {
    const row = baseRows[ri];
    if (!row) continue;
    const wheres = pkCols.map((pk) => `${q(pk)} = ${sqlLiteral(colType(pk), row[pk])}`).join(' AND ');
    stmts.push(`DELETE FROM ${qTable} WHERE ${wheres}`);
  }
  return stmts;
}


