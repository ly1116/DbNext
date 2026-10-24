import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { FullScreenHeader } from '@renderer/components/shell/FullScreenHeader';
import { Button } from '@renderer/components/ui/button';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { DataTransferMode, DataTransferProgress, ConnectionKind } from '@shared/types';
import { Icon } from '@renderer/components/common/icons';

const DB_KINDS: ConnectionKind[] = ['mysql', 'postgres', 'oracle'];

/** 传输内容模式（与主进程 DataTransferMode 对齐） */
const MODES: { id: DataTransferMode; label: string; hint: string }[] = [
  { id: 'structure', label: '仅结构', hint: '仅创建表和对象结构，不复制数据' },
  { id: 'data', label: '仅数据', hint: '仅复制数据和索引，目标表须已存在' },
  { id: 'structure-data', label: '结构和数据', hint: '先建结构再复制全部数据' },
];

/** 目标表处理方式（映射到 dropIfExists） */
const TARGET_HANDLES = [
  { id: 'append', label: '追加(INSERT)', hint: '目标表存在时直接追加数据' },
  { id: 'recreate', label: '删除重建(DROP+CREATE)', hint: '目标表存在时先删除再按源结构重建' },
] as const;
type TargetHandle = (typeof TARGET_HANDLES)[number]['id'];

/** 目标表名大小写（渲染端落库前转换） */
const CASE_MODES = [
  { id: 'keep', label: '保持原样' },
  { id: 'lower', label: '全部小写' },
  { id: 'upper', label: '全部大写' },
] as const;
type CaseMode = (typeof CASE_MODES)[number]['id'];

/** 传输对象分组（表 / 视图 / 物化视图 / 存储过程；传输引擎当前仅搬运表） */
const OBJ_KINDS = [
  { kind: 'table', label: '表' },
  { kind: 'view', label: '视图' },
  { kind: 'mview', label: '物化视图' },
  { kind: 'procedure', label: '存储过程' },
] as const;
type ObjKind = (typeof OBJ_KINDS)[number]['kind'];

/** 已保存传输任务（localStorage 持久化） */
interface TransferTask {
  id: string;
  name: string;
  createdAt: number;
  config: {
    srcConnId: string | null; srcDb: string; srcSchema: string;
    tgtConnId: string | null; tgtDb: string; tgtSchema: string;
    picked: string[];
    mode: DataTransferMode;
    targetHandle: TargetHandle;
    caseMode: CaseMode;
  };
}

const TASKS_KEY = 'dbnext.transfer.tasks.v1';

const loadTasks = (): TransferTask[] => {
  try { return JSON.parse(localStorage.getItem(TASKS_KEY) ?? '[]') as TransferTask[]; } catch { return []; }
};

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

/** 通配匹配（支持 * 与 % 作为任意串，其余按字面、忽略大小写） */
function wildRegex(pattern: string): RegExp {
  const body = pattern
    .split('')
    .map((ch) => (ch === '*' || ch === '%' ? '.*' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * 数据传输（弹窗版，按参考稿重构）。
 *
 * 布局：左栏「传输任务」（保存 / 搜索 / 载入 / 删除），右侧为配置区：
 * 源 / 目标双列（连接 / 数据库 / Schema，中间可互换方向）→ 传输对象（按
 * 表 / 视图 / 物化视图 / 存储过程 分组勾选，支持搜索与批量导入）→
 * 传输内容（仅结构 / 仅数据 / 结构和数据）→ 目标表处理方式 / 目标表名大小写。
 * 底部操作条：取消 / 保存为任务 / 开始传输；运行时展示进度条与实时日志。
 *
 * 跨方言列类型映射与进度推送由主进程 dataTransfer 完成（任意 mysql/pg/oracle 组合）。
 *
 * @since 0.3.0
 */
export function TransferScreen({ initialConnectionId, onClose }: { initialConnectionId?: string; onClose?: () => void }) {
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
  const [objs, setObjs] = useState<Record<ObjKind, string[]>>({ table: [], view: [], mview: [], procedure: [] });
  /** 勾选集合（键 `${kind}:${name}`） */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [objFilter, setObjFilter] = useState('');
  const [mode, setMode] = useState<DataTransferMode>('structure-data');
  const [targetHandle, setTargetHandle] = useState<TargetHandle>('append');
  const [caseMode, setCaseMode] = useState<CaseMode>('keep');
  const [cfgError, setCfgError] = useState<string | null>(null);

  // —— 传输任务（左栏） ——
  const [tasks, setTasks] = useState<TransferTask[]>(loadTasks);
  const [taskFilter, setTaskFilter] = useState('');
  const [taskPanel, setTaskPanel] = useState<{ mode: 'save' | 'import'; text: string } | null>(null);
  const persistTasks = (list: TransferTask[]) => {
    setTasks(list);
    try { localStorage.setItem(TASKS_KEY, JSON.stringify(list)); } catch { /* 忽略配额错误 */ }
  };

  // —— 对象分组折叠态（默认全展开） ——
  const [collapsed, setCollapsed] = useState<Partial<Record<ObjKind, boolean>>>({});

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
    if (isSrc) { setSrcLoc(base); setObjs({ table: [], view: [], mview: [], procedure: [] }); setPicked(new Set()); } else { setTgtLoc(base); }
    if (!conn) return;
    setCfgError(null);
    try {
      // 选中后自动连接：未建链的数据库连接先建链（主进程幂等：已连接直接返回）
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
  // ConnectionPicker 的 onChange 不会触发，需补一次定位加载
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

  /** 源侧「加载对象」参数：MySQL=库名；PG=模式+库名（跨库）；Oracle=模式名。就绪前为 null 不触发 */
  const srcListArg = useMemo(() => {
    if (!srcConnId) return null;
    if (srcLoc.kind === 'mysql') return srcLoc.db ? { schema: srcLoc.db, pgDb: undefined } : null;
    if (srcLoc.kind === 'postgres') return srcLoc.db ? { schema: srcLoc.schema || 'public', pgDb: srcLoc.db } : null;
    if (srcLoc.kind === 'oracle') return srcLoc.schema ? { schema: srcLoc.schema, pgDb: undefined } : null;
    return null;
  }, [srcConnId, srcLoc.kind, srcLoc.db, srcLoc.schema]);

  // 源侧定位就绪后自动加载各类型对象清单（选连接/换库/换模式都会触发）
  const [loadingObjs, setLoadingObjs] = useState(false);
  const loadObjects = useCallback(async (arg: { schema?: string; pgDb?: string }) => {
    if (!srcConnId) return;
    setLoadingObjs(true);
    setCfgError(null);
    const empty: Record<ObjKind, string[]> = { table: [], view: [], mview: [], procedure: [] };
    try {
      // 表走 listTables（方言参数语义与主进程一致），其余类型走 listObjects（逐类容错，某类不可用不影响其他类）
      empty.table = (await api.listTables(srcConnId, arg.schema || undefined, arg.pgDb || undefined)).filter(Boolean);
    } catch (e) {
      setCfgError(`读取表清单失败：${(e as Error).message}`);
    }
    await Promise.all(
      (['view', 'mview', 'procedure'] as const).map(async (kind) => {
        try {
          empty[kind] = (await api.listObjects(srcConnId, kind, arg.schema || '', arg.pgDb || undefined)).filter(Boolean);
        } catch { /* 该方言/库不支持此类（如 MySQL 无物化视图）：留空 */ }
      }),
    );
    setObjs(empty);
    // 默认全选表（其余类型不自动勾选）
    setPicked(new Set(empty.table.map((t) => `table:${t}`)));
    setLoadingObjs(false);
  }, [srcConnId]);

  useEffect(() => {
    if (srcListArg) void loadObjects(srcListArg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcListArg]);

  const start = async () => {
    const tableNames = [...picked].filter((k) => k.startsWith('table:')).map((k) => k.slice(6));
    const nonTable = picked.size - tableNames.length;
    if (!srcConnId || !tgtConnId) { setCfgError('请选择源连接与目标连接'); return; }
    if (!tableNames.length) { setCfgError('请至少勾选一张要传输的表（当前传输引擎仅支持表对象）'); return; }
    if (srcConnId === tgtConnId) { setCfgError('目标连接不能与源连接相同'); return; }
    // 目标表名大小写：落库前在渲染端转换
    const cased = tableNames.map((t) => (caseMode === 'lower' ? t.toLowerCase() : caseMode === 'upper' ? t.toUpperCase() : t));
    setCfgError(null);
    setFinalError(null);
    setLog(nonTable > 0 ? [`※ 已勾选的 ${nonTable} 个非表对象暂不支持传输，已跳过`] : []);
    setRun({ status: 'running', phase: 'prepare', currentTable: null, tablesTotal: cased.length, tablesDone: 0, rowsDone: 0, rowsTotal: 0, currentRows: 0, currentRowsTotal: null });
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
        tables: cased,
        mode,
        dropIfExists: targetHandle === 'recreate',
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

  /** 交换源 / 目标（对象清单随新源自动重载） */
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

  // Esc 关闭（运行中不关，防止误触中断进度显示）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !running) onClose?.();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [running, onClose]);

  // —— 任务：保存 / 载入 / 删除 ——
  const saveTask = () => {
    const name = taskPanel?.mode === 'save' ? taskPanel.text.trim() : '';
    if (!name) return;
    const task: TransferTask = {
      id: `tt-${Date.now().toString(36)}`,
      name,
      createdAt: Date.now(),
      config: {
        srcConnId, srcDb: srcLoc.db, srcSchema: srcLoc.schema,
        tgtConnId, tgtDb: tgtLoc.db, tgtSchema: tgtLoc.schema,
        picked: [...picked], mode, targetHandle, caseMode,
      },
    };
    persistTasks([task, ...tasks]);
    setTaskPanel(null);
  };

  const applyTask = async (t: TransferTask) => {
    const c = t.config;
    if (c.srcConnId && dbConns.some((x) => x.id === c.srcConnId)) { setSrcConnId(c.srcConnId); await loadLocs(c.srcConnId, true); }
    if (c.tgtConnId && dbConns.some((x) => x.id === c.tgtConnId)) { setTgtConnId(c.tgtConnId); await loadLocs(c.tgtConnId, false); }
    // 库/模式下拉填充完成后，回填任务里保存的定位（可能非默认库）
    setSrcLoc((p) => ({ ...p, db: c.srcDb || p.db, schema: c.srcSchema || p.schema }));
    setTgtLoc((p) => ({ ...p, db: c.tgtDb || p.db, schema: c.tgtSchema || p.schema }));
    setPicked(new Set(c.picked));
    setMode(c.mode);
    setTargetHandle(c.targetHandle);
    setCaseMode(c.caseMode);
  };

  const removeTask = (id: string) => persistTasks(tasks.filter((t) => t.id !== id));

  /** 批量导入：每行一个名称，支持 * / % 通配，命中即勾选 */
  const applyImport = () => {
    const lines = (taskPanel?.mode === 'import' ? taskPanel.text : '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { setTaskPanel(null); return; }
    const res = lines.map(wildRegex);
    const next = new Set(picked);
    let n = 0;
    for (const { kind } of OBJ_KINDS) {
      for (const name of objs[kind]) {
        if (res.some((re) => re.test(name))) { next.add(`${kind}:${name}`); n++; }
      }
    }
    setPicked(next);
    setTaskPanel(null);
    if (!n) setCfgError(`批量导入：没有对象匹配「${lines.join(', ')}」`);
  };

  // —— 派生：过滤后的分组 / 三态勾选 / 进度 ——
  const shownObjs = useMemo(() => {
    const k = objFilter.trim().toLowerCase();
    const map: Record<ObjKind, string[]> = { table: [], view: [], mview: [], procedure: [] };
    for (const { kind } of OBJ_KINDS) {
      map[kind] = k ? objs[kind].filter((t) => t.toLowerCase().includes(k)) : objs[kind];
    }
    return map;
  }, [objs, objFilter]);

  const pickedTables = useMemo(() => [...picked].filter((k) => k.startsWith('table:')).length, [picked]);
  const pct = run && run.rowsTotal > 0 ? Math.min(100, Math.round((run.rowsDone / run.rowsTotal) * 100)) : run ? (run.tablesTotal ? Math.round((run.tablesDone / run.tablesTotal) * 100) : 0) : 0;

  const statusCls = !run ? '' : run.status === 'running'
    ? 'bg-primary/15 text-primary'
    : run.status === 'done' ? 'bg-success/15 text-success'
    : run.status === 'error' ? 'bg-destructive/15 text-destructive'
    : 'bg-secondary text-muted-foreground';
  const statusText = !run ? '' : run.status === 'running' ? '传输中'
    : run.status === 'done' ? '✔ 已完成'
    : run.status === 'error' ? '✘ 失败'
    : '■ 已取消';

  const nameOf = (id: string | null) => (id ? connections.find((c) => c.id === id)?.name ?? id : null);
  const shownTasks = useMemo(() => {
    const k = taskFilter.trim().toLowerCase();
    return k ? tasks.filter((t) => t.name.toLowerCase().includes(k)) : tasks;
  }, [tasks, taskFilter]);

  /** 一侧的「连接 / 数据库 / Schema」竖排字段组 */
  const sideConn = (id: string, isSrc: boolean) => { isSrc ? setSrcConnId(id) : setTgtConnId(id); void loadLocs(id, isSrc); };
  const sidePatch = (p: Partial<SideLoc>, isSrc: boolean) => (isSrc ? setSrcLoc((prev) => ({ ...prev, ...p })) : setTgtLoc((prev) => ({ ...prev, ...p })));

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* —— 标题栏 —— */}
      <FullScreenHeader
        title="数据传输"
        subtitle={`${nameOf(srcConnId) ?? '未选源'} → ${nameOf(tgtConnId) ?? '未选目标'}${pickedTables ? ` · ${pickedTables} 张表` : ''}`}
      />

      {/* —— 主体：左传输任务 / 右配置 —— */}
      <div className="flex min-h-0 flex-1">
        {/* ══ 左栏：传输任务 ══ */}
        <aside className="flex w-[210px] shrink-0 flex-col border-r border-border bg-background">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="text-sm font-semibold text-foreground">传输任务</span>
            <button
              onClick={() => setTaskPanel(taskPanel?.mode === 'save' ? null : { mode: 'save', text: '' })}
              className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title="将当前配置保存为任务"
            >
              <Icon name="plus" className="h-3.5 w-3.5" strokeWidth={2.2} />
            </button>
          </div>
          <div className="border-b border-border px-2 py-1.5">
            <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 transition-colors focus-within:border-primary">
              <Icon name="search" className="h-3 w-3 shrink-0 text-muted-foreground"  />
              <input
                value={taskFilter}
                onChange={(e) => setTaskFilter(e.target.value)}
                placeholder="搜索任务..."
                className="min-w-0 flex-1 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1.5">
            {shownTasks.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <Icon name="transfer" className="h-6 w-6 opacity-50"  />
                <span className="text-[length:calc(var(--pref-fs)*0.786)]">暂无已保存传输任务</span>
              </div>
            ) : (
              shownTasks.map((t) => (
                <div
                  key={t.id}
                  className="group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 hover:bg-secondary"
                  onClick={() => void applyTask(t)}
                  title={`点击载入任务「${t.name}」`}
                >
                  <span className="min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.786)] text-foreground">{t.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeTask(t.id); }}
                    className="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex"
                    title="删除任务"
                  >
                    <Icon name="close-2" className="h-3 w-3" strokeWidth={2.2} />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ══ 右侧：配置区 ══ */}
        <div className="min-w-0 flex-1 overflow-auto">
          {/* —— 源 / 目标 双列 —— */}
          <div className="grid grid-cols-[1fr_32px_1fr] items-start gap-x-1 px-4 pt-3">
            <div className="flex min-w-0 flex-col gap-3">
              <span className="text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">源</span>
              <SideFields isSrc loc={srcLoc} connId={srcConnId} running={running} onConn={sideConn} onPatch={sidePatch} />
            </div>
            <button
              onClick={swap}
              disabled={running}
              className="mx-auto mt-6 grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:opacity-40"
              title="交换源与目标"
            >
              <Icon name="transfer" className="h-3.5 w-3.5"  />
            </button>
            <div className="flex min-w-0 flex-col gap-3">
              <span className="text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">目标</span>
              <SideFields isSrc={false} loc={tgtLoc} connId={tgtConnId} running={running} onConn={sideConn} onPatch={sidePatch} />
            </div>
          </div>

          {/* —— 传输对象 —— */}
          <div className="px-4 pt-4">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">传输对象</span>
              <span className="rounded-full border border-border/70 bg-muted px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-muted-foreground">
                {picked.size}/{OBJ_KINDS.reduce((n, k) => n + objs[k.kind].length, 0)}
              </span>
              {loadingObjs && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">读取中…</span>}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => setTaskPanel(taskPanel?.mode === 'import' ? null : { mode: 'import', text: '' })}
                  title="按名称清单批量勾选（支持 * / % 通配）"
                >
                  批量导入
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => setPicked(new Set(OBJ_KINDS.flatMap(({ kind }) => shownObjs[kind].map((n) => `${kind}:${n}`))))}
                  disabled={running || !srcConnId}
                  title="勾选当前过滤出的全部对象"
                >
                  全选
                </Button>
              </div>
            </div>
            {/* 搜索框 */}
            <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 transition-colors focus-within:border-primary">
              <Icon name="search" className="h-3 w-3 shrink-0 text-muted-foreground"  />
              <input
                value={objFilter}
                onChange={(e) => setObjFilter(e.target.value)}
                placeholder="搜索对象名..."
                className="min-w-0 flex-1 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none placeholder:text-muted-foreground"
              />
              {objFilter && (
                <button onClick={() => setObjFilter('')} className="shrink-0 text-muted-foreground hover:text-foreground" title="清空搜索">
                  <Icon name="close" className="h-3 w-3"  />
                </button>
              )}
            </div>

            {/* 批量导入 / 保存任务 输入面板 */}
            {taskPanel && (
              <div className="mt-2 rounded-lg border border-border bg-muted p-2">
                {taskPanel.mode === 'import' ? (
                  <>
                    <div className="mb-1 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">每行一个对象名，支持 * / % 通配，命中即勾选：</div>
                    <textarea
                      autoFocus
                      value={taskPanel.text}
                      onChange={(e) => setTaskPanel({ ...taskPanel, text: e.target.value })}
                      rows={4}
                      spellCheck={false}
                      className="w-full resize-y rounded border border-border bg-background p-1.5 font-mono text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none focus:border-primary"
                      placeholder={'ut_file_%\nvo_login_info'}
                    />
                    <div className="mt-1.5 flex justify-end gap-2">
                      <Button variant="outline" size="sm" className="h-6" onClick={() => setTaskPanel(null)}>取消</Button>
                      <Button size="sm" className="h-6" onClick={applyImport}>导入</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mb-1 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">任务名称（保存当前全部配置，供下次直接载入）：</div>
                    <input
                      autoFocus
                      value={taskPanel.text}
                      onChange={(e) => setTaskPanel({ ...taskPanel, text: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveTask(); if (e.key === 'Escape') setTaskPanel(null); }}
                      placeholder="如：pdpi 全量同步"
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="mt-1.5 flex justify-end gap-2">
                      <Button variant="outline" size="sm" className="h-6" onClick={() => setTaskPanel(null)}>取消</Button>
                      <Button size="sm" className="h-6" onClick={saveTask} disabled={!taskPanel.text.trim()}>保存</Button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 分组对象清单 */}
            <div className="mt-2 flex flex-col gap-1.5 pb-2">
              {!srcConnId ? (
                <div className="flex h-24 items-center justify-center text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">先选择源连接与库，对象清单会自动加载</div>
              ) : (
                OBJ_KINDS.map(({ kind, label }) => {
                  const all = objs[kind];
                  const shown = shownObjs[kind];
                  const pickedKeys = shown.filter((n) => picked.has(`${kind}:${n}`));
                  const isCollapsed = collapsed[kind] ?? false;
                  const allOn = shown.length > 0 && pickedKeys.length === shown.length;
                  const someOn = pickedKeys.length > 0 && !allOn;
                  return (
                    <div key={kind} className="overflow-hidden rounded-lg border border-border bg-muted">
                      {/* 分组头：折叠箭头 + 三态勾选 + 名称 + 计数 */}
                      <div className="flex h-8 items-center gap-1.5 px-2">
                        <button
                          onClick={() => setCollapsed((c) => ({ ...c, [kind]: !isCollapsed }))}
                          className="grid h-4 w-4 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                          title={isCollapsed ? '展开' : '折叠'}
                        >
                          <Icon name="chevronDown" className={`h-3 w-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} strokeWidth={2.2} />
                        </button>
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={allOn}
                          ref={(el) => { if (el) el.indeterminate = someOn; }}
                          disabled={running || !shown.length}
                          onChange={(e) => {
                            setPicked((prev) => {
                              const n = new Set(prev);
                              for (const name of shown) e.target.checked ? n.add(`${kind}:${name}`) : n.delete(`${kind}:${name}`);
                              return n;
                            });
                          }}
                          title={`勾选 / 取消本组（${label}）`}
                        />
                        <span className="text-[length:calc(var(--pref-fs)*0.786)] text-foreground">{label}</span>
                        <span className="ml-auto rounded-full border border-border/70 bg-background px-1.5 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-muted-foreground">
                          {pickedKeys.length}/{shown.length}
                        </span>
                      </div>
                      {/* 组内对象行 */}
                      {!isCollapsed && (
                        <div className="border-t border-border/60 py-1">
                          {all.length === 0 ? (
                            <div className="px-3 py-1 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
                              {loadingObjs ? '读取中…' : '（无对象）'}
                            </div>
                          ) : shown.length === 0 ? (
                            <div className="px-3 py-1 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">无匹配</div>
                          ) : (
                            shown.map((name) => {
                              const on = picked.has(`${kind}:${name}`);
                              return (
                                <label
                                  key={name}
                                  className="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-secondary/60"
                                  title={kind !== 'table' ? '非表对象当前仅支持勾选展示，传输引擎暂只搬运表' : name}
                                >
                                  <input
                                    type="checkbox"
                                    className="h-3 w-3 shrink-0 accent-primary"
                                    checked={on}
                                    disabled={running}
                                    onChange={(e) => setPicked((prev) => { const n = new Set(prev); e.target.checked ? n.add(`${kind}:${name}`) : n.delete(`${kind}:${name}`); return n; })}
                                  />
                                  <span className={`truncate font-mono text-[length:calc(var(--pref-fs)*0.786)] ${on ? 'text-foreground' : 'text-muted-foreground'}`}>{name}</span>
                                </label>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* —— 选项区 —— */}
          <div className="flex flex-col gap-2.5 px-4 pb-3">
            <div>
              <div className="mb-1 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">传输内容</div>
              <div className="flex flex-col gap-1">
                {MODES.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 text-[length:calc(var(--pref-fs)*0.786)]" title={m.hint}>
                    <input
                      type="radio"
                      name="dt-mode"
                      className="h-3.5 w-3.5 accent-primary"
                      checked={mode === m.id}
                      disabled={running}
                      onChange={() => setMode(m.id)}
                    />
                    <span className={mode === m.id ? 'font-medium text-foreground' : 'text-muted-foreground'}>{m.label}</span>
                    <span className="text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{m.hint}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <div className="mb-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">目标表处理方式</div>
                <select
                  value={targetHandle}
                  disabled={running || mode === 'data'}
                  className="h-8 w-56 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(e) => setTargetHandle(e.target.value as TargetHandle)}
                  title={TARGET_HANDLES.find((t) => t.id === targetHandle)?.hint + (mode === 'data' ? '（仅数据模式不涉及建表，此项不可用）' : '')}
                >
                  {TARGET_HANDLES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                {mode === 'data' && <span className="ml-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">仅数据模式不涉及建表</span>}
              </div>
              <div>
                <div className="mb-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">目标表名大小写</div>
                <select value={caseMode} disabled={running} className="h-8 w-40 rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(e) => setCaseMode(e.target.value as CaseMode)}>
                  {CASE_MODES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
            </div>
            {cfgError && <div className="rounded border border-prod/20 bg-destructive/10 p-2 text-[length:calc(var(--pref-fs)*0.786)] text-destructive">{cfgError}</div>}
          </div>
        </div>
      </div>

      {/* —— 运行区：进度条 + 日志（开始传输后出现） —— */}
      {(run || log.length > 0) && (
        <section className="flex h-40 shrink-0 flex-col border-t border-border bg-muted">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            <span className="text-sm font-semibold text-foreground">执行日志</span>
            {run && <span className={`rounded px-1.5 text-[10px] font-medium leading-4 ${statusCls}`}>{statusText}</span>}
            {run?.status === 'running' && run.currentTable && (
              <span className="truncate font-mono text-[10px] text-primary">{run.currentTable}</span>
            )}
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {run ? (
                <>
                  表 {run.tablesDone}/{run.tablesTotal}
                  {run.rowsTotal > 0 && <> · 行 {run.rowsDone}/{run.rowsTotal}</>}
                  {run.currentRowsTotal != null && run.status === 'running' && <> · 本表 {run.currentRows}/{run.currentRowsTotal}</>}
                </>
              ) : ''}
            </span>
          </div>
          {run && (
            <div className="h-1 shrink-0 bg-secondary">
              <div
                className={`h-full transition-all duration-300 ${run.status === 'error' ? 'bg-destructive' : run.status === 'done' ? 'bg-success' : run.status === 'cancelled' ? 'bg-muted-foreground' : 'bg-primary'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          <div ref={logRef} className="min-h-0 flex-1 overflow-auto px-3 py-1.5 font-mono text-[length:calc(var(--pref-fs)*0.714)] leading-5">
            {log.map((l, i) => (
              <div
                key={i}
                className={`break-all ${
                  l.startsWith('✔') ? 'text-success'
                  : l.startsWith('■') ? 'text-muted-foreground'
                  : /失败|错误|error/i.test(l) ? 'text-destructive'
                  : 'text-muted-foreground'
                }`}
              >
                {l}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* —— 底部操作条 —— */}
      <div className="flex h-11 shrink-0 items-center justify-end gap-2 border-t border-border px-4">
        {finalError && <span className="mr-auto truncate text-[length:var(--fs-body)] text-destructive" title={finalError}>传输失败：{finalError}</span>}
        <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTaskPanel({ mode: 'save', text: '' })}
          disabled={running}
          title="将当前配置保存为传输任务"
        >
          保存为任务
        </Button>
        {running ? (
          <Button variant="destructive" size="sm" onClick={cancel}>停止传输</Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void start()}
            disabled={!srcConnId || !tgtConnId || !pickedTables}
            title="按当前配置开始传输"
          >
            <Icon name="transfer" className="h-3.5 w-3.5"  />开始传输
          </Button>
        )}
      </div>
    </div>
  );
}

/** 一侧的「连接 / 数据库 / Schema」竖排字段组（源 / 目标共用；模块级定义避免重渲染时下拉状态丢失） */
function SideFields({
  isSrc,
  loc,
  connId,
  running,
  onConn,
  onPatch,
}: {
  isSrc: boolean;
  loc: SideLoc;
  connId: string | null;
  running: boolean;
  /** (连接ID, 是否源侧) */
  onConn: (id: string, isSrc: boolean) => void;
  /** (patch, 是否源侧) */
  onPatch: (patch: Partial<SideLoc>, isSrc: boolean) => void;
}) {
  const isPg = loc.kind === 'postgres';
  const isOracle = loc.kind === 'oracle';
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <div className="mb-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">{isSrc ? '源连接' : '目标连接'}</div>
        <ConnectionPicker kind={DB_KINDS} value={connId} onChange={(id) => onConn(id, isSrc)} placeholder="选择连接…" />
      </div>
      <div>
        <div className="mb-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">{isSrc ? '源数据库' : '目标数据库'}</div>
        <select
          value={isOracle ? loc.schema : loc.db}
          disabled={running || !connId}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(e) => onPatch(isOracle ? { schema: e.target.value } : { db: e.target.value }, isSrc)}
        >
          <option value="">（连接默认）</option>
          {loc.dbs.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
      {isPg && (
        <div>
          <div className="mb-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">{isSrc ? '源 Schema' : '目标 Schema'}</div>
          <select value={loc.schema} disabled={running || !connId} className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(e) => onPatch({ schema: e.target.value }, isSrc)}>
            {!loc.schemas.length && <option value="">public</option>}
            {loc.schemas.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
