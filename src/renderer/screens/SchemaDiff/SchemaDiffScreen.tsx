import { useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox, Loading } from '@renderer/components/common/States';
import { api } from '@renderer/api';
import type { SchemaDiffResult } from '@shared/types';

/**
 * ⑦ 结构对比屏幕（真实实现）。
 *
 * 选两个已连接的 MySQL/PostgreSQL（类型须一致），点「对比」经 `api.runDiff()`
 * 对两侧库做真实内省（information_schema），逐表展示 新增 / 修改(列类型变化) / 删除。
 *
 * @since 0.1.0
 */
type Filter = 'all' | 'added' | 'modified' | 'removed';

const META: Record<string, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'bg-ok/15 text-ok' },
  modified: { label: '修改', cls: 'bg-warn/15 text-warn' },
  removed: { label: '删除', cls: 'bg-prod/15 text-prod' },
};

export function SchemaDiffScreen() {
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [result, setResult] = useState<SchemaDiffResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!leftId || !rightId) { setError('请选择源与目标两个连接'); return; }
    setRunning(true); setError(null);
    try {
      setResult(await api.runDiff(leftId, rightId));
    } catch (e) {
      setError((e as Error).message); setResult(null);
    } finally { setRunning(false); }
  };

  const rows = result ? result.items.filter((i) => filter === 'all' || (filter === 'added' && !i.inLeft) || (filter === 'removed' && !i.inRight) || (filter === 'modified' && i.changes.length > 0 && i.inLeft && i.inRight)) : [];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">结构对比</span>
      </div>

      <div className="flex items-center gap-3 border-b border-line bg-panel px-3 py-2 text-[12px]">
        <span className="text-dim">源</span>
        <ConnectionPicker kind={['mysql', 'postgres']} value={leftId} onChange={setLeftId} placeholder="源库…" />
        <span className="text-dim">→</span>
        <span className="text-dim">目标</span>
        <ConnectionPicker kind={['mysql', 'postgres']} value={rightId} onChange={setRightId} placeholder="目标库…" />
        <button onClick={() => void run()} disabled={running} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent2 disabled:opacity-60">
          {running ? '对比中…' : '对比'}
        </button>
        <div className="ml-auto flex gap-1">
          {(['all', 'added', 'modified', 'removed'] as const).map((t) => (
            <button key={t} onClick={() => setFilter(t)} className={`rounded px-2 py-1 text-[11px] ${filter === t ? 'bg-panel3 text-fg' : 'text-dim hover:text-fg'}`}>
              {t === 'all' ? '全部' : META[t].label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!result && !error && !running && <Empty text="选择源与目标两个数据库，点击「对比」查看真实结构差异。" />}
        {running && <Loading text="内省数据库结构…" />}
        {error && <ErrorBox message={error} onRetry={run} />}
        {result && (
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-panel2 text-dim">
              <tr className="border-b border-line2 text-left">
                <th className="w-24 px-3 py-2 font-normal">状态</th>
                <th className="px-3 py-2 font-medium">对象</th>
                <th className="px-3 py-2 font-medium">变更说明</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const kind = !d.inLeft ? 'added' : !d.inRight ? 'removed' : 'modified';
                return (
                  <tr key={d.name} className="border-b border-line/50">
                    <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[10px] ${META[kind].cls}`}>{META[kind].label}</span></td>
                    <td className="px-3 py-2 font-medium text-fg">{d.name}</td>
                    <td className="px-3 py-2 text-dim">{d.changes.length ? d.changes.join('；') : '结构一致'}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={3} className="px-3 py-6 text-center text-dim2">无差异</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
