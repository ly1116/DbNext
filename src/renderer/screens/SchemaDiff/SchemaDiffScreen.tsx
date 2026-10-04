import { useEffect, useMemo, useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox, InlineError, Loading } from '@renderer/components/common/States';
import { FullScreenHeader } from '@renderer/components/shell/FullScreenHeader';
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
      <label className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-[11px] text-dim2">库</span>
        <select value={db} onChange={(e) => onDb(e.target.value)} className="ipt">
          {!dbs.length && <option value="">（连接默认库）</option>}
          {dbs.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </label>
      {isPg && (
        <label className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[11px] text-dim2">模式</span>
          <select value={schema} onChange={(e) => onSchema(e.target.value)} className="ipt">
            {!schemas.length && <option value="public">public</option>}
            {schemas.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
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

  // 统计：用于左栏概览卡与右栏筛选按钮角标
  const stat = useMemo(() => {
    if (!result) return null;
    let added = 0, modified = 0, removed = 0;
    for (const i of result.items) {
      if (!i.inLeft) added++;
      else if (!i.inRight) removed++;
      else if (i.changes.length) modified++;
    }
    return { added, modified, removed, total: result.items.length, diff: added + modified + removed };
  }, [result]);

  const FILTERS: { id: Filter; label: string; n: number | null }[] = [
    { id: 'all', label: '全部', n: stat?.total ?? null },
    { id: 'added', label: META.added.label, n: stat?.added ?? null },
    { id: 'modified', label: META.modified.label, n: stat?.modified ?? null },
    { id: 'removed', label: META.removed.label, n: stat?.removed ?? null },
  ];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <FullScreenHeader
        title="结构对比"
        subtitle="对两个库做真实内省，逐表列出新增 / 修改 / 删除"
        actions={
          stat && (
            <span className="flex items-center gap-2 text-[11px]">
              <span className="text-dim2">共 {stat.total} 个对象</span>
              <span className={stat.diff ? 'text-warn' : 'text-ok'}>{stat.diff ? `${stat.diff} 处差异` : '结构一致'}</span>
            </span>
          )
        }
      />

      {/* —— 主体：左配置 / 右结果 —— */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-[minmax(300px,360px)_1fr] xl:overflow-hidden">
        {/* ══ 左栏：源 → 目标 → 对比 ══ */}
        <div className="flex flex-col gap-3 xl:min-h-0 xl:overflow-auto">
          <SidePanel step={1} title="源库" tone="accent">
            <label className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[11px] text-dim2">连接</span>
              <ConnectionPicker kind={['mysql', 'postgres']} value={leftId} onChange={(id) => { setLeftId(id); setLeftDb(''); setLeftSchema('public'); }} placeholder="选择连接…" />
            </label>
            <SideTargets connId={leftId} db={leftDb} schema={leftSchema} onDb={setLeftDb} onSchema={setLeftSchema} />
          </SidePanel>

          <div className="flex items-center gap-2 pl-1 text-[11px] text-dim2">
            <svg className="h-3.5 w-3.5 shrink-0 text-accent2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            对比方向
          </div>

          <SidePanel step={2} title="目标库" tone="ok">
            <label className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-[11px] text-dim2">连接</span>
              <ConnectionPicker kind={['mysql', 'postgres']} value={rightId} onChange={(id) => { setRightId(id); setRightDb(''); setRightSchema('public'); }} placeholder="选择连接…" />
            </label>
            <SideTargets connId={rightId} db={rightDb} schema={rightSchema} onDb={setRightDb} onSchema={setRightSchema} />
          </SidePanel>

          {error && <InlineError text={error} tone="prod" />}

          <div className="mt-auto shrink-0 pt-1">
            <button
              onClick={() => void run()}
              disabled={running || !leftId || !rightId}
              className="btn-primary h-9 w-full text-[12px] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {running ? '对比中…' : '开始对比'}
            </button>
          </div>
        </div>

        {/* ══ 右栏：概览 + 结果表 ══ */}
        <div className="flex flex-col gap-3 xl:min-h-0 xl:overflow-hidden">
          {/* 概览卡：未开始时占位说明，开始后显示三类差异计数 */}
          <div className="grid shrink-0 grid-cols-3 gap-2">
            {(['added', 'modified', 'removed'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                disabled={!stat}
                className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${
                  filter === k && stat
                    ? 'border-accent2/60 bg-accent/10'
                    : 'border-line2/60 bg-panel/40 hover:border-line2 hover:bg-panel3/40 disabled:opacity-50'
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${k === 'added' ? 'bg-ok' : k === 'modified' ? 'bg-warn' : 'bg-prod'}`} />
                <span className="min-w-0">
                  <span className="block text-[10px] text-dim2">{META[k].label}</span>
                  <span className="block text-[15px] font-semibold leading-tight tabular-nums text-fg">
                    {stat ? stat[k] : '—'}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* 结果表 */}
          <section className="flex h-[320px] flex-col overflow-hidden rounded-xl border border-line2/60 bg-panel/40 xl:h-auto xl:min-h-0 xl:flex-1">
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="text-[12px] font-medium text-fg">差异明细</span>
              {result && (
                <span className="text-[11px] text-dim2">
                  {rows.length === result.items.length
                    ? `${rows.length} 个对象`
                    : `${rows.length} / ${result.items.length} 个对象`}
                </span>
              )}
              <div className="ml-auto flex shrink-0 gap-1 rounded-lg border border-line2/60 bg-bg p-0.5">
                {FILTERS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setFilter(t.id)}
                    className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 py-1 text-[11px] transition-colors ${
                      filter === t.id ? 'bg-accent font-medium text-white' : 'text-dim hover:bg-panel3 hover:text-fg'
                    }`}
                  >
                    {t.label}
                    {t.n !== null && (
                      <span className={`tabular-nums ${filter === t.id ? 'text-white/75' : 'text-dim2'}`}>{t.n}</span>
                    )}
                  </button>
                ))}
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-auto">
              {!result && !error && !running && (
                <Empty text="选择源与目标两个数据库（PG 可指定库与模式），点击「开始对比」查看真实结构差异。" />
              )}
              {running && <Loading text="内省数据库结构…" />}
              {error && !result && <ErrorBox message={error} onRetry={run} />}
              {result && (
                <table className="w-full text-[12px]">
                  <thead className="sticky top-0 z-10 bg-panel2 text-dim">
                    <tr className="border-b border-line2 text-left">
                      <th className="w-24 px-4 py-2 font-normal">状态</th>
                      <th className="px-3 py-2 font-medium">对象</th>
                      <th className="px-3 py-2 font-medium">变更说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((d) => {
                      const kind = !d.inLeft ? 'added' : !d.inRight ? 'removed' : 'modified';
                      return (
                        <tr key={d.name} className="border-b border-line/50 transition-colors hover:bg-panel3/50">
                          <td className="px-4 py-2"><span className={`rounded px-1.5 py-0.5 text-[10px] ${META[kind].cls}`}>{META[kind].label}</span></td>
                          <td className="px-3 py-2 font-mono text-fg">{d.name}</td>
                          <td className="px-3 py-2 text-dim">{d.changes.length ? d.changes.join('；') : '结构一致'}</td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr><td colSpan={3} className="px-3 py-6 text-center text-dim2">
                        {filter === 'all' ? '两侧结构完全一致，无差异' : `无「${META[filter].label}」类差异`}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** 左栏配置分组卡片（与数据传输屏同款视觉语言） */
function SidePanel({
  step,
  title,
  tone,
  children,
}: {
  step: number;
  title: string;
  tone: 'accent' | 'ok';
  children: React.ReactNode;
}) {
  const bar = tone === 'accent' ? 'bg-accent2' : 'bg-ok';
  return (
    <section className="shrink-0 rounded-xl border border-line2/60 bg-panel/40">
      <header className="flex h-8 items-center gap-2 border-b border-line px-3">
        <span className={`h-3.5 w-0.5 rounded-full ${bar}`} />
        <span className="text-[12px] font-medium text-fg">{title}</span>
        <span className="ml-auto text-[10px] text-dim2">步骤 {step}</span>
      </header>
      <div className="space-y-2 p-2.5">{children}</div>
    </section>
  );
}
