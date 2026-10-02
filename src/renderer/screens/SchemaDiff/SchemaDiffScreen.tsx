import { useEffect, useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox, Loading } from '@renderer/components/common/States';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { SchemaDiffResult } from '@shared/types';

/**
 * ⑦ 结构对比屏幕（真实实现）。
 *
 * 选两个已连接的 MySQL/PostgreSQL（类型须一致），点「对比」经 `api.runDiff()`
 * 对两侧库做真实内省（information_schema），逐表展示 新增 / 修改(列类型变化) / 删除。
 * PG 连接可分别为两侧指定 目标库 + 模式（默认 public）；MySQL 可指定目标库。
 * 仅统计实体表（BASE TABLE），排除视图/物化视图噪音（如 PostGIS 系统视图）。
 *
 * @since 0.1.0
 */
type Filter = 'all' | 'added' | 'modified' | 'removed';

const META: Record<string, { label: string; cls: string }> = {
  added: { label: '新增', cls: 'bg-ok/15 text-ok' },
  modified: { label: '修改', cls: 'bg-warn/15 text-warn' },
  removed: { label: '删除', cls: 'bg-prod/15 text-prod' },
};

/** 一侧的 库/模式 选择器（PG=库+模式；MySQL=库；选择器跟随连接类型显隐） */
function SideTargets({
  connId,
  db,
  schema,
  onDb,
  onSchema,
}: {
  connId: string | null;
  db: string;
  schema: string;
  onDb: (v: string) => void;
  onSchema: (v: string) => void;
}) {
  const connections = useConnections((s) => s.connections);
  const conn = connections.find((c) => c.id === connId);
  const isPg = conn?.kind === 'postgres';
  const isDbKind = conn?.kind === 'mysql' || isPg;
  const [dbs, setDbs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);

  // 连接变化 → 自动连接（幂等，已连接直接返回）→ 拉取库清单（建链失败静默：下拉留空，对比时仍走连接默认库）
  useEffect(() => {
    setDbs([]);
    setSchemas([]);
    if (!connId || !isDbKind) return;
    let alive = true;
    const ready = conn && conn.status !== 'connected' ? api.connect(connId).catch(() => undefined) : Promise.resolve();
    ready
      .then(() => api.listDatabases(connId))
      .then((list) => { if (alive) setDbs(list); })
      .catch(() => {});
    return () => { alive = false; };
  }, [connId, isDbKind]);

  // 库清单到位后给默认值：优先连接配置里填的库，否则取第一个
  useEffect(() => {
    if (!isDbKind || !dbs.length) return;
    if (db && dbs.includes(db)) return;
    onDb((conn?.database && dbs.includes(conn.database) ? conn.database : dbs[0]) ?? '');
  }, [dbs, db, isDbKind, conn?.database, onDb]);

  // PG：库变化 → 拉取该库的模式清单（public 排最前由后端保证），默认 public
  useEffect(() => {
    if (!isPg || !connId) return;
    let alive = true;
    api
      .listSchemas(connId, db || undefined)
      .then((list) => {
        if (!alive) return;
        setSchemas(list);
        onSchema(list.includes(schema) ? schema : list.includes('public') ? 'public' : (list[0] ?? 'public'));
      })
      .catch(() => {});
    return () => { alive = false; };
    // schema 故意不入依赖：仅在 库/连接 变化时校正，避免用户手选后被覆盖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, isPg]);

  if (!connId || !isDbKind) return null;
  return (
    <>
      <span className="shrink-0 text-dim">库</span>
      <select value={db} onChange={(e) => onDb(e.target.value)} className="ipt w-40 shrink-0">
        {!dbs.length && <option value="">（连接默认库）</option>}
        {dbs.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      {isPg && (
        <>
          <span className="shrink-0 text-dim">模式</span>
          <select value={schema} onChange={(e) => onSchema(e.target.value)} className="ipt w-36 shrink-0">
            {!schemas.length && <option value="public">public</option>}
            {schemas.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </>
      )}
    </>
  );
}

export function SchemaDiffScreen() {
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);
  const [leftDb, setLeftDb] = useState('');
  const [rightDb, setRightDb] = useState('');
  const [leftSchema, setLeftSchema] = useState('public');
  const [rightSchema, setRightSchema] = useState('public');
  const [filter, setFilter] = useState<Filter>('all');
  const [result, setResult] = useState<SchemaDiffResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!leftId || !rightId) { setError('请选择源与目标两个连接'); return; }
    setRunning(true); setError(null);
    try {
      setResult(await api.runDiff(
        leftId,
        rightId,
        { database: leftDb || undefined, schema: leftSchema || undefined },
        { database: rightDb || undefined, schema: rightSchema || undefined },
      ));
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

      {/* 工具栏：flex-wrap 允许窄窗口换行；各控件固定宽度 + shrink-0，避免把按钮挤到文字竖排 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2 text-[12px]">
        <div className="flex w-64 min-w-0 shrink-0 items-center gap-1.5">
          <span className="shrink-0 text-dim">源</span>
          <ConnectionPicker kind={['mysql', 'postgres']} value={leftId} onChange={(id) => { setLeftId(id); setLeftDb(''); setLeftSchema('public'); }} placeholder="源连接…" />
        </div>
        <SideTargets connId={leftId} db={leftDb} schema={leftSchema} onDb={setLeftDb} onSchema={setLeftSchema} />
        <span className="shrink-0 text-dim">→</span>
        <div className="flex w-64 min-w-0 shrink-0 items-center gap-1.5">
          <span className="shrink-0 text-dim">目标</span>
          <ConnectionPicker kind={['mysql', 'postgres']} value={rightId} onChange={(id) => { setRightId(id); setRightDb(''); setRightSchema('public'); }} placeholder="目标连接…" />
        </div>
        <SideTargets connId={rightId} db={rightDb} schema={rightSchema} onDb={setRightDb} onSchema={setRightSchema} />
        <button onClick={() => void run()} disabled={running} className="shrink-0 whitespace-nowrap rounded bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent2 disabled:opacity-60">
          {running ? '对比中…' : '对比'}
        </button>
        <div className="ml-auto flex shrink-0 gap-1">
          {(['all', 'added', 'modified', 'removed'] as const).map((t) => (
            <button key={t} onClick={() => setFilter(t)} className={`shrink-0 whitespace-nowrap rounded px-2 py-1 text-[11px] ${filter === t ? 'bg-panel3 text-fg' : 'text-dim hover:text-fg'}`}>
              {t === 'all' ? '全部' : META[t].label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!result && !error && !running && <Empty text="选择源与目标两个数据库（PG 可指定库与模式），点击「对比」查看真实结构差异。" />}
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
