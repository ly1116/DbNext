import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@renderer/components/common/icons";
import { ContextMenu } from "@renderer/components/common/ContextMenu";
import { api } from "@renderer/api";
import { useConnections } from "@renderer/store/connectionStore";
import { useScriptStore } from "@renderer/store/scriptStore";
import { usePrefs } from "@renderer/store/prefsStore";
import { Markdown } from "@renderer/components/common/Markdown";
import { SqlEditor } from "@renderer/components/workbench/SqlEditor";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { errMsg } from "@renderer/utils/errMsg";
import { format as formatSqlText } from "sql-formatter";
import type { QueryColumn, ScriptResult } from "@shared/types";
import { sqlSourceTable, EMPTY_SET_NUM, EMPTY_SET_STR, downloadFile, buildChangeStatements } from "./shared";
import { fmtNow, LIMITS, FilterInput, EditableGrid, cellCopyText } from "./tableTab";

function QResTab({ label, badge, active, onClick }: { label: string; badge?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-full items-center gap-1.5 border-b-2 px-3 transition-colors ${active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      <span>{label}</span>
      {badge && <span className={`rounded-full px-1.5 text-[10px] leading-4 ${badge === '!' ? 'bg-destructive/15 text-destructive' : 'bg-secondary text-muted-foreground'}`}>{badge}</span>}
    </button>
  );
}

export function QueryTab({ connId, tabId, initialSql, initialDb }: { connId: string; tabId: string; initialSql?: string; /** 初始库/模式（树中选中节点新建查询时携带）：MySQL=库 / PG=库 / Oracle=模式 */ initialDb?: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  // SQL 持久化：脚本打开带 initialSql > 按标签 ID 恢复本标签内容 > 新标签回退到该连接上次的 SQL
  const lastSqlKey = `dataroost.qsql.conn.${connId}`;
  const tabSqlKey = `dataroost.qsql.tab.${tabId}`;
  const histKey = `dataroost.qhist.${connId}`;
  const [initSql] = useState(() => {
    try {
      return initialSql ?? localStorage.getItem(tabSqlKey) ?? localStorage.getItem(lastSqlKey) ?? 'SELECT 1;';
    } catch {
      return initialSql ?? 'SELECT 1;';
    }
  });
  const sqlRef = useRef(initSql);
  /** 历史执行过的 SQL（按连接存最近 50 条，点击回填编辑器） */
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const arr = JSON.parse(localStorage.getItem(histKey) ?? '[]');
      return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
    } catch {
      return [];
    }
  });
  /** 编辑器内容注入（历史回填） */
  const injectRef = useRef<((v: string) => void) | null>(null);
  /** 编辑器选中文本读取（运行选中）：selectionRef.current?.() 取当前选中，无选中返回 '' */
  const selectionRef = useRef<(() => string) | null>(null);
  /** 高亮「已执行语句」：执行成功后调 highlightRef.current?.(sql)，编辑器给该语句加 ▶ + 圆角盒 */
  const highlightRef = useRef<((v: string) => void) | null>(null);
  /** 编辑器右键菜单位置（运行 / 运行选中） */
  const [sqlMenu, setSqlMenu] = useState<{ x: number; y: number } | null>(null);
  /* —— Ctrl+S 保存脚本：弹框命名 → 存入左侧连接树「脚本」节点 —— */
  const saveScript = useScriptStore((s) => s.save);
  const [saveDlg, setSaveDlg] = useState(false);
  const [scriptName, setScriptName] = useState('');
  const submitSaveScript = () => {
    const name = scriptName.trim();
    if (!name) return;
    saveScript(connId, name, sqlRef.current);
    setSaveDlg(false);
    setScriptName('');
  };
  /** 防抖持久化定时器 */
  const saveTimerRef = useRef<number | null>(null);
  const persistSql = (v: string) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      try {
        localStorage.setItem(tabSqlKey, v);
        localStorage.setItem(lastSqlKey, v);
      } catch {
        /* 存储满等异常忽略 */
      }
    }, 300);
  };
  /** 历史回填：替换编辑器内容并立即持久化 */
  const setEditorSql = (v: string) => {
    sqlRef.current = v;
    injectRef.current?.(v);
    try {
      localStorage.setItem(tabSqlKey, v);
      localStorage.setItem(lastSqlKey, v);
    } catch {
      /* 忽略 */
    }
  };
  /** 执行成功后记入历史（去重、最新在前、上限 50 条） */
  const pushHistory = (text: string) => {
    setHistory((h) => {
      const next = [text, ...h.filter((s) => s !== text)].slice(0, 50);
      try {
        localStorage.setItem(histKey, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<QueryColumn[] | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isDml, setIsDml] = useState(false);
  /** 当前页码（0 起，真分页；run/筛选/行数限制变更时归零） */
  const [resPage, setResPage] = useState(0);
  /** 本次结果获取完成时间（状态栏展示，DBeaver 同款） */
  const [fetchedAt, setFetchedAt] = useState('');
  /** 结果集编辑态（单表 SELECT 可编辑，复用表数据页提交逻辑）：edits 以 `${ri}::${col}` 为键 */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [newRows, setNewRows] = useState<Record<string, string>[]>([]);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  /** 结果集主键列（单表 SELECT 且查到主键时填充，决定结果网格可编辑；多表/JOIN 为空 → 只读） */
  const [pkCols, setPkCols] = useState<string[]>([]);
  /** 脚本运行结果（多语句逐条日志；单条语句仍走普通 run 的网格展示） */
  const [scriptResult, setScriptResult] = useState<ScriptResult | null>(null);
  /** 结果区页签（Navicat 式）：数据表（网格/语句数据）/ 结果（逐条语句执行表 + 进度条）/ 图表 / 消息 */
  const [qresTab, setQresTab] = useState<'data' | 'summary' | 'chart' | 'message'>('data');
  /** 「结果」页选中的语句序号（点击行 → 「数据表」页展示该语句返回的数据） */
  const [sumSel, setSumSel] = useState<number | null>(null);
  /** 单语句运行的影响行数（DML 时作为「结果」页的返回行展示） */
  const [lastAffected, setLastAffected] = useState<number | undefined>(undefined);
  /** @ai 命令：提问内容与流式回答 */
  const [aiAsked, setAiAsked] = useState<string | null>(null);
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiStreaming, setAiStreaming] = useState(false);
  const lastSqlRef = useRef('');
  const busyRef = useRef(false);
  /** 结果筛选的包装基准 SQL（用户点「运行」时更新；筛选 = SELECT * FROM (基准) q WHERE 条件，走真实查询） */
  const baseSqlRef = useRef('');
  /** 结果筛选/排序（对齐表数据页筛选卡）：回车 = 包装基准 SQL 走真实查询 */
  const [resWhere, setResWhere] = useState('');
  const [resOrderBy, setResOrderBy] = useState('');
  /** 结果客户端排序（点击表头 asc → desc → 取消） */
  const [resSort, setResSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  /** 导出下拉展开状态（底部状态栏） */
  const [exportOpen, setExportOpen] = useState(false);
  /** 结果行数上限（DBeaver 同款：结果集行数上限，修改后立即重新查询） */
  const [resLimit, setResLimit] = useState<number>(200);
  /** 字段筛选面板展开（结果顶部条「字段筛选」按钮切换；展开后在内容区顶部显示 where/order by 卡） */
  const [showFilter, setShowFilter] = useState(false);
  /** 自动刷新（结果操作栏「自动」按钮切换，定时重跑当前结果页） */
  const [autoRefresh, setAutoRefresh] = useState(false);
  /** 当前选中单元格（只读结果也可点选高亮并显示坐标，对齐表数据页状态栏） */
  const [selCell, setSelCell] = useState<{ ri: number; col: string } | null>(null);
  // 智能提示数据源：表名(小写) -> 列名数组（进入标签页后异步加载一次）
  const [schema, setSchema] = useState<Record<string, string[]> | undefined>(undefined);
  /** 当前库 / 模式下拉：可选项与当前选中项（查询内切换库；MySQL/PG 按库路由连接池，Oracle 用会话语句） */
  const [dbOptions, setDbOptions] = useState<string[]>([]);
  const [currentDb, setCurrentDb] = useState<string | null>(null);
  /** 切库后的实际执行上下文（ref 保证 run/loadMore 拿到最新值；MySQL/PG 路由连接池，Oracle 仍走会话） */
  const activeDbRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    // 携带初始库（树中选中节点 → 新建查询）：直接落到该库/模式，跳过会话当前库探测
    if (initialDb) {
      if (conn?.kind === 'oracle') {
        setCurrentDb(initialDb);
        void api
          .runSql(connId, `ALTER SESSION SET CURRENT_SCHEMA = "${initialDb.replace(/"/g, '""')}"`)
          .catch(() => undefined);
      } else {
        setCurrentDb(initialDb);
        activeDbRef.current = initialDb;
      }
      void api
        .listSchemaColumns(connId, conn?.kind === 'oracle' ? undefined : initialDb)
        .then((m) => {
          if (alive && Object.keys(m).length > 0) setSchema(m);
        })
        .catch(() => undefined);
      api
        .listDatabases(connId)
        .then((opts) => alive && setDbOptions(opts))
        .catch(() => undefined);
      return () => {
        alive = false;
      };
    }
    api
      .listSchemaColumns(connId)
      .then((m) => {
        if (alive && Object.keys(m).length > 0) setSchema(m);
      })
      .catch(() => {
        /* 拉取失败则退化为纯关键字提示 */
      });
    // 库列表（各方言统一 listDatabases：MySQL=库、PG=有 CONNECT 权限的库、Oracle=模式）
    let optsRef: string[] = [];
    api
      .listDatabases(connId)
      .then((opts) => {
        if (!alive) return;
        optsRef = opts;
        setDbOptions(opts);
        // 默认选中当前库 / 模式
        const curSql = conn?.kind === 'mysql'
          ? 'SELECT DATABASE() AS db'
          : conn?.kind === 'postgres'
            ? 'SELECT current_database() AS db'
            : "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS db FROM dual";
        return api.runSql(connId, curSql);
      })
      .then((r) => {
        if (!alive) return;
        // 当前库：会话当前值 → 连接配置里的库 → 下拉第一项（MySQL 未选库时 SELECT DATABASE() 为 null）
        const v = (r && r.rows[0]?.db ? String(r.rows[0].db) : undefined)
          ?? conn?.database ?? optsRef[0] ?? undefined;
        if (v) {
          setCurrentDb(v);
          if (conn?.kind === 'mysql' || conn?.kind === 'postgres') {
            activeDbRef.current = v;
            // 按解析出的库重拉提示数据（初始那次拉的是连接自身库的上下文）
            if (conn.kind === 'postgres' || conn.kind === 'mysql') {
              void api
                .listSchemaColumns(connId, v)
                .then((m2) => {
                  if (alive && Object.keys(m2).length > 0) setSchema(m2);
                })
                .catch(() => {});
            }
          }
        }
      })
      .catch(() => {
        /* 忽略：下拉仍可使用 */
      });
    return () => {
      alive = false;
    };
  }, [connId, conn?.kind, initialDb]);

  /** 切换当前库 / 模式：MySQL/PG 按库路由连接池（无需会话 USE）；Oracle=ALTER SESSION。切换后仅重载提示，不自动执行编辑器内容 */
  const switchDb = async (db: string) => {
    setCurrentDb(db);
    try {
      if (conn?.kind === 'oracle') {
        await api.runSql(connId, `ALTER SESSION SET CURRENT_SCHEMA = "${db.replace(/"/g, '""')}"`);
        activeDbRef.current = undefined;
      } else {
        // MySQL / PostgreSQL：跨库连接池按库名路由（USE 在连接池下只作用于单个连接，不可靠）
        activeDbRef.current = db;
        const m = await api.listSchemaColumns(connId, db);
        if (Object.keys(m).length > 0) setSchema(m);
      }
    } catch (e) {
      setError(errMsg(e));
    }
  };

  /** 取运行文本：编辑器有选中时只跑选中，否则全文 */
  const pickRunText = () => {
    const sel = (selectionRef.current?.() ?? '').trim();
    return sel || (sqlRef.current || '').trim();
  };

  /** 提取 AI 回答中的 SQL：```sql 代码块优先（多个拼接），无代码块退化为整段文本 */
  const extractSql = (text: string) => {
    const blocks = [...text.matchAll(/```(?:sql)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1].trim());
    return blocks.length ? blocks.join('\n\n') : text.trim();
  };

  /** 执行前安全检查（设置 → 数据库）：只读模式拦截 + 危险 SQL 确认；返回 null 表示放行，返回字符串表示被拦截/取消 */
  const safetyGate = (text: string): string | null => {
    const prefs = usePrefs.getState().prefs;
    if (prefs.readOnlyMode && !/^\s*(select|with|show|desc|describe|explain|use|set)\b/i.test(text)) {
      return '只读模式已开启：禁止执行非查询语句（可在 设置 → 数据库 中关闭）。';
    }
    if (prefs.dangerousSqlConfirm) {
      const noWhere = /^\s*(update|delete)\b/i.test(text) && !/\bwhere\b/i.test(text);
      const destructive = /^\s*(drop|truncate)\b/i.test(text);
      if (noWhere || destructive) {
        if (!window.confirm('检测到高危 SQL（无 WHERE 的 UPDATE/DELETE 或 DROP/TRUNCATE），确定执行吗？')) {
          return '已取消执行。';
        }
      }
    }
    return null;
  };

  /** 查询超时包装（设置 → 数据库 → 查询超时；0 = 不限制）；onTimeout 用于触发底层查询取消 */
  const withTimeout = <T,>(p: Promise<T>, sec: number, onTimeout?: () => void): Promise<T> => {
    if (sec <= 0) return p;
    let h!: ReturnType<typeof setTimeout>;
    return Promise.race([
      p,
      new Promise<never>((_, rej) => {
        h = setTimeout(() => {
          try { onTimeout?.(); } catch { /* 忽略取消失败 */ }
          rej(new Error(`查询超时（${sec} 秒）`));
        }, sec * 1000);
      }),
    ]).finally(() => clearTimeout(h)) as Promise<T>;
  };

  /** 一键格式化当前 SQL（优先格式化选中文本，否则整段编辑器内容；语法非法时静默忽略，不破坏原内容） */
  const formatSql = () => {
    const raw = (selectionRef.current?.().trim() || sqlRef.current || '').trim();
    if (!raw) return;
    const lang = conn?.kind === 'postgres' ? 'postgresql' : conn?.kind === 'mysql' ? 'mysql' : 'sql';
    try {
      const pretty = formatSqlText(raw, { language: lang, keywordCase: 'upper', tabWidth: 2 });
      injectRef.current?.(pretty);
    } catch {
      /* 语法不合法时保持原样 */
    }
  };

  /**
   * 识别文本中的 @ai 提及（不再要求全文开头，SQL 与 @ai 混写、@ai 独占一行均可触发）。
   * 返回剔除 @ai 记号后的指令文本；无 @ai 或剔完为空返回 null。
   */
  const extractAiInstruction = (text: string): string | null => {
    if (!/@ai\b/i.test(text)) return null;
    const instruction = text.replace(/@ai\b/gi, ' ').trim();
    return instruction || null;
  };

  /** @ai 命令：指令交给 AI（带连接上下文，模型可调用 run_sql_query 查真实数据），流式回答展示在结果区 */
  const runAi = async (instruction: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError(null);
    setScriptResult(null);
    setAiAsked(instruction);
    setAiAnswer('');
    setAiStreaming(true);
    let answer = '';
    const offChunk = api.onAiChunk((d) => {
      answer += d;
      setAiAnswer(answer);
    });
    const offDone = api.onAiDone(() => {
      offChunk();
      offDone();
      setAiStreaming(false);
      busyRef.current = false;
      setLoading(false);
    });
    try {
      // AI 上下文表清单数量由偏好控制（token 消耗）
      const limit = Math.max(1, usePrefs.getState().prefs.aiContextTables);
      const tableKeys = schema ? Object.keys(schema).slice(0, limit) : [];
      const dbLine = conn?.kind === 'oracle' ? undefined : activeDbRef.current;
      const context = tableKeys.length
        ? [`当前${dbLine ? `库「${dbLine}」` : ''}包含的表：${tableKeys.join('、')}`]
        : undefined;
      await api.aiAsk(
        [{ id: `u-${Date.now().toString(36)}`, role: 'user', content: instruction, ts: Date.now() }],
        context,
        undefined,
        conn ? { id: connId, label: `${conn.name}（${conn.host}）`, kind: conn.kind, db: dbLine } : undefined,
      );
    } catch (e) {
      offChunk();
      offDone();
      setAiStreaming(false);
      busyRef.current = false;
      setLoading(false);
      setAiAnswer((prev) => prev || `错误：${errMsg(e)}`);
    }
  };

  /** 执行指定 SQL 文本（运行 / 运行选中 / 解释计划 共用链路：@ai / 安全检查 / 超时取消 / 结果网格 / 历史） */
  const runText = async (text: string, opts?: { noHistory?: boolean; lim?: number }) => {
    if (busyRef.current) return;
    // @ai 命令：交给 AI 生成 / 解答（Ctrl+Enter 同样触发；@ai 可出现在文本任意位置）
    const ai1 = extractAiInstruction(text);
    if (ai1) {
      await runAi(ai1);
      return;
    }
    // 只读模式 / 危险 SQL 确认（设置 → 数据库）
    const blocked = safetyGate(text);
    if (blocked) {
      setError(blocked);
      return;
    }
    busyRef.current = true;
    setLoading(true);
    setError(null);
    setScriptResult(null);
    setAiAsked(null);
    lastSqlRef.current = text;
    setResPage(0);
    setSelCell(null);
    try {
      const prefs = usePrefs.getState().prefs;
      const lim = opts?.lim ?? resLimit;
      const r = await withTimeout(
        api.runSqlPaged(connId, text, 0, lim, conn?.kind === 'oracle' ? undefined : activeDbRef.current),
        prefs.queryTimeoutSec,
        () => { void api.cancelQuery(connId, conn?.kind === 'oracle' ? undefined : activeDbRef.current).catch(() => {}); },
      );
      // 结果集行数上限：超出截断并停止继续分页加载
      const max = prefs.maxResultRows;
      const rows = max > 0 && r.result.rows.length > max ? r.result.rows.slice(0, max) : r.result.rows;
      setColumns(r.result.columns);
      setRows(rows);
      // 行数上限：仅当已显示行数达到上限（截断生效）时停止继续分页加载
      setHasMore(max > 0 && rows.length >= max ? false : r.hasMore);
      setElapsedMs(r.result.elapsedMs);
      setFetchedAt(fmtNow());
      setIsDml(r.result.affectedRows !== undefined);
      setLastAffected(r.result.affectedRows);
      // 结果集可编辑判定：单表 SELECT（非写操作、无 JOIN/UNION/多表）且能取到主键 → 可编辑；否则只读
      setEdits({});
      setDeleted(new Set());
      setNewRows([]);
      setCommitMsg(null);
      const srcTbl = sqlSourceTable(text);
      const isWrite = r.result.affectedRows !== undefined;
      const singleSelect =
        !isWrite &&
        /^\s*select/i.test(text.trim()) &&
        !/(join|union|from\s+\S+\s*,\s*\S+)/i.test(text) &&
        srcTbl !== 'query_result';
      if (singleSelect) {
        const dot = srcTbl.indexOf('.');
        const schemaPart = dot >= 0 ? srcTbl.slice(0, dot) : (activeDbRef.current ?? currentDb ?? '');
        const tblPart = dot >= 0 ? srcTbl.slice(dot + 1) : srcTbl;
        try {
          const cols = await api.listColumns(connId, schemaPart, tblPart);
          setPkCols(cols.filter((c) => c.key === 'PRI').map((c) => c.name));
        } catch {
          setPkCols([]);
        }
      } else {
        setPkCols([]);
      }
      setSumSel(null);
      // 有数据行 → 「数据表」页；写操作/空结果 → 「结果」页（语句执行表，Navicat 式）
      setQresTab(r.result.rows.length > 0 ? 'data' : 'summary');
      if (!opts?.noHistory) { pushHistory(text); highlightRef.current?.(text); }
    } catch (e) {
      setError(errMsg(e));
      setColumns(null);
      setRows([]);
      setHasMore(false);
      setSumSel(null);
      setQresTab('summary');
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  /** 运行（工具栏 / Ctrl+Enter）：编辑器有选中时只跑选中，否则全文 */
  const run = async () => {
    if (busyRef.current) return;
    const text = pickRunText();
    if (text) {
      baseSqlRef.current = text; // 结果筛选的包装基准（用户手动运行 = 重置筛选基准）
      setResWhere('');
      setResOrderBy('');
      setResSort(null);
      await runText(text);
    }
  };

  /** 运行选中的 SQL（编辑器右键菜单）：只执行当前选中文本，无选中不动作 */
  const runSelection = async () => {
    const sel = (selectionRef.current?.() ?? '').trim();
    if (sel) {
      baseSqlRef.current = sel;
      setResWhere('');
      setResOrderBy('');
      setResSort(null);
      await runText(sel);
    }
  };

  /** 解释计划：编辑器有选中时只解释选中，否则全文；MySQL/PG 直接 EXPLAIN 前缀走真实查询，Oracle 需 EXPLAIN PLAN 两步不走此按钮 */
  const runExplain = async () => {
    if (busyRef.current) return;
    const text = pickRunText();
    if (!text) return;
    if (conn?.kind === 'oracle') return;
    const stripped = text.replace(/;\s*$/, '').trim(); // EXPLAIN 只接受单条语句，去掉尾部分号
    await runText(`EXPLAIN ${stripped}`, { noHistory: true });
  };

  /** 脚本运行：编辑器全文按语句切分（识别字符串/注释/$$ 引用）逐条顺序执行，遇错停止；结果区显示逐条日志 */
  const runScriptAll = async () => {
    if (busyRef.current) return;
    const text = (sqlRef.current || '').trim();
    if (!text) return;
    const ai2 = extractAiInstruction(text);
    if (ai2) {
      await runAi(ai2);
      return;
    }
    // 脚本同样过只读/危险确认闸门（按全文判断）
    const blocked = safetyGate(text);
    if (blocked) {
      setError(blocked);
      return;
    }
    busyRef.current = true;
    setLoading(true);
    setError(null);
    setAiAsked(null);
    setScriptResult(null);
    try {
      const prefs = usePrefs.getState().prefs;
      const r = await withTimeout(api.runScript(connId, text, conn?.kind === 'oracle' ? undefined : activeDbRef.current), prefs.queryTimeoutSec, () => { void api.cancelQuery(connId, conn?.kind === 'oracle' ? undefined : activeDbRef.current).catch(() => {}); });
      setScriptResult(r);
      setSumSel(null);
      setQresTab('summary');
      pushHistory(text.replace(/\s+/g, ' ').slice(0, 200));
    } catch (e) {
      setError(errMsg(e));
      setSumSel(null);
      setQresTab('summary');
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  /** 导入 SQL 文件：系统对话框选择 .sql → 读取并整体替换编辑器内容（导入后手动运行/脚本运行） */
  const importSqlFile = async () => {
    const p = await api.openDialog({ kind: 'file', title: '导入 SQL 文件' });
    if (!p) return;
    try {
      const content = await api.readFile(p);
      setEditorSql(content);
    } catch (e) {
      setError(`导入失败：${errMsg(e)}`);
    }
  };

  /** 结果筛选/排序应用（对齐表数据页）：SELECT * FROM (基准SQL) q_result WHERE … ORDER BY …，走真实查询；两项可只填其一 */
  const rerunRes = async (w: string, o: string) => {
    const base = baseSqlRef.current.trim();
    if (!base) return;
    await runText(`SELECT * FROM (\n${base}\n) q_result${w ? ` WHERE ${w}` : ''}${o ? ` ORDER BY ${o}` : ''}`, { noHistory: true });
  };

  /** 结果表头点击排序：客户端对已载入行排序（asc → desc → 取消；NULL 恒沉底） */
  const onResSort = (col: string) => {
    setResSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null));
  };

  /** 结果展示行（ri=原始行索引；应用表头排序后的顺序） */
  const resDisplayRows = useMemo(() => {
    const list = rows.map((row, ri) => ({ ri, row }));
    if (!resSort) return list;
    const { col, dir } = resSort;
    const mul = dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a.row[col];
      const vb = b.row[col];
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mul;
    });
  }, [rows, resSort]);

  /** 「结果」页逐条语句执行表：脚本运行 = 每条语句一行；单语句运行 = 一行；失败语句也展示（含错误信息） */
  type SumRow = { index: number; sql: string; ok: boolean; rows?: number; isAffected?: boolean; ms: number; error?: string };
  const summaryRows = useMemo<SumRow[]>(() => {
    if (scriptResult) {
      return scriptResult.statements.map((s) => ({
        index: s.index,
        sql: s.sql,
        ok: s.ok,
        rows: s.rowCount ?? s.affectedRows,
        isAffected: s.rowCount === undefined && s.affectedRows !== undefined,
        ms: s.elapsedMs,
        error: s.error,
      }));
    }
    if (error && lastSqlRef.current) return [{ index: 1, sql: lastSqlRef.current, ok: false, ms: 0, error }];
    if (columns) {
      return [{ index: 1, sql: lastSqlRef.current, ok: true, rows: isDml ? lastAffected : rows.length, isAffected: isDml, ms: elapsedMs }];
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptResult, error, columns, isDml, lastAffected, elapsedMs, rows.length]);

  /** 导出当前结果集（CSV / JSON / INSERT / Markdown，均基于已取回行本地生成下载） */
  const exportResult = (kindArg: 'csv' | 'json' | 'insert' | 'md') => {
    setExportOpen(false);
    if (!columns || rows.length === 0) return;
    const tableName = sqlSourceTable(baseSqlRef.current);
    if (kindArg === 'csv') {
      const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      const lines = [columns.map((c) => esc(c.name)).join(',')];
      for (const r of rows) lines.push(columns.map((c) => { const v = r[c.name]; return v === null || v === undefined ? '' : esc(String(v)); }).join(','));
      downloadFile(`${tableName}.csv`, 'text/csv;charset=utf-8', '\uFEFF' + lines.join('\r\n'));
    } else if (kindArg === 'json') {
      const data = rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const c of columns) o[c.name] = r[c.name] === undefined ? null : r[c.name];
        return o;
      });
      downloadFile(`${tableName}.json`, 'application/json', JSON.stringify(data, null, 2));
    } else if (kindArg === 'insert') {
      const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
      const lit = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
      const colList = columns.map((c) => q(c.name)).join(', ');
      const stmts = rows.map((r) => `INSERT INTO ${tableName} (${colList}) VALUES (${columns.map((c) => lit(r[c.name])).join(', ')});`);
      downloadFile(`${tableName}_insert.sql`, 'text/sql', stmts.join('\n'));
    } else {
      const row1 = `| ${columns.map((c) => c.name).join(' | ')} |`;
      const sep = `| ${columns.map(() => '---').join(' | ')} |`;
      const body = rows.map((r) => `| ${columns.map((c) => { const v = r[c.name]; return cellCopyText(v, c.dataType); }).join(' | ')} |`);
      downloadFile(`${tableName}.md`, 'text/markdown', [row1, sep, ...body].join('\n'));
    }
  };

  /** 真分页翻页（DBeaver 同款）：按页码整页替换结果集（offset = 页码 × 行数限制） */
  const gotoResPage = async (p: number) => {
    if (busyRef.current || p < 0 || !lastSqlRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const prefs = usePrefs.getState().prefs;
      const lim = resLimit;
      const r = await withTimeout(
        api.runSqlPaged(connId, lastSqlRef.current, p * lim, lim, conn?.kind === 'oracle' ? undefined : activeDbRef.current),
        prefs.queryTimeoutSec,
        () => { void api.cancelQuery(connId, conn?.kind === 'oracle' ? undefined : activeDbRef.current).catch(() => {}); },
      );
      const max = prefs.maxResultRows;
      const next = max > 0 && r.result.rows.length > max ? r.result.rows.slice(0, max) : r.result.rows;
      setColumns(r.result.columns);
      setRows(next);
      setHasMore(max > 0 && next.length >= max ? false : r.hasMore);
      setElapsedMs(r.result.elapsedMs);
      setIsDml(r.result.affectedRows !== undefined);
      setResPage(p);
      setSelCell(null);
      setFetchedAt(fmtNow());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  /** 提交结果集编辑（单表 SELECT）：生成并执行 UPDATE/INSERT/DELETE，成功后重查 */
  const commitChanges = async () => {
    if (committing) return;
    const isPg = conn?.kind === 'postgres';
    const q = (id: string) => (isPg ? `"${id.replace(/"/g, '""')}"` : `\`${id.replace(/`/g, '``')}\``);
    const baseSql = lastSqlRef.current;
    if (!baseSql || pkCols.length === 0) {
      setCommitMsg('当前结果集不可编辑（非单表或无主键）');
      return;
    }
    const srcTbl = sqlSourceTable(baseSql);
    const dot = srcTbl.indexOf('.');
    const qTable = dot >= 0 ? `${q(srcTbl.slice(0, dot))}.${q(srcTbl.slice(dot + 1))}` : q(srcTbl);
    const stmts = buildChangeStatements({
      q,
      qTable,
      columns: columns ?? [],
      pkCols,
      baseRows: resDisplayRows,
      edits,
      deleted,
      newRows,
    });
    if (stmts.length === 0) {
      setCommitMsg('没有待提交的改动');
      return;
    }
    setCommitting(true);
    setCommitMsg(null);
    try {
      for (const sql of stmts) {
        await api.runSql(connId, sql, isPg ? activeDbRef.current ?? undefined : undefined);
      }
      setEdits({});
      setDeleted(new Set());
      setNewRows([]);
      setCommitMsg(`已提交 ${stmts.length} 条语句`);
      await runText(baseSql, { noHistory: true });
    } catch (e) {
      setCommitMsg(`提交失败：${errMsg(e)}`);
    } finally {
      setCommitting(false);
    }
  };

  /** 回滚：丢弃所有未提交的编辑/新增/删除 */
  const rollbackChanges = () => {
    setEdits({});
    setDeleted(new Set());
    setNewRows([]);
    setCommitMsg(null);
  };

  /** 编辑器高度（可拖拽分隔条调整，默认 45% 面板高、至少 160px） */
  const [editorH, setEditorH] = useState(() => Math.max(160, Math.round(window.innerHeight * 0.45)));
  const editorDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onSplitMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    editorDragRef.current = { startY: e.clientY, startH: editorH };
    const move = (ev: MouseEvent) => {
      if (!editorDragRef.current) return;
      const max = Math.max(200, window.innerHeight - 320);
      const next = Math.min(max, Math.max(100, editorDragRef.current.startH + (ev.clientY - editorDragRef.current.startY)));
      setEditorH(next);
    };
    const up = () => {
      editorDragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const connKindLabel = conn?.kind === 'mysql' ? 'MySQL' : conn?.kind === 'postgres' ? 'PostgreSQL' : conn?.kind === 'oracle' ? 'Oracle' : conn?.kind ?? '';

  // 自动刷新：开启后每 5 秒重跑当前结果页（有查询时）。用 ref 取最新回调/页码，避免每次渲染重建定时器
  const gotoResPageRef = useRef(gotoResPage);
  gotoResPageRef.current = gotoResPage;
  const resPageRef = useRef(resPage);
  resPageRef.current = resPage;
  useEffect(() => {
    if (!autoRefresh) return;
    if (!lastSqlRef.current) return;
    const h = window.setInterval(() => { void gotoResPageRef.current(resPageRef.current); }, 5000);
    return () => window.clearInterval(h);
  }, [autoRefresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* 顶部工具栏（Navicat 图标式）：左=运行/脚本/格式化/解释/历史/保存；右=连接信息 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2 text-[length:calc(var(--pref-fs)*0.786)]">
        <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-[length:calc(var(--pref-fs)*0.786)] text-success" onClick={() => void run()} disabled={loading} title="运行（Ctrl/⌘+Enter）：有选中只跑选中，否则全文">
          <Icon name="play" className="h-3.5 w-3.5" strokeWidth={2.4} />运行
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => void runScriptAll()} disabled={loading} title="脚本运行（Ctrl/⌘+Shift+Enter）：全文按语句切分逐条执行">脚本运行</Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={formatSql} disabled={loading} title="格式化 SQL（有选中只格式化选中）">格式化</Button>
        {conn?.kind !== 'oracle' && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => void runExplain()} disabled={loading} title="EXPLAIN 当前语句">解释计划</Button>
        )}
        {history.length > 0 && (
          <select value="" onChange={(e) => { const s = e.target.value; if (s) setEditorSql(s); e.target.value = ''; }} className="h-7 w-[104px] shrink-0 cursor-pointer rounded border border-transparent bg-transparent px-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground outline-none transition-colors hover:border-border hover:bg-secondary hover:text-foreground" title="本连接最近执行过的 SQL（点击回填）">
            <option value="">历史 ({history.length})</option>
            {history.map((s, i) => (<option key={i} value={s}>{s.replace(/\s+/g, ' ').slice(0, 70)}</option>))}
          </select>
        )}
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => setSaveDlg(true)} title="保存脚本（Ctrl/⌘+S）">保存</Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => void importSqlFile()} title="导入 SQL 文件">导入</Button>
        <span className="flex-1" />
        {/* 右侧连接信息（Navicat 式） */}
        {conn && (
          <div className="flex shrink-0 items-center gap-2 text-[length:calc(var(--pref-fs)*0.786)]">
            <span className="flex items-center gap-1 rounded border border-border bg-secondary px-1.5 py-0.5 text-foreground">
              <Icon name="database" className="h-3.5 w-3.5" strokeWidth={1.8} />{conn.name}<span className="text-muted-foreground">∨</span>
            </span>
            <button className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" title="设为默认连接">设为默认</button>
            {dbOptions.length > 0 ? (
              <span className="flex items-center gap-1 rounded border border-border bg-secondary px-1.5 py-0.5 text-foreground">
                <Icon name="database" className="h-3.5 w-3.5" strokeWidth={1.8} />
                <select value={currentDb ?? ''} onChange={(e) => void switchDb(e.target.value)} className="cursor-pointer bg-transparent outline-none" title="切换当前库 / 模式（MySQL=库 / PG=库 / Oracle=模式）">
                  {dbOptions.map((d) => (<option key={d} value={d}>{d}</option>))}
                </select>
                <span className="text-muted-foreground">∨</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-muted-foreground"><Icon name="database" className="h-3.5 w-3.5" strokeWidth={1.8} />{connKindLabel}<span>∨</span></span>
            )}
          </div>
        )}
      </div>

      {/* 编辑器（上块）：行号槽 ▶ = 逐行运行 */}
      <div className="shrink-0 overflow-hidden border-b border-border" style={{ height: editorH }} onContextMenu={(e) => { e.preventDefault(); setSqlMenu({ x: e.clientX, y: e.clientY }); }}>
        <SqlEditor initialValue={initSql} schema={schema} dialect={conn?.kind === 'postgres' ? 'postgres' : conn?.kind === 'mysql' ? 'mysql' : undefined} onRun={() => void run()} onRunScript={() => void runScriptAll()} onSave={() => setSaveDlg(true)} injectRef={injectRef} selectionRef={selectionRef} highlightRef={highlightRef} onChange={(v) => { sqlRef.current = v; persistSql(v); }} onRunLine={(line) => { const t = line.trim(); if (!t) return; baseSqlRef.current = t; setResWhere(''); setResOrderBy(''); setResSort(null); void runText(t); }} />
      </div>

      {/* 可拖拽分隔（细线，hover 高亮） */}
      <div onMouseDown={onSplitMouseDown} className="group h-1 shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary" title="拖动调整编辑器高度" />

      {aiAsked !== null ? (
        /* @ai 回答面板 */
        <div className="min-h-0 flex-1 overflow-auto bg-background">
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2 text-[length:calc(var(--pref-fs)*0.786)]">
              <span className="rounded-md border border-border bg-secondary px-1.5 py-px text-[10px] text-secondary-foreground">AI</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={aiAsked}>{aiAsked}</span>
              {!aiStreaming && aiAnswer && (<>
                <Button variant="outline" size="sm" className="h-6 px-2 text-[length:calc(var(--pref-fs)*0.714)]" onClick={() => setEditorSql(extractSql(aiAnswer))} title="提取回答中的 SQL 替换编辑器内容">填入编辑器</Button>
                <Button variant="outline" size="sm" className="h-6 px-2 text-[length:calc(var(--pref-fs)*0.714)]" onClick={() => { setAiAsked(null); setAiAnswer(''); }}>关闭</Button>
              </>)}
            </div>
            {aiAnswer ? <Markdown text={aiAnswer} /> : <pre className="whitespace-pre-wrap rounded border border-border bg-background p-2 font-mono text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">{aiStreaming ? '思考中…' : ''}</pre>}
          </div>
        </div>
      ) : (
        /* 结果区（下块，单栏） */
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 结果顶部条：结果标签 + 字段筛选 / DDL */}
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2 text-[length:calc(var(--pref-fs)*0.786)]">
            <span className="max-w-[240px] shrink-0 truncate rounded bg-foreground px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-background" title={lastSqlRef.current}>{sqlSourceTable(lastSqlRef.current) !== 'query_result' ? sqlSourceTable(lastSqlRef.current) : '结果'}</span>
            <span className="flex-1" />
            <button className={`rounded px-1.5 py-0.5 transition-colors hover:bg-secondary hover:text-foreground ${showFilter ? 'text-primary' : 'text-muted-foreground'}`} onClick={() => setShowFilter((v) => !v)} title="字段筛选（WHERE / ORDER BY）">字段筛选</button>
            <button className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" onClick={() => { const t = sqlSourceTable(lastSqlRef.current); if (t !== 'query_result') { const ddl = `SHOW CREATE TABLE ${t}`; baseSqlRef.current = ddl; void runText(ddl); } }} title="查看建表 DDL">DDL</button>
            <span className="text-muted-foreground">∨</span>
          </div>

          {/* 结果标签栏 + 右侧操作栏 */}
          <div className="flex h-9 shrink-0 items-center border-b border-border text-[length:calc(var(--pref-fs)*0.786)]">
            <div className="flex h-full">
              <QResTab label="数据表" badge={scriptResult ? undefined : columns ? String(rows.length) : undefined} active={qresTab === 'data'} onClick={() => setQresTab('data')} />
              <QResTab label="结果" active={qresTab === 'summary'} onClick={() => setQresTab('summary')} />
              <QResTab label="图表" active={qresTab === 'chart'} onClick={() => setQresTab('chart')} />
              <QResTab label="消息" badge={error ? '!' : undefined} active={qresTab === 'message'} onClick={() => setQresTab('message')} />
              <select value={resLimit} onChange={(e) => { const lim = Number(e.target.value); setResLimit(lim); if (lastSqlRef.current) void runText(lastSqlRef.current, { lim }); }} className="h-7 cursor-pointer self-center rounded border border-transparent bg-transparent px-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground outline-none hover:border-border" title="结果行数上限（修改后立即重新查询）">
                {LIMITS.map((l: number) => (<option key={l} value={l}>{l === 0 ? '全部行' : `${l} 行`}</option>))}
              </select>
            </div>
            <div className="relative ml-auto flex h-full items-center gap-1 border-l border-border pl-2 pr-2">
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => void runExplain()} disabled={loading} title="执行计划">执行计划</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => setExportOpen((o) => !o)} disabled={!columns || rows.length === 0} title="保存结果">保存结果</Button>
              {exportOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 min-w-[150px] rounded-md border border-border bg-background p-1 shadow-xl">
                  {([['csv', 'CSV（Excel 可开）'], ['json', 'JSON 数据'], ['insert', 'INSERT 语句'], ['md', 'Markdown 表格']] as const).map(([k, label]) => (
                    <Button key={k} variant="ghost" size="sm" className="h-7 w-full justify-start px-2.5 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => exportResult(k)}>{label}</Button>
                  ))}
                </div>
              )}
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => { if (lastSqlRef.current) void runText(lastSqlRef.current); }} disabled={loading} title="刷新（重跑当前查询）">刷新</Button>
              <Button size="sm" variant="ghost" className={`h-6 px-2 text-[length:calc(var(--pref-fs)*0.786)] ${autoRefresh ? 'text-primary' : ''}`} onClick={() => setAutoRefresh((v) => !v)} title="自动刷新（每 5 秒重跑当前页）">自动</Button>
              <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[length:calc(var(--pref-fs)*0.786)] text-success" onClick={() => setNewRows((a) => [...a, {}])} title="新增一行（提交时生成 INSERT）"><Icon name="plus" className="h-3 w-3" strokeWidth={2.4} />新建行</Button>
              <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[length:calc(var(--pref-fs)*0.786)] text-destructive" onClick={() => selCell && setDeleted((s) => { const n = new Set(s); n.add(selCell.ri); return n; })} disabled={!selCell} title="删除选中行（提交时生成 DELETE）"><Icon name="trash" className="h-3 w-3" strokeWidth={2} />删除行</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={() => void commitChanges()} disabled={committing || pkCols.length === 0}>提交</Button>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[length:calc(var(--pref-fs)*0.786)]" onClick={rollbackChanges} title="回滚：丢弃所有未提交改动">回滚</Button>
              {commitMsg && <span className={`ml-1 shrink-0 text-[length:calc(var(--pref-fs)*0.786)] ${commitMsg.startsWith('提交失败') ? 'text-destructive' : 'text-success'}`}>{commitMsg}</span>}
            </div>
          </div>

          {/* 内容区 */}
          <div className="min-h-0 flex-1 overflow-auto">
            {showFilter && columns && (
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
                <FilterInput className="flex-[3]" value={resWhere} onChange={setResWhere} onSubmit={() => void rerunRes(resWhere.trim(), resOrderBy.trim())} onClear={() => { setResWhere(''); void rerunRes('', resOrderBy.trim()); }} fields={columns.map((c) => c.name)} keywords={['and', 'or', 'not', 'like', 'in', 'is null', 'is not null', 'between']} placeholder="条件，如 id = 1 and name like '%a%'" title="回车对当前结果追加 WHERE 条件（包装子查询走真实查询）；Esc 或 ✕ 清空恢复全量" label="where" icon={<Icon name="filter" className="h-3.5 w-3.5" strokeWidth={1.8} />} />
                <FilterInput className="flex-[2]" value={resOrderBy} onChange={setResOrderBy} onSubmit={() => void rerunRes(resWhere.trim(), resOrderBy.trim())} onClear={() => { setResOrderBy(''); void rerunRes(resWhere.trim(), ''); }} fields={columns.map((c) => c.name)} keywords={['asc', 'desc']} placeholder="如 created_at desc, id asc" title="回车对当前结果追加 ORDER BY；Esc 或 ✕ 清空" label="order by" icon={<Icon name="sort" className="h-3.5 w-3.5" strokeWidth={1.8} />} />
              </div>
            )}
            {qresTab === 'chart' ? (
              <div className="p-6 text-center text-[length:calc(var(--pref-fs)*0.857)] text-muted-foreground">图表视图（待实现：选择数值列后可生成柱状 / 折线图）</div>
            ) : qresTab === 'message' ? (
              <div className="p-3 font-mono text-[length:calc(var(--pref-fs)*0.786)]">
                {error ? <div className="whitespace-pre-wrap text-destructive">{error}</div> : <div className="text-muted-foreground">无消息{elapsedMs > 0 ? ` · 上次执行耗时 ${elapsedMs} ms${fetchedAt ? ` · ${fetchedAt}` : ''}` : ''}</div>}
              </div>
            ) : qresTab === 'summary' ? (
              <div className="min-h-0 flex-1 overflow-auto p-3">
                {summaryRows.length === 0 ? (
                  <div className="text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">执行 SQL 后在此查看逐条语句执行结果</div>
                ) : (
                  <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="w-10 px-2 py-1 font-medium">#</th>
                        <th className="px-2 py-1 font-medium">语句</th>
                        <th className="w-20 px-2 py-1 font-medium">状态</th>
                        <th className="w-16 px-2 py-1 text-right font-medium">行数</th>
                        <th className="w-20 px-2 py-1 text-right font-medium">耗时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRows.map((s) => (
                        <tr key={s.index} className={`cursor-pointer border-b border-border/50 transition-colors hover:bg-secondary/60 ${sumSel === s.index ? 'bg-secondary' : ''}`} onClick={() => { setSumSel(s.index); if (s.ok && !scriptResult) setQresTab('data'); }}>
                          <td className="px-2 py-1 tabular-nums text-muted-foreground">{s.index}</td>
                          <td className="max-w-[420px] truncate px-2 py-1 font-mono" title={s.sql}>{s.sql.replace(/\s+/g, ' ').slice(0, 90)}</td>
                          <td className="px-2 py-1">{s.ok ? <span className="text-success">成功</span> : <span className="text-destructive" title={s.error}>失败</span>}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{s.rows ?? '-'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{s.ms} ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : columns ? (
              /* 数据表页：结果网格，复用表数据页的 EditableGrid */
              <EditableGrid
                columns={columns}
                pkCols={pkCols}
                displayRows={resDisplayRows}
                newRows={newRows}
                edits={edits}
                deleted={deleted}
                editing={null}
                selected={selCell?.ri ?? null}
                curCol={selCell?.col ?? null}
                selRows={EMPTY_SET_NUM}
                selCols={EMPTY_SET_STR}
                editable={pkCols.length > 0 && !isDml}
                sort={resSort}
                onCellDblClick={() => {}}
                onCellChange={(ri, col, val) => setEdits((m) => ({ ...m, [`${ri}::${col}`]: val }))}
                onEditEnd={() => {}}
                onCommitShortcut={() => { void commitChanges(); }}
                onNewChange={(i, col, val) => setNewRows((arr) => arr.map((r, idx) => (idx === i ? { ...r, [col]: val } : r)))}
                onCellMouseDown={(ri, col) => setSelCell({ ri, col })}
                onCellMouseEnter={() => {}}
                onHeaderMouseDown={() => {}}
                onHeaderMouseEnter={() => {}}
                onGutterMouseDown={() => {}}
                onGutterMouseEnter={() => {}}
                onSort={onResSort}
                isPg={conn?.kind === 'postgres'}
              />
            ) : (
              <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">执行 SQL 查看结果（Ctrl/⌘+Enter 运行 · 有选中只跑选中 · Ctrl/⌘+Shift+Enter 脚本运行 · 输入 @ai 提问让 AI 生成或查询）</div>
            )}
          </div>

          {/* 底部状态栏（结果页脚：行数/耗时/SQL/分页/导出） */}
          <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
            <span className="shrink-0 tabular-nums">共 {rows.length} 行{hasMore ? '+' : ''}</span>
            {elapsedMs > 0 && <span className="shrink-0 tabular-nums">{elapsedMs} ms</span>}
            {lastSqlRef.current && <span className="min-w-0 flex-1 truncate font-mono" title={lastSqlRef.current}>{lastSqlRef.current.replace(/\s+/g, ' ').slice(0, 120)}</span>}
            <span className="flex-1" />
            {selCell && <span className="shrink-0 tabular-nums">1 个单元 1 行</span>}
            <span className="shrink-0 tabular-nums">{resLimit === 0 ? '全部行' : `${resLimit} 行/页`}</span>
            <button className="px-1 disabled:opacity-40" onClick={() => void gotoResPage(0)} disabled={loading || resPage === 0} title="第一页">«</button>
            <button className="px-1 disabled:opacity-40" onClick={() => void gotoResPage(resPage - 1)} disabled={loading || resPage === 0} title="上一页">‹</button>
            <span className="min-w-[1.8rem] rounded border border-border bg-background px-1 text-center tabular-nums">{resPage + 1}</span>
            <button className="px-1 disabled:opacity-40" onClick={() => void gotoResPage(resPage + 1)} disabled={loading || !hasMore} title="下一页">›</button>
            <button className="px-1 disabled:opacity-40" onClick={() => void gotoResPage(999999)} disabled={loading || !hasMore} title="最后一页">»</button>
            <button className="px-1 transition-colors hover:text-foreground disabled:opacity-40" onClick={() => setExportOpen((o) => !o)} disabled={!columns || rows.length === 0} title="导出">导出 ⤓</button>
          </div>
        </div>
      )}

      {/* 编辑器右键菜单：运行 / 运行选中 / 脚本运行 / 格式化 / 导入 SQL */}
      {sqlMenu && (
        <ContextMenu x={sqlMenu.x} y={sqlMenu.y} onClose={() => setSqlMenu(null)} items={[
          { label: '运行', onClick: () => void run(), disabled: loading },
          { label: '运行选中', onClick: () => void runSelection(), disabled: loading || !(selectionRef.current?.() ?? '').trim() },
          { label: '脚本运行', onClick: () => void runScriptAll(), disabled: loading },
          { separator: true, label: '' },
          { label: '格式化', onClick: formatSql },
          { separator: true, label: '' },
          { label: '导入 SQL', onClick: () => void importSqlFile(), disabled: loading },
        ]} />
      )}

      {/* Ctrl+S 保存脚本弹框 */}
      {saveDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={() => setSaveDlg(false)}>
          <div className="w-72 rounded-lg border border-border bg-muted p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-2 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">保存脚本</div>
            <Input autoFocus value={scriptName} onChange={(e) => setScriptName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitSaveScript(); if (e.key === 'Escape') setSaveDlg(false); }} placeholder="输入脚本名称" className="h-8 bg-background text-[length:calc(var(--pref-fs)*0.786)]" />
            <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">同名脚本将覆盖内容 · 保存到左侧连接树「脚本」节点</div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setSaveDlg(false)}>取消</Button>
              <Button variant="default" size="sm" onClick={() => submitSaveScript()}>保存</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// downloadFile 已迁移至 ./shared（见 shared.tsx）
