/**
 * 清洗 Electron IPC 抛出的错误信息：
 * `Error invoking remote method 'sql:alterColumn': error: 原始消息`
 * → `原始消息`（兼容多层前缀与 Error: 大小写变体）。
 */
export function errMsg(e: unknown): string {
  let m = e instanceof Error ? e.message : String(e);
  for (let i = 0; i < 3; i++) {
    const next = m
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^(?:Error|error):\s*/, '')
      .trim();
    if (next === m) break;
    m = next;
  }
  return m || '未知错误';
}
