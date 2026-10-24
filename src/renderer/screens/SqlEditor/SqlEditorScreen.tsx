import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SqlEditor } from '@renderer/components/workbench/SqlEditor';
import { DataGrid } from '@renderer/components/common/DataGrid';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { ErrorBox, Loading } from '@renderer/components/common/States';
import { Button } from '@renderer/components/ui/button';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import { format as formatSqlText } from 'sql-formatter';
import type { QueryResult } from '@shared/types';

/**
 * ② SQL 编辑器屏幕（真实实现，CodeMirror 6）。
 *
 * 选一条已连接的 MySQL / PostgreSQL / Oracle，左侧列出真实表（可展开列），
 * 右侧 CodeMirror 编辑器写 SQL，具备：
 * - 智能补全：表名 / 列名 / 函数 / 关键字（由 `listSchemaColumns` 内省后按库喂入）；
 * - 一键格式化（sql-formatter，优先格式化选中文本）；
 * - 运行 / 运行选中 / 执行计划 / 保存脚本；
 * 「执行计划」对 MySQL/PG 跑 EXPLAIN 并图形化展示（扫描类型彩色徽章 / PG 计划树）。
 *
 * @since 0.1.0
 */
export function SqlEditorScreen() {
  const selectedId = useConnections((s) => s.selectedId);
  const connections = useConnections((s) => s.connections);
  const [connId, setConnId] = useState<string | null>(null);
  const conn = connections.find((c) => c.id === connId);
  const [db, setDb] = useState('');
  const [databases, setDatabases] = useState<string[]>([]);
  const [schema, setSchema] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<QueryResult | null>(null);
  const [plan, setPlan] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'result' | 'message' | 'plan'>('result');
  const [info, setInfo] = useState<string | null>(null);

  const sqlRef = useRef('SELECT 1;');
  const injectRef = useRef<((v: string) => void) | null>(null);
  const selectionRef = useRef<(() => string) | null>(null);
  const insertRef = useRef<((v: string) => void) | null>(null);

  /** 加载某库的表→列元数据，喂给编辑器补全 */
  const loadSchema = (cid: string, dbName?: string) => {
    api
      .listSchemaColumns(cid, dbName)
      .then((m) => {
        if (Object.keys(m).length > 0) setSchema(m);
      })
      .catch(() => undefined);
  };

  useEffect(() => { if (selectedId && !connId) setConnId(selectedId); }, [selectedId, connId]);

  // 连接变化：拉库列表 + 解析当前库并加载其 schema
  useEffect(() => {
    if (!connId) { setDatabases([]); setSchema({}); setDb(''); return; }
    let alive = true;
    api.listDatabases(connId).then((opts) => alive && setDatabases(opts)).catch(() => undefined);
    const curSql =
      conn?.kind === 'mysql' ? 'SELECT DATABASE() AS db'
      : conn?.kind === 'postgres' ? 'SELECT current_database() AS db'
      : "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS db FROM dual";
    api
      .runSql(connId, curSql)
      .then((r) => {
        if (!alive) return;
        const v = r?.rows[0]?.db ? String(r.rows[0].db) : undefined;
        const dbName = v ?? conn?.database ?? undefined;
        if (dbName) { setDb(dbName); loadSchema(connId, dbName); }
        else loadSchema(connId, undefined);
      })
      .catch(() => alive && loadSchema(connId, undefined));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const switchDb = (dbName: string) => {
    setDb(dbName);
    if (connId) loadSchema(connId, dbName);
  };

  /** 轻量危险操作守卫：DROP/TRUNCATE 或 DELETE/UPDATE 无 WHERE 时二次确认 */
  const needsConfirm = (text: string): boolean => {
    if (!/^\s*(delete|update|drop|truncate)\b/i.test(text)) return false;
    if (/^\s*(drop|truncate)\b/i.test(text)) return true;
    return !/\bwhere\b/i.test(text);
  };

  const run = async (text?: string) => {
    if (!connId) { setError('请先选择一条已连接的数据库'); return; }
    const sqlText = (text ?? '').trim() || sqlRef.current.trim();
    if (!sqlText) return;
    if (!text && needsConfirm(sqlText) &&
      !window.confirm(`即将执行写操作：\n${sqlText.slice(0, 240)}\n\n确认执行？`)) return;
    setRunning(true); setError(null); setInfo(null);
    try {
      const res = await api.runSql(connId, sqlText);
      setResult(res); setTab('result'); setPlan(null);
    } catch (e) {
      setError((e as Error).message); setResult(null);
    } finally { setRunning(false); }
  };

  const runSelection = () => {
    const sel = (selectionRef.current?.() ?? '').trim();
    if (sel) void run(sel);
    else void run();
  };

  const showPlan = async () => {
    if (!connId) { setError('请先选择一条已连接的数据库'); return; }
    const sqlText = sqlRef.current.trim();
    if (!sqlText) return;
    const explainSql =
      conn?.kind === 'postgres' ? `EXPLAIN (FORMAT JSON) ${sqlText}`
      : conn?.kind === 'mysql' ? `EXPLAIN ${sqlText}`
      : `EXPLAIN ${sqlText}`;
    setError(null); setRunning(true);
    try {
      const res = await api.runSql(connId, explainSql);
      setPlan(res); setTab('plan');
    } catch (e) {
      setError(`执行计划失败：${(e as Error).message}`);
    } finally { setRunning(false); }
  };

  const formatSql = () => {
    const raw = (selectionRef.current?.().trim() || sqlRef.current || '').trim();
    if (!raw) return;
    const lang = conn?.kind === 'postgres' ? 'postgresql' : conn?.kind === 'mysql' ? 'mysql' : 'sql';
    try {
      const pretty = formatSqlText(raw, { language: lang, keywordCase: 'upper', tabWidth: 2 });
      injectRef.current?.(pretty);
    } catch { /* 语法不合法时保持原样 */ }
  };

  const saveSql = async () => {
    if (!connId) { setError('请先选择连接再保存脚本'); return; }
    const name = window.prompt('脚本名称：', '未命名查询');
    if (!name) return;
    try {
      await api.saveScript(connId, name, sqlRef.current);
      setInfo(`已保存脚本「${name}」`); setError(null);
    } catch (e) {
      setError(`保存失败：${(e as Error).message}`);
    }
  };

  const dialect = conn?.kind === 'postgres' ? 'postgres' : conn?.kind === 'mysql' ? 'mysql' : undefined;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-sm font-semibold text-foreground">SQL 编辑器</span>
        <ConnectionPicker kind={['mysql', 'postgres', 'oracle']} value={connId} onChange={setConnId} placeholder="选择数据库…" />
        {databases.length > 0 && (
          <select value={db} onChange={(e) => switchDb(e.target.value)} className="h-8 w-auto max-w-[200px] rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="">（当前库）</option>
            {databases.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        {info && <span className="text-[11px] text-success">{info}</span>}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 对象树（Navicat 风格：表可展开列） */}
        <ObjectTree schema={schema} onInsert={(t) => insertRef.current?.(t)} onSelectAll={(t) => insertRef.current?.(`SELECT * FROM ${t} LIMIT 200;\n`)} />

        {/* 编辑 + 结果 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            <Button size="sm" onClick={() => void run()} disabled={running}>运行</Button>
            <ToolBtn onClick={runSelection} disabled={running}>运行选中</ToolBtn>
            <ToolBtn onClick={() => void showPlan()} disabled={running}>执行计划</ToolBtn>
            <ToolBtn onClick={formatSql}>格式化</ToolBtn>
            <ToolBtn onClick={() => void saveSql()}>保存</ToolBtn>
            <span className="ml-auto pr-2 text-[11px] text-muted-foreground">Ctrl/⌘+Enter 运行 · Ctrl/⌘+Shift+Enter 脚本运行 · Ctrl/⌘+S 保存</span>
          </div>

          <div className="h-2/5 min-h-[160px] shrink-0 border-b border-border">
            <SqlEditor
              initialValue="SELECT 1;"
              schema={schema}
              dialect={dialect}
              onRun={() => void run()}
              onRunScript={() => void run()}
              onSave={() => void saveSql()}
              injectRef={injectRef}
              selectionRef={selectionRef}
              insertRef={insertRef}
              onChange={(v) => { sqlRef.current = v; }}
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col bg-background">
            <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
              <Tab label="结果" badge={result ? String(result.rowCount) : undefined} active={tab === 'result'} onClick={() => setTab('result')} />
              <Tab label="消息" active={tab === 'message'} onClick={() => setTab('message')} />
              <Tab label="执行计划" active={tab === 'plan'} onClick={() => setTab('plan')} />
              {result && (
                <div className="ml-auto pr-2 text-[11px] text-muted-foreground">{result.rowCount} 行 · {result.elapsedMs}ms</div>
              )}
            </div>
            {tab === 'result' && (running ? <Loading text="执行中…" /> : error ? <ErrorBox message={error} onRetry={() => void run()} /> : result ? <DataGrid result={result} /> : <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">点击「运行」执行 SQL</div>)}
            {tab === 'message' && <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">{error ?? info ?? '无消息'}</div>}
            {tab === 'plan' && (plan ? <ExplainView plan={plan} dialect={conn?.kind ?? 'mysql'} /> : <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">点击「执行计划」查看</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- 工具栏 / Tab ----------------------------- */

function ToolBtn({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

function Tab({ label, badge, active, onClick }: { label: string; badge?: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex h-full items-center gap-2 border-b-2 px-3 text-[13px] transition-colors ${active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
      <span>{label}</span>
      {badge && <span className="rounded-full bg-secondary px-1.5 text-[10px] text-muted-foreground">{badge}</span>}
    </button>
  );
}

/* ----------------------------- 对象树 ----------------------------- */

function ObjectTree({ schema, onInsert, onSelectAll }: {
  schema: Record<string, string[]>;
  onInsert: (text: string) => void;
  onSelectAll: (qualified: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tables = Object.keys(schema).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const toggle = (t: string) => setExpanded((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });
  const display = (t: string) => t.split('.').pop() ?? t;

  return (
    <div className="w-[240px] shrink-0 overflow-y-auto border-r border-border bg-background py-1 text-[12px] mono">
      <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">对象 ({tables.length})</div>
      {tables.map((t) => {
        const open = expanded.has(t);
        return (
          <div key={t}>
            <div className="group flex items-center gap-1 px-1.5 py-1 hover:bg-secondary">
              <button onClick={() => toggle(t)} className="w-3 text-muted-foreground">{open ? '▾' : '▸'}</button>
              <button
                onClick={() => onInsert(t)}
                onDoubleClick={() => onSelectAll(t)}
                title={`点击插入「${t}」；双击生成 SELECT`}
                className="flex-1 truncate text-left text-foreground hover:text-primary"
              >
                {display(t)}
              </button>
            </div>
            {open && (schema[t] ?? []).map((c) => (
              <button
                key={c}
                onClick={() => onInsert(c)}
                title={`插入列「${c}」`}
                className="block w-full truncate py-0.5 pl-8 pr-2 text-left text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                {c}
              </button>
            ))}
          </div>
        );
      })}
      {tables.length === 0 && <div className="px-3 py-3 text-[11px] text-muted-foreground">无表或连接异常</div>}
    </div>
  );
}

/* ----------------------------- 执行计划可视化 ----------------------------- */

function ExplainView({ plan, dialect }: { plan: QueryResult; dialect: string }) {
  // PostgreSQL：EXPLAIN (FORMAT JSON) → 解析成计划树
  if (dialect === 'postgres') {
    const col = plan.columns.find((c) => c.name.toLowerCase() === 'query plan');
    if (col) {
      try {
        const raw = plan.rows[0]?.[col.name];
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const root = Array.isArray(parsed) ? parsed[0]?.Plan : parsed?.Plan;
        if (root) return <PgPlanTree node={root} depth={0} />;
      } catch { /* 回退 */ }
    }
  }
  // MySQL：EXPLAIN 返回表格 → 彩色徽章视图
  const typeCol = plan.columns.find((c) => c.name.toLowerCase() === 'type');
  if (dialect === 'mysql' && typeCol) return <MysqlExplain plan={plan} />;
  return <DataGrid result={plan} />;
}

function MySqlScanBadge({ type }: { type: string }) {
  const t = (type ?? '').toUpperCase();
  const color =
    t === 'ALL' ? 'bg-destructive/15 text-destructive'
    : t === 'INDEX' ? 'bg-warn/15 text-warning'
    : ['RANGE', 'REF', 'EQ_REF', 'CONST', 'SYSTEM', 'UNIQUE_SUBQUERY', 'INDEX_SUBQUERY'].includes(t) ? 'bg-success/15 text-success'
    : 'bg-secondary text-muted-foreground';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${color}`}>{type}</span>;
}

function MysqlExplain({ plan }: { plan: QueryResult }) {
  const rows = plan.rows;
  const fullScans = rows.filter((r) => String(r.type).toUpperCase() === 'ALL' && !r.key);
  const cols = ['id', 'select_type', 'table', 'type', 'key', 'rows', 'Extra'];
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-[12px]">
        <span className="text-muted-foreground">共 {rows.length} 步</span>
        {fullScans.length > 0 && <span className="rounded bg-destructive/15 px-2 py-0.5 text-destructive">⚠ {fullScans.length} 处全表扫描</span>}
        <span className="text-muted-foreground">绿=索引访问 · 橙=索引扫描 · 红=全表扫描</span>
      </div>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-muted text-muted-foreground">
            {cols.map((h) => <th key={h} className="px-2 py-1 text-left font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border">
              <td className="px-2 py-1 tabular-nums">{String(r.id)}</td>
              <td className="px-2 py-1 text-muted-foreground">{String(r.select_type)}</td>
              <td className="px-2 py-1">{String(r.table)}</td>
              <td className="px-2 py-1"><MySqlScanBadge type={String(r.type)} /></td>
              <td className="px-2 py-1">{r.key ? <span className="text-success">{String(r.key)}</span> : <span className="text-muted-foreground">NULL</span>}</td>
              <td className="px-2 py-1 tabular-nums">{String(r.rows)}</td>
              <td className="px-2 py-1 text-muted-foreground">{String(r.Extra)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PgNodeBadge({ type }: { type: string }) {
  const t = type ?? '';
  const color =
    /Seq Scan/.test(t) ? 'bg-destructive/15 text-destructive'
    : /Index (Only )?Scan/.test(t) ? 'bg-success/15 text-success'
    : /Bitmap/.test(t) ? 'bg-warn/15 text-warning'
    : /Join|Nested Loop|Hash|Merge/.test(t) ? 'bg-primary/15 text-primary'
    : 'bg-secondary text-muted-foreground';
  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${color}`}>{t}</span>;
}

function PgPlanTree({ node, depth }: { node: Record<string, unknown>; depth: number }) {
  const kids = (node.Plans as Record<string, unknown>[]) ?? [];
  const relation = node['Relation Name'] as string | undefined;
  const alias = node.Alias as string | undefined;
  return (
    <div style={{ marginLeft: depth ? 16 : 0 }}>
      <div className="flex flex-wrap items-center gap-2 border-l border-border py-1 pl-2 text-[12px]">
        <PgNodeBadge type={node['Node Type'] as string} />
        {relation && <span className="text-foreground">{relation}{alias && alias !== relation ? ` (${alias})` : ''}</span>}
        <span className="text-muted-foreground">cost={String(node['Total Cost'])} rows={String(node['Plan Rows'])}</span>
        {node['Index Name'] != null && <span className="text-success">· {String(node['Index Name'])}</span>}
        {node.Filter != null && <span className="text-warning">· filter</span>}
      </div>
      {kids.map((k, i) => <PgPlanTree key={i} node={k} depth={depth + 1} />)}
    </div>
  );
}
