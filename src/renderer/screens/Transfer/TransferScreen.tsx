import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox } from '@renderer/components/common/States';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { DataTransferMode, DataTransferProgress, ConnectionKind } from '@shared/types';

const DB_KINDS: ConnectionKind[] = ['mysql', 'postgres', 'oracle'];
const MODES: { id: DataTransferMode; label: string }[] = [
  { id: 'structure', label: '仅结构' },
  { id: 'structure-data', label: '结构和数据' },
  { id: 'data', label: '仅数据' },
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

  return (
    <div className="mx-auto flex h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-line2 bg-bg">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-4 text-[12px]">
        <span className="font-medium text-fg">数据传输</span>
        <span className="text-dim2">跨库传输表结构与数据（MySQL / PostgreSQL / Oracle 任意组合）</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px]">
        {/* —— 源 / 目标 两张卡片 —— */}
        <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-[1fr_auto_1fr]">
          <LocCard no="①" title="源库" tone="accent">
            <Field label="连接">
              <div className="min-w-0 flex-1">
                <ConnectionPicker kind={DB_KINDS} value={srcConnId} onChange={(id) => { setSrcConnId(id); void loadLocs(id, true); }} placeholder="选择源连接…" />
              </div>
            </Field>
            <Field label={srcLoc.kind === 'oracle' ? '模式' : '库'}>
              <select value={srcLoc.kind === 'oracle' ? srcLoc.schema : srcLoc.db} disabled={running} className="ipt min-w-0 flex-1" onChange={(e) => { const v = e.target.value; setSrcLoc((p) => ({ ...p, db: p.kind === 'oracle' ? p.db : v, schema: p.kind === 'oracle' ? v : p.schema })); }}>
                <option value="">（连接默认）</option>
                {srcLoc.dbs.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            {srcLoc.kind === 'postgres' && (
              <Field label="模式">
                <select value={srcLoc.schema} disabled={running} className="ipt min-w-0 flex-1" onChange={(e) => setSrcLoc((p) => ({ ...p, schema: e.target.value }))}>
                  {!srcLoc.schemas.length && <option value="">public</option>}
                  {srcLoc.schemas.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
            )}
          </LocCard>

          <div className="hidden items-center justify-center lg:flex">
            <svg className="h-5 w-5 text-accent2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </div>

          <LocCard no="②" title="目标库" tone="ok">
            <Field label="连接">
              <div className="min-w-0 flex-1">
                <ConnectionPicker kind={DB_KINDS} value={tgtConnId} onChange={(id) => { setTgtConnId(id); void loadLocs(id, false); }} placeholder="选择目标连接…" />
              </div>
            </Field>
            <Field label={tgtLoc.kind === 'oracle' ? '模式' : '库'}>
              <select value={tgtLoc.kind === 'oracle' ? tgtLoc.schema : tgtLoc.db} disabled={running} className="ipt min-w-0 flex-1" onChange={(e) => { const v = e.target.value; setTgtLoc((p) => ({ ...p, db: p.kind === 'oracle' ? p.db : v, schema: p.kind === 'oracle' ? v : p.schema })); }}>
                <option value="">（连接默认）</option>
                {tgtLoc.dbs.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            {tgtLoc.kind === 'postgres' && (
              <Field label="模式">
                <select value={tgtLoc.schema} disabled={running} className="ipt min-w-0 flex-1" onChange={(e) => setTgtLoc((p) => ({ ...p, schema: e.target.value }))}>
                  {!tgtLoc.schemas.length && <option value="">public</option>}
                  {tgtLoc.schemas.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
            )}
          </LocCard>
        </div>

        {/* —— 表选择 —— */}
        <div className="mt-4">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">③ 选择要传输的表</span>
            {!loadingTables && tables.length > 0 && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] ${
                  picked.size === tables.length ? 'bg-ok/15 text-ok' : 'bg-panel3 text-dim'
                }`}
              >
                已选 {picked.size}/{tables.length}
              </span>
            )}
            {loadingTables && <span className="text-[11px] text-dim2">读取表清单中…</span>}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {/* 搜索：一体化卡片（图标+输入+清空） */}
              <div className="flex h-7 w-52 items-center gap-1.5 rounded-lg border border-line2 bg-panel px-2 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
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
              {/* 批量操作：分段按钮组 */}
              <div className="flex overflow-hidden rounded-lg border border-line bg-panel">
                <button onClick={() => setPicked(new Set(shownTables))} disabled={!shownTables.length || running} className="px-3 py-1 text-dim transition-colors hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">全选</button>
                <button onClick={() => setPicked(new Set())} disabled={running || !picked.size} className="border-x border-line px-3 py-1 text-dim transition-colors hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">全不选</button>
                <button onClick={() => setPicked(new Set(tables.filter((t) => !picked.has(t))))} disabled={!tables.length || running} className="px-3 py-1 text-dim transition-colors hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40" title="把当前勾选反向">反选</button>
              </div>
            </div>
          </div>
          <div className="max-h-64 min-h-[88px] overflow-auto rounded-lg border border-line bg-panel p-2">
            {!srcConnId ? (
              <Empty text="先选择源连接，表清单会自动加载。" />
            ) : loadingTables ? (
              <Empty text="正在读取表清单…" />
            ) : tables.length === 0 ? (
              <Empty text="该库/模式下没有可传输的表。" />
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5">
                {shownTables.map((t) => {
                  const on = picked.has(t);
                  return (
                    <label
                      key={t}
                      title={t}
                      className={`flex cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border px-2 py-1 transition-colors ${
                        on
                          ? 'border-accent/50 bg-accent/10 text-fg'
                          : 'border-transparent text-dim hover:border-line2 hover:bg-panel3 hover:text-fg'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="shrink-0"
                        checked={on}
                        disabled={running}
                        onChange={(e) => setPicked((prev) => { const n = new Set(prev); e.target.checked ? n.add(t) : n.delete(t); return n; })}
                      />
                      <span className="truncate text-[11px]">{t}</span>
                    </label>
                  );
                })}
                {shownTables.length === 0 && <div className="col-span-full py-3 text-center text-dim2">无匹配「{tableFilter}」的表</div>}
              </div>
            )}
          </div>
        </div>

        {/* —— 选项 + 开始 —— */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-dim">④ 传输内容</span>
          <div className="flex rounded-lg border border-line bg-panel p-0.5">
            {MODES.map((m) => (
              <button key={m.id} onClick={() => setMode(m.id)} disabled={running} className={`rounded-md px-3 py-1 ${mode === m.id ? 'bg-accent font-medium text-white' : 'text-dim hover:text-fg'}`}>
                {m.label}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-fg">
            <input type="checkbox" checked={dropIfExists} disabled={running || mode === 'data'} onChange={(e) => setDropIfExists(e.target.checked)} />
            目标表已存在时删除重建
          </label>
          <div className="ml-auto">
            {!running ? (
              <button onClick={() => void start()} className="btn-primary px-5">开始传输 →</button>
            ) : (
              <button onClick={cancel} className="btn-danger px-5">取消传输</button>
            )}
          </div>
        </div>

        {cfgError && <div className="mt-3"><ErrorBox message={cfgError} /></div>}
        {finalError && <div className="mt-3"><ErrorBox message={`传输失败：${finalError}`} /></div>}

        {/* —— 进度 —— */}
        {run && (
          <div className="mt-4 rounded-lg border border-line bg-panel p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] ${run.status === 'running' ? 'bg-accent/20 text-accent2' : run.status === 'done' ? 'bg-ok/15 text-ok' : run.status === 'error' ? 'bg-prod/15 text-prod' : 'bg-panel3 text-dim'}`}>
                {run.status === 'running' && '传输中'}
                {run.status === 'done' && '✔ 已完成'}
                {run.status === 'error' && '✘ 失败'}
                {run.status === 'cancelled' && '■ 已取消'}
              </span>
              {run.status === 'running' && run.currentTable && <span className="text-accent2">当前表：{run.currentTable}</span>}
              <span className="ml-auto text-dim2">
                表 {run.tablesDone}/{run.tablesTotal}
                {run.rowsTotal > 0 && <> · 行 {run.rowsDone}/{run.rowsTotal}</>}
                {run.currentRowsTotal != null && run.status === 'running' && <> · 当前表 {run.currentRows}/{run.currentRowsTotal}</>}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-panel3">
              <div className={`h-full transition-all ${run.status === 'error' ? 'bg-prod' : run.status === 'done' ? 'bg-ok' : 'bg-accent2'}`} style={{ width: `${pct}%` }} />
            </div>
            <div ref={logRef} className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-bg p-2 font-mono text-[11px] leading-5 text-dim">
              {log.map((l, i) => <div key={i} className={l.startsWith('✔') ? 'text-ok' : l.includes('失败') ? 'text-prod' : undefined}>{l}</div>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 源/目标库卡片（带编号标题与色调圆点） */
function LocCard({ no, title, tone, children }: { no: string; title: string; tone: 'accent' | 'ok'; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="mb-2.5 flex items-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${tone === 'accent' ? 'bg-accent2' : 'bg-ok'}`} />
        <span className="font-medium text-fg">{no} {title}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-dim2">{label}</span>
      {children}
    </div>
  );
}
