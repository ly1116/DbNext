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


