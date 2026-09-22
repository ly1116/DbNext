import { useEffect, useState } from 'react';
import { DataGrid } from '@renderer/components/common/DataGrid';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox, Loading } from '@renderer/components/common/States';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { QueryResult } from '@shared/types';

/**
 * ③ 数据网格屏幕（真实实现）。
 *
 * 选一条已连接的 MySQL/PostgreSQL，列出真实表名，点表即经 `api.tableData()`
 * 拉取真实行数据并渲染到网格。带加载 / 错误 / 空态。
 *
 * @since 0.1.0
 */
export function DataGridScreen() {
  const selectedId = useConnections((s) => s.selectedId);
  const [connId, setConnId] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (selectedId && !connId) setConnId(selectedId); }, [selectedId, connId]);
  useEffect(() => {
    if (!connId) { setTables([]); return; }
    api.listTables(connId).then(setTables).catch(() => setTables([]));
  }, [connId]);

  const openTable = async (t: string) => {
    if (!connId) return;
    setTable(t); setLoading(true); setError(null);
    try {
      setResult(await api.tableData(connId, undefined, t, 200));
    } catch (e) {
      setError((e as Error).message); setResult(null);
    } finally { setLoading(false); }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="text-dim">表</span>
        <ConnectionPicker kind={['mysql', 'postgres']} value={connId} onChange={(id) => { setConnId(id); setTable(null); setResult(null); }} placeholder="选择数据库…" />
        {table && <span className="text-dim2">· {table}</span>}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-[248px] shrink-0 overflow-y-auto border-r border-line bg-panel py-1 text-[12px] mono">
          <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-dim">表 ({tables.length})</div>
          {tables.map((t) => (
            <button
              key={t}
              onClick={() => void openTable(t)}
              className={`block w-full px-3 py-1.5 text-left ${table === t ? 'bg-panel3 text-fg' : 'text-dim hover:bg-panel3'}`}
              style={table === t ? { boxShadow: 'inset 2px 0 0 #0e639c' } : undefined}
            >
              {t}
            </button>
          ))}
          {connId && tables.length === 0 && <div className="px-3 py-3 text-[11px] text-dim2">无表或连接异常</div>}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!connId ? (
            <Empty text="请选择一条已连接的 MySQL / PostgreSQL 数据库。" />
          ) : loading ? (
            <Loading text="读取表数据…" />
          ) : error ? (
            <ErrorBox message={error} onRetry={() => table && openTable(table)} />
          ) : result ? (
            <>
              <div className="flex-1 overflow-hidden"><DataGrid result={result} /></div>
              <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel2 px-3 text-[11px] text-dim">
                <span>共 {result.rowCount} 行</span>
                <span>耗时 {result.elapsedMs}ms</span>
              </div>
            </>
          ) : (
            <Empty text="从左侧选择一张表以预览数据（最多 200 行）。" />
          )}
        </div>
      </div>
    </div>
  );
}
