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

/**
 * 数据传输（真实实现）。
 *
 * 把源库（MySQL / PostgreSQL / Oracle）勾选的表传输到另一个库（任意方言组合，
 * 如 mysql → pg / mysql → oracle），自动做跨方言列类型映射：
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
  const [srcOpts, setSrcOpts] = useState<string[]>([]);
  const [tgtOpts, setTgtOpts] = useState<string[]>([]);
  const [srcSel, setSrcSel] = useState('');
  const [tgtSel, setTgtSel] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadingTables, setLoadingTables] = useState(false);
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

  /** 选中连接后加载「库/模式」下拉（MySQL=库；PG=模式；Oracle=模式） */
  const loadLocs = useCallback(async (connId: string, isSrc: boolean) => {
    const conn = connections.find((x) => x.id === connId);
    if (!conn) return;
    setCfgError(null);
    try {
      const opts = conn.kind === 'postgres' ? await api.listSchemas(connId) : await api.listDatabases(connId);
      const def = conn.kind === 'mysql' ? conn.database : conn.kind === 'oracle' ? conn.database || conn.username : undefined;
      const sel = opts.includes(def ?? '') ? (def as string) : opts[0] ?? '';
      if (isSrc) {
        setSrcOpts(opts);
        setSrcSel(sel);
        setTables([]);
        setPicked(new Set());
      } else {
        setTgtOpts(opts);
        setTgtSel(sel);
      }
    } catch (e) {
      setCfgError(`${isSrc ? '源' : '目标'}连接未就绪：${(e as Error).message}`);
    }
  }, [connections]);

  const loadTables = async () => {
    if (!srcConnId) return;
    setLoadingTables(true);
    setCfgError(null);
    try {
      // mysql 传库名；pg/oracle 传模式名（listTables 对 pg 忽略该参数，列全部用户表）
      const list = (await api.listTables(srcConnId, srcSel || undefined)).filter(Boolean);
      setTables(list);
      setPicked(new Set(list));
    } catch (e) {
      setCfgError(`读取表清单失败：${(e as Error).message}`);
      setTables([]);
      setPicked(new Set());
    } finally {
      setLoadingTables(false);
    }
  };

  const start = async () => {
    if (!srcConnId || !tgtConnId) { setCfgError('请选择源连接与目标连接'); return; }
    if (!picked.size) { setCfgError('请至少勾选一张要传输的表'); return; }
    if (srcConnId === tgtConnId) { setCfgError('目标连接不能与源连接相同'); return; }
    setCfgError(null);
    setFinalError(null);
    setLog([]);
    setRun({ status: 'running', phase: 'prepare', currentTable: null, tablesTotal: picked.size, tablesDone: 0, rowsDone: 0, rowsTotal: 0, currentRows: 0, currentRowsTotal: null });
    const srcKind = connections.find((x) => x.id === srcConnId)?.kind;
    const tgtKind = connections.find((x) => x.id === tgtConnId)?.kind;
    taskIdRef.current = `dt-${Date.now().toString(36)}`;
    try {
      const r = await api.dataTransferRun({
        sourceConnId: srcConnId,
        sourceDb: srcKind === 'mysql' ? srcSel || undefined : undefined,
        sourceSchema: srcKind !== 'mysql' ? srcSel || undefined : undefined,
        targetConnId: tgtConnId,
        targetDb: tgtKind === 'mysql' ? tgtSel || undefined : undefined,
        targetSchema: tgtKind !== 'mysql' ? tgtSel || undefined : undefined,
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

  return (
    <div className="mx-auto flex h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-line2 bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">数据传输</span>
        <span className="text-dim2">跨库传输表结构与数据（MySQL / PostgreSQL / Oracle 任意组合）</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px]">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* —— 源库 —— */}
          <Section title="① 源库">
            <Field label="连接">
              <ConnectionPicker kind={DB_KINDS} value={srcConnId} onChange={(id) => { setSrcConnId(id); setTables([]); setPicked(new Set()); void loadLocs(id, true); }} placeholder="选择源连接…" />
            </Field>
            <Field label="库/模式">
              <select value={srcSel} disabled={running} onChange={(e) => { setSrcSel(e.target.value); setTables([]); setPicked(new Set()); }} className="ipt min-w-0 flex-1">
                <option value="">（连接默认库）</option>
                {srcOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <button onClick={() => void loadTables()} disabled={!srcConnId || running || loadingTables} className="btn shrink-0">
                {loadingTables ? '读取中…' : '加载表'}
              </button>
            </Field>
          </Section>

          {/* —— 目标库 —— */}
          <Section title="② 目标库">
            <Field label="连接">
              <ConnectionPicker kind={DB_KINDS} value={tgtConnId} onChange={(id) => { setTgtConnId(id); void loadLocs(id, false); }} placeholder="选择目标连接…" />
            </Field>
            <Field label="库/模式">
              <select value={tgtSel} disabled={running} onChange={(e) => setTgtSel(e.target.value)} className="ipt min-w-0 flex-1">
                <option value="">（连接默认库）</option>
                {tgtOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
          </Section>
        </div>

        {/* —— 表选择 —— */}
        <div className="mt-4">
          <div className="mb-1 flex items-center gap-3">
            <span className="text-dim">③ 选择要传输的表</span>
            <button onClick={() => setPicked(new Set(tables))} disabled={!tables.length || running} className="btn">全选</button>
            <button onClick={() => setPicked(new Set())} disabled={!tables.length || running} className="btn">全不选</button>
            <span className="text-dim2">已选 {picked.size}/{tables.length} 张</span>
          </div>
          <div className="max-h-40 min-h-[64px] overflow-auto rounded border border-line bg-panel p-1">
            {!srcConnId ? (
              <Empty text="先选择源连接并「加载表」。" />
            ) : tables.length === 0 ? (
              <Empty text="暂无表：请点击「加载表」读取源库表清单。" />
            ) : (
              <div className="flex flex-wrap gap-x-4 gap-y-1 p-1">
                {tables.map((t) => (
                  <label key={t} className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-fg hover:text-accent2">
                    <input
                      type="checkbox"
                      checked={picked.has(t)}
                      disabled={running}
                      onChange={(e) => setPicked((prev) => { const n = new Set(prev); e.target.checked ? n.add(t) : n.delete(t); return n; })}
                    />
                    {t}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* —— 选项 —— */}
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="text-dim">④ 传输内容</span>
          {MODES.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-center gap-1.5 text-fg">
              <input type="radio" name="dt-mode" checked={mode === m.id} disabled={running} onChange={() => setMode(m.id)} />
              {m.label}
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-1.5 text-fg">
            <input type="checkbox" checked={dropIfExists} disabled={running || mode === 'data'} onChange={(e) => setDropIfExists(e.target.checked)} />
            目标表已存在时删除重建
          </label>
          <div className="ml-auto flex gap-2">
            {!running ? (
              <button onClick={() => void start()} className="btn-primary px-4">开始传输 →</button>
            ) : (
              <button onClick={cancel} className="btn-danger px-4">取消</button>
            )}
          </div>
        </div>

        {cfgError && <div className="mt-3"><ErrorBox message={cfgError} /></div>}
        {finalError && <div className="mt-3"><ErrorBox message={`传输失败：${finalError}`} /></div>}

        {/* —— 进度 —— */}
        {run && (
          <div className="mt-4 rounded border border-line bg-panel p-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">
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
            <div ref={logRef} className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-dim">
              {log.map((l, i) => <div key={i} className={l.startsWith('✔') ? 'text-ok' : l.includes('失败') ? 'text-prod' : undefined}>{l}</div>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-line bg-panel p-3">
      <div className="mb-2 text-dim">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-dim2">{label}</span>
      {children}
    </div>
  );
}
