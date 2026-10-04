import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, InlineError } from '@renderer/components/common/States';
import { FullScreenHeader } from '@renderer/components/shell/FullScreenHeader';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { DataTransferMode, DataTransferProgress, ConnectionKind } from '@shared/types';

const DB_KINDS: ConnectionKind[] = ['mysql', 'postgres', 'oracle'];
const MODES: { id: DataTransferMode; label: string; hint: string }[] = [
  { id: 'structure', label: '仅结构', hint: '只建表 / 索引' },
  { id: 'structure-data', label: '结构 + 数据', hint: '建表并搬运全部行' },
  { id: 'data', label: '仅数据', hint: '目标表须已存在' },
];

/** 进度运行态（渲染端聚合） */
interface RunState {
  status: DataTransferProgress['status'] | null;
  phase: DataTransferProgress['phase'];
  currentTable: string | null;
  tablesTotal: number;
  tablesDone: number;
  rowsDone: number;
  rowsTotal: number;
  currentRows: number;
  currentRowsTotal: number | null;
}

/** 一侧（源/目标）的 库/模式 选择状态 */
interface SideLoc {
  kind: ConnectionKind | null;
  /** MySQL=库名；PG=库名；Oracle=模式名（该方言无「库」概念，选择存入 schema 槽） */
  db: string;
  /** PG=模式名；Oracle=模式名；MySQL 恒空 */
  schema: string;
  dbs: string[];
  schemas: string[];
}

const EMPTY_LOC: SideLoc = { kind: null, db: '', schema: '', dbs: [], schemas: [] };

/**
 * 数据传输（真实实现）。
 *
 * 把源库（MySQL / PostgreSQL / Oracle）勾选的表传输到另一个库（任意方言组合，
 * 如 mysql → pg / mysql → oracle），自动做跨方言列类型映射：
 * - 目标定位：MySQL=库；PG=库+模式（跨库建附加池）；Oracle=模式；
 * - 内容模式：仅结构 / 结构和数据 / 仅数据；
 * - 进度：逐表推送（当前表、行数、日志行），支持中途取消；
 * - 单表失败不中断，错误记入日志继续下一张表。
 *
 * 布局：左栏「源 → 目标 → 传输内容 → 开始」为配置区，右栏「表清单 + 执行日志」为工作区，
 * 两栏等高撑满全屏，无空白死角。
 *
 * 由标题栏「传输」按钮 / 连接树以弹层打开，可预选源连接。
 *
 * @since 0.2.0
 */
export function TransferScreen({ initialConnectionId }: { initialConnectionId?: string }) {
  const connections = useConnections((s) => s.connections);
  const selectedId = useConnections((s) => s.selectedId);

  // —— 配置 ——
  const dbConns = useMemo(() => connections.filter((c) => DB_KINDS.includes(c.kind)), [connections]);
  const presetId = useMemo(() => {
    const c = initialConnectionId ?? selectedId;
    return c && dbConns.some((x) => x.id === c) ? c : null;
  }, [initialConnectionId, selectedId, dbConns]);

  const [srcConnId, setSrcConnId] = useState<string | null>(presetId);
  const [tgtConnId, setTgtConnId] = useState<string | null>(null);
  const [srcLoc, setSrcLoc] = useState<SideLoc>(EMPTY_LOC);
  const [tgtLoc, setTgtLoc] = useState<SideLoc>(EMPTY_LOC);
  const [tables, setTables] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [tableFilter, setTableFilter] = useState('');
  const [mode, setMode] = useState<DataTransferMode>('structure-data');
  const [dropIfExists, setDropIfExists] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);

  // —— 运行态 ——
  const [run, setRun] = useState<RunState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [finalError, setFinalError] = useState<string | null>(null);
  const taskIdRef = useRef<string>('');
  const logRef = useRef<HTMLDivElement | null>(null);
  const running = !!run && run.status === 'running';

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  /**
   * 选中连接后加载定位选项：listDatabases 对 Oracle 返回模式清单。
   * 默认值：MySQL/PG=连接配置库（存在时），Oracle=连接配置库或用户名。
   */
  const loadLocs = useCallback(async (connId: string, isSrc: boolean) => {
    const conn = connections.find((x) => x.id === connId);
    const base: SideLoc = { ...EMPTY_LOC, kind: conn?.kind ?? null };
    if (isSrc) { setSrcLoc(base); setTables([]); setPicked(new Set()); } else { setTgtLoc(base); }
    if (!conn) return;
    setCfgError(null);
    try {
      // 选中后自动连接：未建链的数据库连接先建链（主进程幂等：已连接直接返回；状态经 connection:status 推送到连接树）
      if (conn.status !== 'connected') await api.connect(connId);
      const dbs = conn.kind === 'oracle' || conn.kind === 'mysql' || conn.kind === 'postgres' ? await api.listDatabases(connId) : [];
      const defDb = conn.kind === 'oracle'
        ? (conn.database || conn.username || '')
        : (conn.database || '');
      const patch: Partial<SideLoc> = { dbs };
      if (conn.kind === 'oracle') patch.schema = dbs.includes(defDb) ? defDb : dbs[0] ?? '';
      else patch.db = dbs.includes(defDb) ? defDb : dbs[0] ?? '';
      if (isSrc) setSrcLoc((p) => ({ ...p, ...patch }));
      else setTgtLoc((p) => ({ ...p, ...patch }));
    } catch (e) {
      setCfgError(`${isSrc ? '源' : '目标'}连接未就绪：${(e as Error).message}`);
    }
  }, [connections]);

  // 首次挂载若已预选源连接（从连接树/标题栏带 initialConnectionId 打开）：
  // ConnectionPicker 的 onChange 不会触发，需补一次定位加载，
  // 否则 库 下拉为空、srcListArg 不就绪，表清单也不会自动加载
  useEffect(() => {
    if (presetId) void loadLocs(presetId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // PG：库变化 → 拉取该库的模式清单（public 排最前由后端保证），默认 public
  useEffect(() => {
    if (srcLoc.kind !== 'postgres' || !srcConnId || !srcLoc.db) return;
    let alive = true;
    api.listSchemas(srcConnId, srcLoc.db || undefined)
      .then((list) => alive && setSrcLoc((p) => ({ ...p, schemas: list, schema: list.includes(p.schema) ? p.schema : list.includes('public') ? 'public' : list[0] ?? '' })))
      .catch(() => alive && setSrcLoc((p) => ({ ...p, schemas: [] })));
    return () => { alive = false; };
  }, [srcConnId, srcLoc.kind, srcLoc.db]);

  useEffect(() => {
    if (tgtLoc.kind !== 'postgres' || !tgtConnId || !tgtLoc.db) return;
    let alive = true;
    api.listSchemas(tgtConnId, tgtLoc.db || undefined)
      .then((list) => alive && setTgtLoc((p) => ({ ...p, schemas: list, schema: list.includes(p.schema) ? p.schema : list.includes('public') ? 'public' : list[0] ?? '' })))
      .catch(() => alive && setTgtLoc((p) => ({ ...p, schemas: [] })));
    return () => { alive = false; };
  }, [tgtConnId, tgtLoc.kind, tgtLoc.db]);

  /** 源侧「加载表」参数：MySQL=库名；PG=模式+库名（跨库）；Oracle=模式名。就绪前为 null 不触发 */
  const srcListArg = useMemo(() => {
    if (!srcConnId) return null;
    if (srcLoc.kind === 'mysql') return srcLoc.db ? { schema: srcLoc.db, pgDb: undefined } : null;
    if (srcLoc.kind === 'postgres') return srcLoc.db ? { schema: srcLoc.schema || 'public', pgDb: srcLoc.db } : null;
    if (srcLoc.kind === 'oracle') return srcLoc.schema ? { schema: srcLoc.schema, pgDb: undefined } : null;
    return null;
  }, [srcConnId, srcLoc.kind, srcLoc.db, srcLoc.schema]);

  // 源侧定位就绪后自动加载表清单（选连接/换库/换模式都会触发）
  const [loadingTables, setLoadingTables] = useState(false);
  const loadTables = useCallback(async (arg: { schema?: string; pgDb?: string }) => {
    if (!srcConnId) return;
    setLoadingTables(true);
    setCfgError(null);
    try {
      const list = (await api.listTables(srcConnId, arg.schema || undefined, arg.pgDb || undefined)).filter(Boolean);
      setTables(list);
      setPicked(new Set(list));
    } catch (e) {
      setCfgError(`读取表清单失败：${(e as Error).message}`);
      setTables([]);
      setPicked(new Set());
    } finally {
      setLoadingTables(false);
    }
  }, [srcConnId]);

  useEffect(() => {
    if (srcListArg) void loadTables(srcListArg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcListArg]);

  const start = async () => {
    if (!srcConnId || !tgtConnId) { setCfgError('请选择源连接与目标连接'); return; }
    if (!picked.size) { setCfgError('请至少勾选一张要传输的表'); return; }
    if (srcConnId === tgtConnId) { setCfgError('目标连接不能与源连接相同'); return; }
    setCfgError(null);
    setFinalError(null);
    setLog([]);
    setRun({ status: 'running', phase: 'prepare', currentTable: null, tablesTotal: picked.size, tablesDone: 0, rowsDone: 0, rowsTotal: 0, currentRows: 0, currentRowsTotal: null });
    const specOf = (loc: SideLoc): { db?: string; schema?: string } => {
      if (loc.kind === 'mysql') return { db: loc.db || undefined };
      if (loc.kind === 'postgres') return { db: loc.db || undefined, schema: loc.schema || undefined };
      return { schema: loc.schema || loc.db || undefined }; // Oracle
    };
    taskIdRef.current = `dt-${Date.now().toString(36)}`;
    try {
      const r = await api.dataTransferRun({
        sourceConnId: srcConnId,
        sourceDb: specOf(srcLoc).db,
        sourceSchema: specOf(srcLoc).schema,
        targetConnId: tgtConnId,
        targetDb: specOf(tgtLoc).db,
        targetSchema: specOf(tgtLoc).schema,
        tables: [...picked],
        mode,
        dropIfExists,
      }, taskIdRef.current);
      setLog((l) => [...l, `✔ 完成：${r.tables} 张表、共 ${r.rows} 行${r.errors.length ? `，失败 ${r.errors.length} 张` : ''}`]);
    } catch (e) {
      const msg = (e as Error).message;
      if (/取消/.test(msg)) setLog((l) => [...l, '■ 已取消']);
      else setFinalError(msg);
      setRun((r0) => (r0 ? { ...r0, status: /取消/.test(msg) ? 'cancelled' : 'error' } : r0));
    }
  };

  const cancel = () => { if (taskIdRef.current) void api.dataTransferCancel(taskIdRef.current); };

  /** 交换源 / 目标（表清单随新源自动重载） */
  const swap = () => {
    setSrcConnId(tgtConnId);
    setTgtConnId(srcConnId);
    setSrcLoc(tgtLoc);
    setTgtLoc(srcLoc);
  };

  // 订阅主进程进度推送
  useEffect(() => {
    const off = api.onDataTransferProgress((p) => {
      setRun((r0) => (r0 ? {
        ...r0,
        status: p.status ?? r0.status,
        phase: p.phase ?? r0.phase,
        currentTable: p.currentTable !== undefined ? p.currentTable : r0.currentTable,
        tablesTotal: p.tablesTotal ?? r0.tablesTotal,
        tablesDone: p.tablesDone ?? r0.tablesDone,
        rowsDone: p.rowsDone ?? r0.rowsDone,
        rowsTotal: p.rowsTotal ?? r0.rowsTotal,
        currentRows: p.currentRows ?? r0.currentRows,
        currentRowsTotal: p.currentRowsTotal !== undefined ? p.currentRowsTotal : r0.currentRowsTotal,
      } : r0));
      if (p.message) setLog((l) => [...l.slice(-499), p.message]);
      if (p.status === 'error' && p.error) setFinalError(p.error);
    });
    return off;
  }, []);

  const pct = run && run.rowsTotal > 0 ? Math.min(100, Math.round((run.rowsDone / run.rowsTotal) * 100)) : run ? (run.tablesTotal ? Math.round((run.tablesDone / run.tablesTotal) * 100) : 0) : 0;
  const shownTables = useMemo(() => {
    const k = tableFilter.trim().toLowerCase();
    return k ? tables.filter((t) => t.toLowerCase().includes(k)) : tables;
  }, [tables, tableFilter]);

  const nameOf = (id: string | null) => (id ? connections.find((c) => c.id === id)?.name ?? id : null);
  const statusCls = !run ? '' : run.status === 'running'
    ? 'bg-accent2/15 text-accent2'
    : run.status === 'done' ? 'bg-ok/15 text-ok'
    : run.status === 'error' ? 'bg-prod/15 text-prod'
    : 'bg-panel3 text-dim';
  const statusText = !run ? '' : run.status === 'running' ? '传输中'
    : run.status === 'done' ? '✔ 已完成'
    : run.status === 'error' ? '✘ 失败'
    : '■ 已取消';

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* —— 标题栏 —— */}
      <FullScreenHeader
        title="数据传输"
        subtitle="跨库传输表结构与数据 · MySQL / PostgreSQL / Oracle 任意组合"
        actions={
          <>
            <span className="max-w-[220px] truncate">{nameOf(srcConnId) ?? '未选源'} → {nameOf(tgtConnId) ?? '未选目标'}</span>
            {tables.length > 0 && <span className="shrink-0 text-dim">{picked.size} / {tables.length} 张表</span>}
          </>
        }
      />

      {/* —— 主体：左配置 / 右工作区 ——
           宽屏（xl）左右分栏且各自内部滚动；窄屏退化为单列、整页滚动。
           注意 overflow/min-h-0 只在 xl 生效：窄屏若给 grid item 设 overflow，
           其 min-content 高度会塌成 0 导致面板不可见。 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-3 xl:grid-cols-[minmax(300px,360px)_1fr] xl:overflow-hidden">
        {/* ══ 左栏：配置 ══ */}
        <div className="flex flex-col gap-3 xl:min-h-0 xl:overflow-auto">
          <SidePanel
            step={1}
            title="源库"
            tone="accent"
            right={
              <button
                onClick={swap}
                disabled={running}
                className="rounded p-1 text-dim2 transition-colors hover:bg-panel3 hover:text-accent2 disabled:opacity-40"
                title="交换源与目标"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M7 4v13M7 4 4 7M7 4l3 3M17 20V7M17 20l3-3M17 20l-3-3" />
                </svg>
              </button>
            }
          >
            <LocFields
              loc={srcLoc}
              connId={srcConnId}
              disabled={running}
              onConn={(id) => { setSrcConnId(id); void loadLocs(id, true); }}
              onPatch={(patch) => setSrcLoc((p) => ({ ...p, ...patch }))}
            />
          </SidePanel>

          {/* 源 → 目标 方向指示 */}
          <div className="flex items-center gap-2 pl-1 text-[11px] text-dim2">
            <svg className="h-3.5 w-3.5 shrink-0 text-accent2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            传输方向
          </div>

          <SidePanel step={2} title="目标库" tone="ok">
            <LocFields
              loc={tgtLoc}
              connId={tgtConnId}
              disabled={running}
              onConn={(id) => { setTgtConnId(id); void loadLocs(id, false); }}
              onPatch={(patch) => setTgtLoc((p) => ({ ...p, ...patch }))}
            />
          </SidePanel>

          <SidePanel step={3} title="传输内容" tone="neutral">
            <div className="flex flex-col gap-1">
              {MODES.map((m) => {
                const on = mode === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    disabled={running}
                    title={m.hint}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-50 ${
                      on ? 'border-accent2/60 bg-accent/10' : 'border-line2/50 bg-bg hover:border-line2 hover:bg-panel3/50'
                    }`}
                  >
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full border-2 transition-colors ${on ? 'border-accent2 bg-accent2' : 'border-line2'}`} />
                    <span className={`text-[12px] ${on ? 'font-medium text-fg' : 'text-dim'}`}>{m.label}</span>
                    <span className="ml-auto truncate text-[10px] text-dim2">{m.hint}</span>
                  </button>
                );
              })}
            </div>
            <label
              className={`mt-1 flex items-center gap-2 rounded-lg px-1 py-1 text-[11px] ${
                running || mode === 'data' ? 'text-dim2' : 'cursor-pointer text-dim hover:text-fg'
              }`}
            >
              <input
                type="checkbox"
                className="accent-accent"
                checked={dropIfExists}
                disabled={running || mode === 'data'}
                onChange={(e) => setDropIfExists(e.target.checked)}
              />
              目标表已存在时删除重建
              {mode === 'data' && <span className="ml-auto text-[10px]">仅数据模式不可用</span>}
            </label>
          </SidePanel>

          {cfgError && <InlineError text={cfgError} />}
          {finalError && <InlineError text={`传输失败：${finalError}`} tone="prod" />}

          {/* 开始 / 取消 */}
          <div className="mt-auto shrink-0 pt-1">
            {running ? (
              <button onClick={cancel} className="btn-danger h-9 w-full text-[12px]">取消传输</button>
            ) : (
              <button
                onClick={() => void start()}
                disabled={!srcConnId || !tgtConnId || !picked.size}
                className="btn-primary h-9 w-full text-[12px] disabled:cursor-not-allowed disabled:opacity-45"
              >
                开始传输 · {picked.size} 张表 →
              </button>
            )}
          </div>
        </div>

        {/* ══ 右栏：表清单 + 日志 ══ */}
        <div className="flex flex-col gap-3 xl:min-h-0 xl:overflow-hidden">
          {/* 表清单：窄屏给一个高度下限（整页滚动时才有意义），宽屏由 flex-1 撑满 */}
          <section className="flex h-[320px] flex-col overflow-hidden rounded-xl border border-line2/60 bg-panel/40 xl:h-auto xl:min-h-0 xl:flex-1">
            <header className="flex h-9 shrink-0 flex-wrap items-center gap-2 border-b border-line px-3">
              <StepDot n={4} />
              <span className="text-[12px] font-medium text-fg">选择要传输的表</span>
              {loadingTables ? (
                <span className="text-[11px] text-dim2">读取中…</span>
              ) : tables.length > 0 ? (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${picked.size === tables.length ? 'bg-ok/15 text-ok' : 'bg-accent2/15 text-accent2'}`}>
                  已选 {picked.size}/{tables.length}
                </span>
              ) : null}

              <div className="ml-auto flex items-center gap-2">
                {/* 搜索 */}
                <div className="flex h-7 w-48 items-center gap-1.5 rounded-lg border border-line2/60 bg-bg px-2 transition-colors focus-within:border-accent2 focus-within:ring-2 focus-within:ring-accent2/20">
                  <svg className="h-3.5 w-3.5 shrink-0 text-dim2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    value={tableFilter}
                    onChange={(e) => setTableFilter(e.target.value)}
                    placeholder="搜索表名…"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-dim2"
                  />
                  {tableFilter && (
                    <button onClick={() => setTableFilter('')} className="shrink-0 text-dim2 hover:text-fg" title="清空搜索">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  )}
                </div>
                {/* 批量 */}
                <div className="flex overflow-hidden rounded-lg border border-line2/60 bg-bg">
                  {[
                    { t: '全选', d: !shownTables.length || running, act: () => setPicked(new Set(shownTables)) },
                    { t: '全不选', d: running || !picked.size, act: () => setPicked(new Set()) },
                    { t: '反选', d: !tables.length || running, act: () => setPicked(new Set(tables.filter((t) => !picked.has(t)))) },
                  ].map((b, i) => (
                    <button
                      key={b.t}
                      onClick={b.act}
                      disabled={b.d}
                      className={`px-2.5 py-1 text-[11px] text-dim transition-colors hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-35 ${i ? 'border-l border-line2/60' : ''}`}
                    >
                      {b.t}
                    </button>
                  ))}
                </div>
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-auto p-2">
              {!srcConnId ? (
                <Empty text="先在左侧选择源连接与库，表清单会自动加载。" />
              ) : loadingTables ? (
                <Empty text="正在读取表清单…" />
              ) : tables.length === 0 ? (
                <Empty text="该库 / 模式下没有可传输的表。" />
              ) : shownTables.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[12px] text-dim2">无匹配「{tableFilter}」的表</div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-1.5">
                  {shownTables.map((t) => {
                    const on = picked.has(t);
                    return (
                      <label
                        key={t}
                        title={t}
                        className={`group flex cursor-pointer items-center gap-2 overflow-hidden rounded-lg border px-2 py-1.5 transition-colors ${
                          on
                            ? 'border-accent2/45 bg-accent/10 text-fg'
                            : 'border-transparent text-dim hover:border-line2/60 hover:bg-panel3/50 hover:text-fg'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="h-3 w-3 shrink-0 accent-accent"
                          checked={on}
                          disabled={running}
                          onChange={(e) => setPicked((prev) => { const n = new Set(prev); e.target.checked ? n.add(t) : n.delete(t); return n; })}
                        />
                        <span className={`truncate font-mono text-[11px] ${on ? 'text-fg' : ''}`}>{t}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          {/* 进度 + 日志 */}
          <section className="flex h-44 shrink-0 flex-col overflow-hidden rounded-xl border border-line2/60 bg-panel/40">
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="text-[12px] font-medium text-fg">执行日志</span>
              {run && (
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusCls}`}>{statusText}</span>
              )}
              {run?.status === 'running' && run.currentTable && (
                <span className="truncate font-mono text-[11px] text-accent2">{run.currentTable}</span>
              )}
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-dim2">
                {run ? (
                  <>
                    表 {run.tablesDone}/{run.tablesTotal}
                    {run.rowsTotal > 0 && <> · 行 {run.rowsDone}/{run.rowsTotal}</>}
                    {run.currentRowsTotal != null && run.status === 'running' && <> · 本表 {run.currentRows}/{run.currentRowsTotal}</>}
                  </>
                ) : (
                  '尚未开始'
                )}
              </span>
            </header>

            {run && (
              <div className="h-1 shrink-0 bg-panel3">
                <div
                  className={`h-full transition-all duration-300 ${run.status === 'error' ? 'bg-prod' : run.status === 'done' ? 'bg-ok' : run.status === 'cancelled' ? 'bg-dim2' : 'bg-accent2'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}

            <div ref={logRef} className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-5">
              {log.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[12px] font-sans text-dim2">
                  勾选表后点「开始传输」，逐表进度与错误会实时输出到这里
                </div>
              ) : (
                log.map((l, i) => (
                  <div
                    key={i}
                    className={`break-all ${
                      l.startsWith('✔') ? 'text-ok'
                      : l.startsWith('■') ? 'text-dim'
                      : /失败|错误|error/i.test(l) ? 'text-prod'
                      : 'text-dim'
                    }`}
                  >
                    {l}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** 步骤圆点序号 */
function StepDot({ n }: { n: number }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent2/20 text-[10px] font-semibold text-accent2">
      {n}
    </span>
  );
}

/** 左栏配置分组卡片 */
function SidePanel({
  step,
  title,
  tone,
  right,
  children,
}: {
  step: number;
  title: string;
  tone: 'accent' | 'ok' | 'neutral';
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const bar = tone === 'accent' ? 'bg-accent2' : tone === 'ok' ? 'bg-ok' : 'bg-line2';
  return (
    <section className="shrink-0 rounded-xl border border-line2/60 bg-panel/40">
      <header className="flex h-8 items-center gap-2 border-b border-line px-3">
        <span className={`h-3.5 w-0.5 rounded-full ${bar}`} />
        <span className="text-[12px] font-medium text-fg">{title}</span>
        <span className="text-[10px] text-dim2">步骤 {step}</span>
        {right && <span className="ml-auto flex items-center">{right}</span>}
      </header>
      <div className="space-y-2 p-2.5">{children}</div>
    </section>
  );
}

/** 一侧的「连接 + 库(/模式)」字段组（源 / 目标共用，方言差异由 loc.kind 决定显隐） */
function LocFields({
  loc,
  connId,
  disabled,
  onConn,
  onPatch,
}: {
  loc: SideLoc;
  connId: string | null;
  disabled: boolean;
  onConn: (id: string) => void;
  onPatch: (patch: Partial<SideLoc>) => void;
}) {
  const isPg = loc.kind === 'postgres';
  const isOracle = loc.kind === 'oracle';
  return (
    <>
      <label className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-[11px] text-dim2">连接</span>
        <ConnectionPicker kind={DB_KINDS} value={connId} onChange={onConn} placeholder="选择连接…" />
      </label>
      <label className="flex items-center gap-2">
        <span className="w-8 shrink-0 text-[11px] text-dim2">{isOracle ? '模式' : '库'}</span>
        <select
          value={isOracle ? loc.schema : loc.db}
          disabled={disabled}
          className="ipt"
          onChange={(e) => onPatch(isOracle ? { schema: e.target.value } : { db: e.target.value })}
        >
          <option value="">（连接默认）</option>
          {loc.dbs.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </label>
      {isPg && (
        <label className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-[11px] text-dim2">模式</span>
          <select
            value={loc.schema}
            disabled={disabled}
            className="ipt"
            onChange={(e) => onPatch({ schema: e.target.value })}
          >
            {!loc.schemas.length && <option value="">public</option>}
            {loc.schemas.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      )}
    </>
  );
}
