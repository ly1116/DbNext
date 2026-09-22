import { useEffect, useState } from 'react';
import { SqlEditor } from '@renderer/components/common/SqlEditor';
import { DataGrid } from '@renderer/components/common/DataGrid';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { ErrorBox, Loading } from '@renderer/components/common/States';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { QueryResult } from '@shared/types';

/**
 * ② SQL 编辑器屏幕（真实实现）。
 *
 * 选一条已连接的 MySQL/PostgreSQL，左侧列出真实表名，右边编辑器写 SQL，
 * 点「运行」经 `api.runSql()` 拿到真实结果集（列/行/耗时）。
 * 「执行计划」标签对支持的语句跑 `EXPLAIN` 并显示真实计划。
 *
 * @since 0.1.0
 */
export function SqlEditorScreen() {
  const selectedId = useConnections((s) => s.selectedId);
  const [connId, setConnId] = useState<string | null>(null);
  const [sql, setSql] = useState('SELECT 1;');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [plan, setPlan] = useState<QueryResult | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'result' | 'message' | 'plan'>('result');

  useEffect(() => {
    if (!connId) { setTables([]); return; }
    api.listTables(connId).then(setTables).catch(() => setTables([]));
  }, [connId]);

  useEffect(() => { if (selectedId && !connId) setConnId(selectedId); }, [selectedId, connId]);

  const run = async () => {
    if (!connId) { setError('请先选择一条已连接的 MySQL / PostgreSQL'); return; }
    setRunning(true); setError(null);
    try {
      const res = await api.runSql(connId, sql);
      setResult(res); setTab('result'); setPlan(null);
    } catch (e) {
      setError((e as Error).message); setResult(null);
    } finally { setRunning(false); }
  };

  const showPlan = async () => {
    if (!connId) { setError('请先选择一条已连接的 MySQL / PostgreSQL'); return; }
    setError(null); setRunning(true);
    try {
      const res = await api.runSql(connId, `EXPLAIN ${sql}`);
      setPlan(res); setTab('plan');
    } catch (e) {
      setError(`执行计划失败：${(e as Error).message}`);
    } finally { setRunning(false); }
  };

  const insertTable = (t: string) => setSql(`SELECT * FROM ${t} LIMIT 200;`);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">SQL 编辑器</span>
        <ConnectionPicker kind={['mysql', 'postgres']} value={connId} onChange={setConnId} placeholder="选择数据库…" />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 表树 */}
        <div className="w-[248px] shrink-0 overflow-y-auto border-r border-line bg-panel py-1 text-[12px] mono">
          <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-dim">表 ({tables.length})</div>
          {tables.map((t) => (
            <button key={t} onClick={() => insertTable(t)} className="block w-full px-3 py-1.5 text-left text-dim hover:bg-panel3 hover:text-fg">
              {t}
            </button>
          ))}
          {connId && tables.length === 0 && <div className="px-3 py-3 text-[11px] text-dim2">无表或连接异常</div>}
        </div>

        {/* 编辑 + 结果 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-panel px-2 text-[12px]">
            <button onClick={() => void run()} disabled={running} className="flex items-center gap-1.5 rounded bg-accent px-2.5 font-medium text-white hover:bg-accent2 disabled:opacity-60">
              <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              <span>{running ? '运行中…' : '运行'}</span>
            </button>
            <button onClick={() => void showPlan()} disabled={running} className="rounded px-2 text-dim hover:bg-panel3 disabled:opacity-60">执行计划</button>
          </div>

          <div className="h-[280px] shrink-0 border-b border-line2">
            <SqlEditor value={sql} onChange={setSql} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col bg-panel">
            <div className="flex h-8 shrink-0 items-center border-b border-line px-1 text-[12px]">
              <Tab label="结果" badge={result ? String(result.rowCount) : undefined} active={tab === 'result'} onClick={() => setTab('result')} />
              <Tab label="消息" active={tab === 'message'} onClick={() => setTab('message')} />
              <Tab label="执行计划" active={tab === 'plan'} onClick={() => setTab('plan')} />
              {result && (
                <div className="ml-auto pr-2 text-[11px] text-dim">{result.rowCount} 行 · {result.elapsedMs}ms</div>
              )}
            </div>
            {tab === 'result' && (running ? <Loading text="执行中…" /> : error ? <ErrorBox message={error} onRetry={run} /> : result ? <DataGrid result={result} /> : <div className="flex flex-1 items-center justify-center text-[12px] text-dim2">点击「运行」执行 SQL</div>)}
            {tab === 'message' && <div className="flex flex-1 items-center justify-center text-[12px] text-dim2">{error ?? '无消息'}</div>}
            {tab === 'plan' && (plan ? <DataGrid result={plan} /> : <div className="flex flex-1 items-center justify-center text-[12px] text-dim2">点击「执行计划」查看</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Tab({ label, badge, active, onClick }: { label: string; badge?: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex h-full items-center gap-2 px-3 ${active ? 'tab-active' : 'text-dim hover:text-fg'}`}>
      <span>{label}</span>
      {badge && <span className="rounded-full bg-panel3 px-1.5 text-[10px] text-dim">{badge}</span>}
    </button>
  );
}
