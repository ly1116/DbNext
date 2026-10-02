import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/api';
import { useAppStore, type DbTab } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import { useScriptStore } from '@renderer/store/scriptStore';
import { usePrefs } from '@renderer/store/prefsStore';
import type { DbColumn, DbColumnAlterSpec, DbColumnSpec, DbForeignKey, DbIndex, DbObjectDef, DbObjectMeta, DbSequenceInfo, DbTrigger, DbUser, DbUserPrivEdit, DbUserPrivilege, DbUserSpec, QueryColumn, QueryResult, ScriptResult } from '@shared/types';
import { ErrorBox } from '@renderer/components/common/States';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { CreateTableDialog } from '@renderer/components/common/CreateTableDialog';
import { SqlEditor } from '@renderer/components/workbench/SqlEditor';
import { ConnIcon } from '@renderer/components/workbench/DbTree';
import { RedisScreen } from '@renderer/screens/Redis/RedisScreen';
import { shortTypeName } from '@renderer/utils/dbTypes';
import { format as formatSqlText } from 'sql-formatter';

/**
 * 工作台中间区「数据库标签页」内容区。
 *
 * 标签栏由 WorkbenchScreen 渲染（终端标签 + 数据库标签并列）；
 * 本组件仅负责渲染当前激活的表数据 / SQL 查询标签内容。
 *
 * - 表数据标签：DBeaver 风格数据网格——顶部图标工具栏（刷新/提交/回滚/增删行/导出）、
 *   表头点击排序、筛选栏（where / order by 原生表达式）、底部状态栏（行数/耗时/导出/行数限制）；
 *   主键驱动 UPDATE/DELETE，新增行构造 INSERT；
 * - SQL 查询标签：编辑器 + 只读结果集。
 *
 * @since 0.2.0
 */
export function DbDataTabs() {
  const activeDbTab = useAppStore((s) => s.activeDbTab);
  const dbTabs = useAppStore((s) => s.dbTabs);
  const dbTabTick = useAppStore((s) => s.dbTabTick);
  const active = dbTabs.find((t) => t.id === activeDbTab) ?? null;
  /** 标签右键「刷新」计数：作为 key 绑定内容组件，自增时强制重挂载重新加载数据 */
  const tick = active ? (dbTabTick[active.id] ?? 0) : 0;
  const reloadKey = active ? `${active.id}:${tick}` : 'none';

  if (!active) return null;
  return active.type === 'table' ? (
    <TableTab key={reloadKey} connId={active.connId} db={active.db} pgDb={active.pgDb} table={active.table} />
  ) : active.type === 'objlist' ? (
    <ObjListTab key={reloadKey} tab={active} />
  ) : active.type === 'def' ? (
    <DefTab key={reloadKey} connId={active.connId} kind={active.kind} pgDb={active.pgDb} schema={active.schema} name={active.name} />
  ) : active.type === 'sequence' ? (
    <SequenceTab key={reloadKey} connId={active.connId} pgDb={active.pgDb} schema={active.schema} name={active.name} />
  ) : active.type === 'users' ? (
    <UsersTab key={reloadKey} connId={active.connId} />
  ) : active.type === 'redis' ? (
    <RedisScreen key={reloadKey} connId={active.connId} dbIndex={(active as any).dbIndex} />
  ) : (
    <QueryTab key={active.id} connId={active.connId} tabId={active.id} initialSql={active.sql} initialDb={active.pgDb ?? active.db} />
  );
}

/** 行数限制档位（DBeaver 同款：结果集行数上限） */
const LIMITS = [50, 200, 1000, 5000] as const;

/** 表标签页子页（Navicat 表设计器：数据 + 列/索引/外键/触发器/SQL 预览） */
type TableSubTab = 'data' | 'columns' | 'indexes' | 'foreign' | 'triggers' | 'ddl';

/** 表数据标签页（DBeaver 风格）。PG：db=schema、pgDb=库名（跨库） */
/**
 * where 条件里的裸数字值按列类型自动加引号。
 * 根因：MySQL 下 varchar 列与裸数字比较会把列值转 DOUBLE（约 15 位有效精度），
 * 雪花 id 等 18~19 位长数字被舍入后永远匹配不到——加引号后走精确比较。
 * 字符串字面量对数值列（bigint/int/number）三种数据库都能正确隐式转换，因此超长数字一律加引号是安全的。
 */
function quoteWhereValues(where: string, cols: { name: string; dataType?: string }[]): string {
  const w = where.trim();
  if (!w) return w;
  const strCols = new Set(cols.filter((c) => /char|text|clob|uuid/i.test(c.dataType ?? '')).map((c) => c.name.toLowerCase()));
  const isStr = (col: string) => strCols.has(col.toLowerCase());
  let out = w
    // col = 123 / != / <>
    .replace(/([A-Za-z_][\w$]*)(\s*(?:=|!=|<>)\s*)(\d+)(?=\s|$|\))/g, (m, col, op, num) =>
      isStr(col) || num.length > 15 ? `${col}${op}'${num}'` : m)
    // col like 123
    .replace(/([A-Za-z_][\w$]*)(\s+(?:like|ilike)\s+)(\d+)(?=\s|$|\))/gi, (m, col, op, num) =>
      isStr(col) ? `${col}${op}'${num}'` : m)
    // col in (1, 2, 3)
    .replace(/([A-Za-z_][\w$]*)(\s+in\s*\()([^)]*)(\))/gi, (m, col, pre, list, close) => {
      if (!isStr(col)) return m;
      const items = list
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
        .map((s: string) => (/^\d+$/.test(s) ? `'${s}'` : s));
      return `${col}${pre}${items.join(', ')}${close}`;
    });
  return out;
}

/**
 * 筛选栏输入框：字段名与 SQL 关键字智能提示。
 * 输入标识符时弹出候选（列名优先），↑↓ 选择、Enter/Tab 补全、Esc 关闭下拉（再按清空）、点击候选项直接补全。
 */
function FilterInput({
  value,
  onChange,
  onSubmit,
  onClear,
  fields,
  keywords,
  placeholder,
  title,
  className,
  inputRef,
  icon,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClear: () => void;
  fields: string[];
  keywords: string[];
  placeholder?: string;
  title?: string;
  /** 外层容器类名（决定宽度） */
  className?: string;
  inputRef?: { current: HTMLInputElement | null };
  /** 前缀图标（漏斗=筛选 / 排序箭头） */
  icon: React.ReactNode;
  /** 内嵌标签（where / order by） */
  label: string;
}) {
  /** 补全下拉：候选列表、当前选中项、被替换 token 的 [start, end) 区间 */
  const [sug, setSug] = useState<{ items: string[]; idx: number; start: number; end: number } | null>(null);

  /** 根据光标前的标识符 token 计算候选 */
  const refresh = (el: HTMLInputElement) => {
    const pos = el.selectionStart ?? el.value.length;
    const m = /([A-Za-z_][\w$]*)$/.exec(el.value.slice(0, pos));
    if (!m) {
      setSug(null);
      return;
    }
    const tok = m[1].toLowerCase();
    const pool = [...fields, ...keywords].filter((s) => s.toLowerCase().startsWith(tok) && s.toLowerCase() !== tok);
    if (!pool.length) {
      setSug(null);
      return;
    }
    setSug({ items: pool.slice(0, 8), idx: 0, start: pos - m[1].length, end: pos });
  };

  /** 用候选替换当前 token（补一个空格便于继续输入） */
  const apply = (item: string) => {
    if (!sug) return;
    const caret = sug.start + item.length + 1;
    const next = value.slice(0, sug.start) + item + ' ' + value.slice(sug.end);
    setSug(null);
    onChange(next);
    requestAnimationFrame(() => {
      const el = inputRef?.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  /** 有值时整卡激活：边框加重、图标与标签点亮蓝色 */
  const active = value.trim().length > 0;

  return (
    <div
      title={title}
      className={`relative group flex h-8 min-w-0 items-center gap-1.5 rounded-lg border bg-bg pl-2.5 pr-1.5 transition-all ${
        active
          ? 'border-accent/50 shadow-[0_0_0_1px_rgba(59,130,246,0.12)]'
          : 'border-line hover:border-dim2/50'
      } focus-within:border-accent focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.15)] ${className ?? 'flex-1'}`}
    >
      <span className={`shrink-0 transition-colors ${active ? 'text-accent' : 'text-dim2 group-focus-within:text-accent'}`}>{icon}</span>
      <span
        className={`shrink-0 select-none font-mono text-[length:calc(var(--pref-fs)*0.714)] leading-4 transition-colors ${
          active ? 'font-medium text-accent' : 'text-dim2 group-focus-within:text-fg'
        }`}
      >
        {label}
      </span>
      <span className="h-4 w-px shrink-0 bg-line" />
      <input
        ref={inputRef as never}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (sug) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSug({ ...sug, idx: (sug.idx + 1) % sug.items.length });
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSug({ ...sug, idx: (sug.idx - 1 + sug.items.length) % sug.items.length });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              apply(sug.items[sug.idx]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setSug(null);
              return;
            }
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClear();
          }
        }}
        onBlur={() => setSug(null)}
        spellCheck={false}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 border-0 bg-transparent font-mono text-[length:calc(var(--pref-fs)*0.714)] text-fg outline-none placeholder:text-dim2/55"
      />
      {active && (
        <button
          onClick={() => {
            setSug(null);
            onClear();
          }}
          title="清空并恢复全量"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dim2 transition-colors hover:bg-panel3 hover:text-fg"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      )}
      {sug && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-44 min-w-40 overflow-auto rounded-md border border-line bg-panel2 py-0.5 shadow-lg">
          {sug.items.map((it, i) => (
            <div
              key={it}
              onMouseDown={(e) => {
                e.preventDefault();
                apply(it);
              }}
              className={`cursor-pointer px-2 py-0.5 font-mono text-[length:calc(var(--pref-fs)*0.714)] ${i === sug.idx ? 'bg-panel3 text-accent' : 'text-fg'}`}
            >
              {it}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TableTab({ connId, db, pgDb, table }: { connId: string; db?: string; pgDb?: string; table: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const isPg = conn?.kind === 'postgres';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  /** 列属性元数据（属性子页展示：类型/默认值/注释/自增等） */
  const [colMeta, setColMeta] = useState<DbColumn[]>([]);
  /** 表注释（DDL 预览合成 CREATE TABLE 时带上） */
  const [tableComment, setTableComment] = useState<string>('');
  /** 子页切换（Navicat 表设计器：数据 / 列 / 索引 / 外键 / 触发器 / SQL 预览） */
  const [subTab, setSubTab] = useState<TableSubTab>('data');
  /** 行数限制档位 */
  const [limit, setLimit] = useState<number>(200);
  /** 本次获取时间（状态栏展示） */
  const [fetchedAt, setFetchedAt] = useState<string>('');
  /** 主键列名（决定能否内联编辑） */
  const [pkCols, setPkCols] = useState<string[]>([]);
  /** 内联编辑：key=`${行索引}::${列名}` → 用户输入字符串（行索引为原始结果集索引） */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** 新增行 */
  const [newRows, setNewRows] = useState<Record<string, string>[]>([]);
  /** 待删除的基础行索引 */
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  /** 当前正在编辑的单元格 */
  const [editing, setEditing] = useState<{ ri: number; col: string } | null>(null);
  /** 选中的基础行索引 */
  const [selected, setSelected] = useState<number | null>(null);
  /** 记录视图（选中行后按 Tab 切换：该行竖排为 字段/值 两列） */
  const [detail, setDetail] = useState(false);
  /** 数据网格值单元格右键菜单（{ x, y, 行索引, 列名, 当前值是否为 NULL }） */
  const [gridCellMenu, setGridCellMenu] = useState<{ x: number; y: number; ri: number; col: string; isNull: boolean } | null>(null);
  /** 当前单元格所在列（Navicat 风格整列高亮） */
  const [curCol, setCurCol] = useState<string | null>(null);
  /** 多选：拖拽/Shift 选中的基础行集合（矩形选区行范围） */
  const [selRows, setSelRows] = useState<Set<number>>(new Set());
  /** 多选列集合（矩形选区列范围）；与 selRows 共同决定选中矩形块 */
  const [selCols, setSelCols] = useState<Set<string>>(new Set());
  /** 拖拽锚点行 / 锚点列 / 拖拽模式（cell 单元格行列矩形、col 整列、row 整行）/ 拖拽中标记 / 多行批量输入缓冲 */
  const anchorRef = useRef<number | null>(null);
  const anchorColRef = useRef<string | null>(null);
  const dragModeRef = useRef<'cell' | 'col' | 'row' | null>(null);
  const draggingRef = useRef(false);
  const bulkTypeBufRef = useRef('');
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  /** 筛选栏（Navicat 风格）：原生 WHERE 条件与 ORDER BY，输入后回车走真实查询 */
  const [whereCl, setWhereCl] = useState('');
  const [orderByCl, setOrderByCl] = useState('');
  /** reload/loadMore 读取最新筛选值（避免闭包拿到旧 state） */
  const filterRef = useRef<{ where: string; orderBy: string }>({ where: '', orderBy: '' });
  /** 排序：点击表头 asc → desc → 取消 */
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  /** 属性子页：新增字段对话框开关 */
  const [addColOpen, setAddColOpen] = useState(false);
  /** 新增索引对话框开关（索引子页） */
  const [addIdxOpen, setAddIdxOpen] = useState(false);
  /** 新增外键对话框开关（外键子页） */
  const [addFkOpen, setAddFkOpen] = useState(false);
  /** 属性子页：结构操作（新增/删除字段）结果提示 */
  const [ddlMsg, setDdlMsg] = useState<string | null>(null);
  /** 设计子页元数据（索引/外键/触发器，懒加载） */
  const [indexes, setIndexes] = useState<DbIndex[]>([]);
  const [fks, setFks] = useState<DbForeignKey[]>([]);
  const [trigs, setTrigs] = useState<DbTrigger[]>([]);
  /** 已懒加载的设计元数据类别（避免重复请求） */
  const [designLoaded, setDesignLoaded] = useState<Set<string>>(new Set());
  const [designLoading, setDesignLoading] = useState(false);
  const [designErr, setDesignErr] = useState<string | null>(null);
  /** 数据网格容器（Ctrl+F 聚焦 where 输入框用） */
  const gridWrapRef = useRef<HTMLDivElement>(null);
  /** 筛选栏 where 输入框（Ctrl+F 聚焦） */
  const whereInputRef = useRef<HTMLInputElement>(null);
  /** 滚动加载：是否还有更多行 / 正在加载中 */
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const baseRows = result?.rows ?? [];
  const columns = result?.columns ?? [];
  const editable = pkCols.length > 0;
  /** 字段注释映射（来自 listColumns 元数据；网格表头 / 记录视图 hover 展示，无注释的列不在映射内） */
  const colComments = useMemo(
    () => Object.fromEntries(colMeta.filter((c) => c.comment).map((c) => [c.name, c.comment as string])),
    [colMeta],
  );
  /** 列名 -> 顺序下标（矩形选区按列序计算 min/max） */
  const colOrder = (name: string) => columns.findIndex((c) => c.name === name);
  /** 当前选区列名（按列序，Tab 分隔，供右键「复制字段名」） */
  const selectorColNames = () => columns.filter((c) => selCols.has(c.name)).map((c) => c.name).join('\t');

  /** 脏数据计数（编辑 + 新增 + 删除） */
  const dirtyCount = Object.keys(edits).length + newRows.length + deleted.size;

  /** 重查时默认保留当前已加载的行数（避免编辑/提交后把已滚动加载的多页数据截断导致"那一行丢了"）；显式传参（如切换档位）仍用传入值 */
  const reload = async (lim = result?.rows.length || limit): Promise<QueryResult | null> => {
    setLoading(true);
    setError(null);
    try {
      const { where, orderBy } = filterRef.current;
      const fl = {
        where: quoteWhereValues(where, colMeta) || undefined,
        orderBy: orderBy.trim() || undefined,
      };
      const [res, cols, metas] = await Promise.all([
        api.tableData(connId, db, table, lim, pgDb, 0, fl),
        api.listColumns(connId, db ?? '', table, pgDb),
        api.listObjectsMeta(connId, 'table', db ?? '', pgDb).catch(() => []),
      ]);
      setResult(res);
      setColMeta(cols);
      setTableComment(metas.find((m) => m.name === table)?.comment ?? '');
      setFetchedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
      setPkCols(cols.filter((c) => c.key === 'PRI').map((c) => c.name));
      setHasMore(res.rowCount >= lim);
      setLoadingMore(false);
      return res;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  /** 滚动到底自动加载下一页（追加行，保持原结果集索引——编辑/删除/选中索引不受影响） */
  const loadMore = async () => {
    if (loadingMore || loading || !result || !hasMore || detail) return;
    setLoadingMore(true);
    try {
      const { where, orderBy } = filterRef.current;
      const res = await api.tableData(connId, db, table, limit, pgDb, result.rows.length, {
        where: quoteWhereValues(where, colMeta) || undefined,
        orderBy: orderBy.trim() || undefined,
      });
      setResult((r) =>
        r
          ? { ...r, rows: [...r.rows, ...res.rows], rowCount: r.rowCount + res.rowCount, elapsedMs: r.elapsedMs, sql: r.sql }
          : res,
      );
      setHasMore(res.rowCount >= limit);
    } catch (e) {
      setError((e as Error).message);
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };
  useEffect(() => {
    setWhereCl('');
    setOrderByCl('');
    filterRef.current = { where: '', orderBy: '' };
    setSort(null);
    rollback();
    setIndexes([]);
    setFks([]);
    setTrigs([]);
    setDesignLoaded(new Set());
    setDesignErr(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, pgDb, table]);

  /** 懒加载设计元数据（索引/外键/触发器），按子页按需请求，避免重复调用；force=true 跳过缓存强制刷新 */
  const loadDesign = async (which: 'indexes' | 'foreign' | 'triggers', force = false) => {
    if (!force && designLoaded.has(which)) return;
    setDesignLoading(true);
    setDesignErr(null);
    try {
      if (which === 'indexes') setIndexes(await api.listIndexes(connId, db ?? '', table, pgDb));
      else if (which === 'foreign') setFks(await api.listForeignKeys(connId, db ?? '', table, pgDb));
      else setTrigs(await api.listTriggers(connId, db ?? '', table, pgDb));
      setDesignLoaded((s) => new Set(s).add(which));
    } catch (e) {
      setDesignErr((e as Error).message);
    } finally {
      setDesignLoading(false);
    }
  };

  /** 切换设计子页时按需加载对应元数据；SQL 预览需全部三类 */
  useEffect(() => {
    if (subTab === 'indexes') void loadDesign('indexes');
    else if (subTab === 'foreign') void loadDesign('foreign');
    else if (subTab === 'triggers') void loadDesign('triggers');
    else if (subTab === 'ddl') {
      void loadDesign('indexes');
      void loadDesign('foreign');
      void loadDesign('triggers');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab]);

  /** Ctrl+S 提交入口：ref 指向最新 commit（键盘监听闭包不随 state 重建，避免拿到旧 edits） */
  const commitRef = useRef<(() => Promise<void>) | null>(null);
  /** Ctrl+S：延迟一拍再触发，确保刚编辑的值已写入 edits 状态 */
  const commitViaShortcut = () => {
    window.setTimeout(() => { void commitRef.current?.(); }, 0);
  };

  /** 快捷键（数据子页）：Ctrl+F 聚焦筛选栏；Ctrl+S 提交；Ctrl+C 复制选中单元格/整行；Ctrl+V 粘贴到选中单元格（无需双击进入编辑） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (subTab !== 'data') return;
      const meta = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // 文本框（筛选栏/单元格编辑器）内不拦截，保留浏览器原生复制/粘贴/保存
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (meta && k === 'f') {
        const el = whereInputRef.current;
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      } else if (meta && k === 's') {
        // 单元格编辑器输入框内已自行处理（写入当前值后提交并 stopPropagation），这里兜底其余场景
        e.preventDefault();
        commitViaShortcut();
      } else if (meta && k === 'c') {
        // 复制：矩形选区（selRows × selCols）按 TSV 块复制，可整行/整列/整块
        if (selRows.size === 0 || selCols.size === 0) return;
        e.preventDefault();
        const rows = [...selRows].filter((ri) => baseRows[ri]).sort((a, b) => a - b);
        const cols = columns.filter((c) => selCols.has(c.name));
        const text = rows
          .map((ri) =>
            cols
              .map((c) => {
                const v = edits[`${ri}::${c.name}`] !== undefined ? edits[`${ri}::${c.name}`] : baseRows[ri][c.name];
                return v === null || v === undefined ? '' : String(v);
              })
              .join('\t'),
          )
          .join('\n');
        void navigator.clipboard?.writeText(text);
      } else if (meta && k === 'v') {
        // 粘贴：剪贴板 TSV 块自选区左上角（最小行/最小列序）向下向右铺开；选区为单格时自动扩展多行多列
        if (selRows.size === 0 || selCols.size === 0 || !editable) return;
        e.preventDefault();
        void navigator.clipboard?.readText().then((clip) => {
          if (clip == null) return;
          const src = clip.replace(/\r/g, '').split('\n').map((r) => r.split('\t'));
          if (!src.length || !src[0].length) return;
          const rows = [...selRows].sort((a, b) => a - b);
          const cols = columns.filter((c) => selCols.has(c.name)).map((c) => c.name);
          const r0 = rows[0];
          setEdits((m) => {
            const n = { ...m };
            src.forEach((rowVals, i) => {
              const ri = r0 + i;
              if (!baseRows[ri]) return;
              rowVals.forEach((cell, j) => {
                if (j >= cols.length) return;
                n[`${ri}::${cols[j]}`] = cell;
              });
            });
            return n;
          });
        });
      } else if (subTab === 'data' && !detail && selRows.size > 0 && selCols.size > 0 && editable && !meta && !e.altKey && e.key.length === 1 && !(e as KeyboardEvent & { isComposing?: boolean }).isComposing) {
        // 选中后直接键入：单格进入内联编辑器预填该字；矩形块逐字符写入所有选中格（体验同电子表格）
        e.preventDefault();
        if (selRows.size === 1 && selCols.size === 1) {
          const ri = [...selRows][0];
          const cn = [...selCols][0];
          setEdit(ri, cn, e.key);
          setEditing({ ri, col: cn });
        } else {
          bulkTypeBufRef.current += e.key;
          const buf = bulkTypeBufRef.current;
          setEdits((m) => {
            const n = { ...m };
            for (const ri of selRows) if (baseRows[ri]) for (const cn of selCols) n[`${ri}::${cn}`] = buf;
            return n;
          });
        }
      } else if (subTab === 'data' && !detail && selRows.size > 0 && selCols.size > 0 && editable && !meta && !e.altKey && e.key === 'Backspace') {
        // 矩形批量输入中退格：回退所有选中格的缓冲
        if (bulkTypeBufRef.current.length === 0) return;
        e.preventDefault();
        bulkTypeBufRef.current = bulkTypeBufRef.current.slice(0, -1);
        const buf = bulkTypeBufRef.current;
        setEdits((m) => {
          const n = { ...m };
          for (const ri of selRows) if (baseRows[ri]) for (const cn of selCols) n[`${ri}::${cn}`] = buf;
          return n;
        });
      } else if (e.key === 'Enter' || e.key === 'Escape') {
        // 结束矩形批量输入（值已写入 edits，仅清缓冲）
        bulkTypeBufRef.current = '';
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [subTab, detail, selected, curCol, selRows, selCols, baseRows, edits, columns, editable, commitViaShortcut]);

  /** 回滚所有未提交改动 */
  const rollback = () => {
    setEdits({});
    setNewRows([]);
    setDeleted(new Set());
    setSelected(null);
    setCurCol(null);
    setSelRows(new Set());
    setSelCols(new Set());
    anchorRef.current = null;
    anchorColRef.current = null;
    dragModeRef.current = null;
    bulkTypeBufRef.current = '';
    setDetail(false);
    setCommitMsg(null);
  };

  /** 提交：构造并执行 UPDATE / INSERT / DELETE */
  const commit = async () => {
    if (!editable || committing) return;
    setCommitting(true);
    setCommitMsg(null);
    try {
      const q = (name: string) => (isPg ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``);
      const qTable = db ? `${q(db)}.${q(table)}` : q(table);
      const colType = (c: string) => columns.find((x) => x.name === c)?.dataType ?? '';
      const stmts: string[] = [];

      // 编辑：按基础行分组
      const byRow = new Map<number, Record<string, string>>();
      for (const [k, v] of Object.entries(edits)) {
        const [riStr, col] = k.split('::');
        const ri = Number(riStr);
        if (deleted.has(ri)) continue;
        if (!byRow.has(ri)) byRow.set(ri, {});
        byRow.get(ri)![col] = v;
      }
      for (const [ri, cols] of byRow) {
        const row = baseRows[ri];
        if (!row) continue;
        const sets = Object.entries(cols)
          .map(([col, val]) => `${q(col)} = ${sqlVal(colType(col), val)}`)
          .join(', ');
        const wheres = pkCols.map((pk) => `${q(pk)} = ${sqlVal(colType(pk), row[pk])}`).join(' AND ');
        stmts.push(`UPDATE ${qTable} SET ${sets} WHERE ${wheres}`);
      }

      // 新增行
      for (const nr of newRows) {
        const keys = Object.keys(nr).filter((k) => (nr[k] ?? '').trim() !== '');
        if (keys.length === 0) continue;
        const cols = keys.map((k) => q(k)).join(', ');
        const vals = keys.map((k) => sqlVal(colType(k), nr[k])).join(', ');
        stmts.push(`INSERT INTO ${qTable} (${cols}) VALUES (${vals})`);
      }

      // 删除行
      for (const ri of deleted) {
        const row = baseRows[ri];
        if (!row) continue;
        const wheres = pkCols.map((pk) => `${q(pk)} = ${sqlVal(colType(pk), row[pk])}`).join(' AND ');
        stmts.push(`DELETE FROM ${qTable} WHERE ${wheres}`);
      }

      if (stmts.length === 0) {
        setCommitMsg('没有待提交的改动');
        return;
      }
      for (const sql of stmts) {
        // PG 跨库 / MySQL 多库：必须带库名选对连接池，否则 SQL 会落到连接默认库（报 relation does not exist）
        await api.runSql(connId, sql, pgDb || undefined);
      }

      // 记录被编辑行（编辑前基础行）的主键组合，用于提交后在新结果集中定位，保持高亮并滚动可见
      const locatedKeys = new Set<string>();
      if (pkCols.length) {
        for (const [ri] of byRow) {
          const row = baseRows[ri];
          if (row) locatedKeys.add(pkCols.map((pk) => String(row[pk])).join(''));
        }
      }

      // 提交成功：只丢弃未提交的编辑值，保留选中行与记录视图，重查后那一行就地刷新（避免提交后"那一行数据丢了"）
      setEdits({});
      setNewRows([]);
      setDeleted(new Set());
      setEditing(null);

      const res = await reload();

      // 提交后定位：按主键在新结果中找到被编辑行的索引，保持选中高亮并滚动到视口（解决"改完不知道在第几行了"）
      if (locatedKeys.size && pkCols.length && res) {
        const found = res.rows
          .map((r, i) => ({ i, key: pkCols.map((pk) => String(r[pk])).join('') }))
          .filter((x) => locatedKeys.has(x.key))
          .map((x) => x.i);
        if (found.length) {
          // 多选提交：恢复整片选区并滚到首行可见；单选：高亮该行
          setSelRows(new Set(found));
          setSelected(found[0]);
          if (selCols.size && curCol && !selCols.has(curCol)) setCurCol([...selCols][0]);
          if (!detail) {
            requestAnimationFrame(() => {
              const wrap = gridWrapRef.current;
              const tr = wrap?.querySelector(`tr[data-ri="${found[0]}"]`) as HTMLElement | null;
              tr?.scrollIntoView({ block: 'center', inline: 'nearest' });
            });
          }
        } else {
          setSelected(null);
          setSelRows(new Set());
        }
      } else {
        setSelected(null);
        setSelRows(new Set());
      }

      setCommitMsg(`已提交 ${stmts.length} 条语句`);
    } catch (e) {
      setCommitMsg(`提交失败：${(e as Error).message}`);
    } finally {
      setCommitting(false);
    }
  };
  // 每次 render 同步最新 commit 到 ref（无依赖数组，render 后必执行）
  useEffect(() => { commitRef.current = commit; });

  const setEdit = (ri: number, col: string, val: string) =>
    setEdits((m) => ({ ...m, [`${ri}::${col}`]: val }));

  const copyText = (s: string) => {
    try {
      void navigator.clipboard?.writeText(s);
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  };

  /** 矩形选区：依据锚点 (anchorRi,anchorCol) 与焦点 (fr,fc) 计算并写入 selRows/selCols/curCol/selected */
  const applyRect = (anchorRi: number, anchorCol: string, fr: number, fc: string) => {
    bulkTypeBufRef.current = '';
    const lo = Math.min(anchorRi, fr);
    const hi = Math.max(anchorRi, fr);
    const rows = new Set<number>();
    for (let i = lo; i <= hi; i++) rows.add(i);
    const a = colOrder(anchorCol);
    const b = colOrder(fc);
    const c0 = Math.min(a, b);
    const c1 = Math.max(a, b);
    const cols = new Set<string>();
    columns.forEach((c, idx) => { if (idx >= c0 && idx <= c1) cols.add(c.name); });
    anchorRef.current = anchorRi;
    anchorColRef.current = anchorCol;
    setSelRows(rows);
    setSelCols(cols);
    setCurCol(fc);
    setSelected(fr);
  };
  /** 选中整行（行号栏）：所有列 × [anchorRi..ri] */
  const applyRowRange = (anchorRi: number, ri: number) => {
    const lo = Math.min(anchorRi, ri);
    const hi = Math.max(anchorRi, ri);
    const rows = new Set<number>();
    for (let i = lo; i <= hi; i++) rows.add(i);
    const cols = new Set<string>(columns.map((c) => c.name));
    setSelRows(rows);
    setSelCols(cols);
    anchorRef.current = anchorRi;
    setSelected(ri);
    setCurCol(columns[0]?.name ?? null);
  };
  /** 选中整列（表头）：所有行 × [anchorCol..col] */
  const applyColRange = (anchorCol: string, col: string) => {
    const a = colOrder(anchorCol);
    const b = colOrder(col);
    const c0 = Math.min(a, b);
    const c1 = Math.max(a, b);
    const cols = new Set<string>();
    columns.forEach((c, idx) => { if (idx >= c0 && idx <= c1) cols.add(c.name); });
    const rows = new Set<number>();
    baseRows.forEach((_, ri) => rows.add(ri));
    setSelCols(cols);
    anchorColRef.current = anchorCol;
    setCurCol(col);
    setSelected(0);
  };
  /** 值单元格按下：左键生效，编辑器内点击不抢焦点；Shift 扩展到矩形，普通点击进入拖拽 */
  const onCellMouseDown = (ri: number, col: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-dt-cell-editor]')) return;
    if (e.shiftKey && anchorRef.current != null && anchorColRef.current != null) {
      applyRect(anchorRef.current, anchorColRef.current, ri, col);
      gridWrapRef.current?.focus();
      return;
    }
    applyRect(ri, col, ri, col);
    draggingRef.current = true;
    dragModeRef.current = 'cell';
  };
  /** 值单元格拖拽经过：矩形扩展 */
  const onCellMouseEnter = (ri: number, col: string) => {
    if (!draggingRef.current || dragModeRef.current !== 'cell' || anchorRef.current == null || anchorColRef.current == null) return;
    applyRect(anchorRef.current, anchorColRef.current, ri, col);
  };
  /** 表头按下：选整列；Shift 扩展到整列范围 */
  const onHeaderMouseDown = (col: string, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey && anchorColRef.current != null) {
      applyColRange(anchorColRef.current, col);
      return;
    }
    applyColRange(col, col);
    draggingRef.current = true;
    dragModeRef.current = 'col';
  };
  /** 表头拖拽经过：整列范围扩展 */
  const onHeaderMouseEnter = (col: string) => {
    if (!draggingRef.current || dragModeRef.current !== 'col' || anchorColRef.current == null) return;
    applyColRange(anchorColRef.current, col);
  };
  /** 行号栏按下：选整行；Shift 扩展到整行范围（ri=-1 为表头 # 列 = 全选所有行） */
  const onGutterMouseDown = (ri: number, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (ri === -1) {
      // 表头 # 列：全选所有行
      const rows = new Set<number>();
      baseRows.forEach((_, i) => rows.add(i));
      setSelRows(rows);
      anchorRef.current = null;
      setSelected(null);
      setCurCol(columns[0]?.name ?? null);
      return;
    }
    if (e.shiftKey && anchorRef.current != null) {
      applyRowRange(anchorRef.current, ri);
      return;
    }
    applyRowRange(ri, ri);
    draggingRef.current = true;
    dragModeRef.current = 'row';
  };
  /** 行号栏拖拽经过：整行范围扩展 */
  const onGutterMouseEnter = (ri: number) => {
    if (ri === -1 || !draggingRef.current || dragModeRef.current !== 'row' || anchorRef.current == null) return;
    applyRowRange(anchorRef.current, ri);
  };
  /** 全局 mouseup：结束拖拽 */
  useEffect(() => {
    const up = () => { draggingRef.current = false; dragModeRef.current = null; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  /** 数据网格值单元格右键菜单项（与记录视图同款 + 粘贴；置 NULL = 写入空串，sqlVal 提交时转 NULL） */
  const buildGridCellMenu = (): MenuItem[] => {
    const m = gridCellMenu!;
    const key = `${m.ri}::${m.col}`;
    const rawVal = edits[key] !== undefined ? edits[key] : baseRows[m.ri]?.[m.col];
    // 右键落在当前矩形选区内 → 作用于整块（所有选中格）；否则仅作用该格
    const inRect = selRows.has(m.ri) && selCols.has(m.col);
    const cells: [number, string][] = inRect
      ? [...selRows].flatMap((ri) => [...selCols].map((col) => [ri, col] as [number, string]))
      : [[m.ri, m.col]];
    const applyAll = (val: string) =>
      setEdits((mm) => {
        const n = { ...mm };
        for (const [ri, col] of cells) if (baseRows[ri]) n[`${ri}::${col}`] = val;
        return n;
      });
    const copyBlock = () => {
      const rows = [...selRows].filter((ri) => baseRows[ri]).sort((a, b) => a - b);
      const cols = columns.filter((c) => selCols.has(c.name));
      const text = rows
        .map((ri) =>
          cols
            .map((c) => {
              const v = edits[`${ri}::${c.name}`] !== undefined ? edits[`${ri}::${c.name}`] : baseRows[ri][c.name];
              return v === null || v === undefined ? '' : String(v);
            })
            .join('\t'),
        )
        .join('\n');
      copyText(text);
    };
    const cnt = cells.length;
    return [
      {
        label: `置为 NULL${cnt > 1 ? `（${cnt} 格）` : ''}`,
        disabled: !editable || (cnt === 1 && m.isNull),
        onClick: () => applyAll(''),
      },
      { label: '', separator: true },
      {
        label: cnt > 1 ? '复制块' : '复制值',
        onClick: () => (cnt > 1 ? copyBlock() : copyText(rawVal === null || rawVal === undefined ? '' : String(rawVal))),
      },
      {
        label: '复制字段名',
        onClick: () => copyText(selectorColNames()),
      },
      {
        label: `粘贴${cnt > 1 ? `（${cnt} 格）` : ''}`,
        disabled: !editable,
        onClick: () => {
          void navigator.clipboard?.readText().then((clip) => {
            if (clip == null) return;
            const src = clip.replace(/\r/g, '').split('\n').map((r) => r.split('\t'));
            if (!src.length || !src[0].length) return;
            // 从选区左上角（最小行/最小列序）铺开
            const r0 = Math.min(...cells.map(([ri]) => ri));
            const c0Order = Math.min(...cells.map(([, col]) => colOrder(col)));
            setEdits((mm) => {
              const n = { ...mm };
              src.forEach((rowVals, i) => {
                const ri = r0 + i;
                if (!baseRows[ri]) return;
                rowVals.forEach((cell, j) => {
                  const cidx = c0Order + j;
                  const cn = columns[cidx]?.name;
                  if (!cn) return;
                  n[`${ri}::${cn}`] = cell;
                });
              });
              return n;
            });
          });
        },
      },
      { label: '', separator: true },
      { label: '编辑此字段', disabled: !editable || cnt > 1, onClick: () => setEditing({ ri: m.ri, col: m.col }) },
    ];
  };

  /** 筛选后的展示行（筛选已在服务端 WHERE 完成，这里仅保留客户端排序；原始行索引用于编辑/删除定位） */
  const displayRows = useMemo(() => {
    const list = baseRows.map((row, ri) => ({ ri, row }));
    if (sort) {
      const { col, dir } = sort;
      return [...list].sort((a, b) => {
        const av = a.row[col];
        const bv = b.row[col];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const an = Number(av);
        const bn = Number(bv);
        const cmp =
          Number.isFinite(an) && Number.isFinite(bn) && String(av).trim() !== '' && String(bv).trim() !== ''
            ? an - bn
            : String(av).localeCompare(String(bv), 'zh-CN');
        return dir === 'asc' ? cmp : -cmp;
      });
    }
    return list;
  }, [baseRows, sort]);

  /** 导出当前结果集为 CSV（带 BOM，Excel 直接打开不乱码）；NULL 值导出为空单元格（不写字面量 NULL） */
  const exportCsv = () => {
    const esc = (v: unknown, dt?: string) => {
      if (v === null || v === undefined) return '';
      const s = fmt(v, dt);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      columns.map((c) => esc(c.name)).join(','),
      ...displayRows.map(({ row }) => columns.map((c) => esc(row[c.name], c.dataType)).join(',')),
    ];
    const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${table}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  /** 点击表头：asc → desc → 取消 */
  const toggleSort = (col: string) =>
    setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null));

  /** 新增字段（属性子页 → ALTER TABLE ADD COLUMN，成功后刷新结构与数据） */
  const submitAddColumn = async (spec: DbColumnSpec) => {
    setDdlMsg(null);
    try {
      await api.addColumn(connId, db, table, spec, pgDb);
      setAddColOpen(false);
      await reload();
      setDdlMsg(`已新增字段 ${spec.name}`);
    } catch (e) {
      window.alert(`新增字段失败：${(e as Error).message}`);
    }
  };

  /** 删除字段（属性子页行内 → ALTER TABLE DROP COLUMN，二次确认后执行） */
  const submitDropColumn = async (name: string) => {
    if (!window.confirm(`确认删除字段「${name}」？字段及其数据将被移除，该操作不可恢复。`)) return;
    setDdlMsg(null);
    try {
      await api.dropColumn(connId, db, table, name, pgDb);
      await reload();
      setDdlMsg(`已删除字段 ${name}`);
    } catch (e) {
      window.alert(`删除字段失败：${(e as Error).message}`);
    }
  };

  /** 修改字段（属性子页双击编辑 → ALTER TABLE，仅提交变化的字段；成功后刷新结构） */
  const submitAlterColumn = async (oldName: string, spec: DbColumnAlterSpec) => {
    setDdlMsg(null);
    try {
      await api.alterColumn(connId, db, table, oldName, spec, pgDb);
      await reload();
      setDdlMsg(`已修改字段 ${spec.name ?? oldName}`);
    } catch (e) {
      window.alert(`修改字段失败：${(e as Error).message}`);
    }
  };

  /** 新增索引（索引子页 → CREATE INDEX，成功后刷新索引列表） */
  const submitCreateIndex = async (name: string, cols: string[], unique: boolean, method: string) => {
    if (!name.trim() || cols.length === 0) return;
    const q = (n: string) => (isPg ? `"${n.replace(/"/g, '""')}"` : `\`${n.replace(/`/g, '``')}\``);
    const tbl = db ? `${q(db)}.${q(table)}` : q(table);
    const using = method.trim() ? (isPg ? ` USING ${method.trim()}` : ` USING ${method.trim()}`) : '';
    // PG：USING 放表名后；MySQL：USING 放索引名后
    const sql = isPg
      ? `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name.trim())} ON ${tbl}${using} (${cols.map(q).join(', ')})`
      : `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name.trim())}${using} ON ${tbl} (${cols.map(q).join(', ')})`;
    setDdlMsg(null);
    try {
      await api.runSql(connId, sql, pgDb || undefined);
      await loadDesign('indexes', true);
      setDdlMsg(`已创建索引 ${name.trim()}`);
    } catch (e) {
      window.alert(`创建索引失败：${(e as Error).message}`);
    }
  };

  /** 新增外键（外键子页 → ALTER TABLE ADD CONSTRAINT … FOREIGN KEY，成功后刷新外键列表） */
  const submitCreateForeignKey = async (
    name: string,
    cols: string[],
    refTable: string,
    refCols: string[],
    onDelete: string,
    onUpdate: string,
  ) => {
    if (!name.trim() || cols.length === 0 || !refTable.trim() || refCols.length === 0) return;
    const q = (n: string) => (isPg ? `"${n.replace(/"/g, '""')}"` : `\`${n.replace(/`/g, '``')}\``);
    const tbl = db ? `${q(db)}.${q(table)}` : q(table);
    // 引用表允许带 schema 前缀（PG：schema.table / MySQL：db.table），逐段加引号
    const refQ = refTable.trim().split('.').map((p) => q(p.trim())).join('.');
    const sql =
      `ALTER TABLE ${tbl} ADD CONSTRAINT ${q(name.trim())} ` +
      `FOREIGN KEY (${cols.map(q).join(', ')}) REFERENCES ${refQ} (${refCols.map(q).join(', ')})` +
      (onDelete ? ` ON DELETE ${onDelete}` : '') +
      (onUpdate ? ` ON UPDATE ${onUpdate}` : '');
    setDdlMsg(null);
    try {
      await api.runSql(connId, sql, pgDb || undefined);
      await loadDesign('foreign', true);
      setDdlMsg(`已创建外键 ${name.trim()}`);
    } catch (e) {
      window.alert(`创建外键失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具栏（DBeaver 风格图标按钮） */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line bg-panel px-1.5">
        <IBtn title="刷新（重新查询）" onClick={() => void reload()} disabled={loading} icon={
          <><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" /></>
        } />
        <div className="mx-1 h-4 w-px bg-line" />
        {editable && (
          <>
            <IBtn title="新增一行" onClick={() => setNewRows((r) => [...r, {}])} icon={
              <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M12 9v6M9 12h6" /></>
            } />
            <IBtn title="删除选中行" onClick={() => selected != null && setDeleted((s) => new Set(s).add(selected))} disabled={selected == null} icon={
              <><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M9 12h6" /></>
            } />
            <div className="mx-1 h-4 w-px bg-line" />
            <IBtn title="提交改动（生成并执行 UPDATE/INSERT/DELETE；快捷键 Ctrl+S）" onClick={() => void commit()} disabled={committing || dirtyCount === 0} accent icon={
              <><path d="M5 13l4 4L19 7" /></>
            } />
            <IBtn title="回滚未提交改动" onClick={rollback} disabled={dirtyCount === 0} icon={
              <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v1" /></>
            } />
          </>
        )}
        <span className="ml-2 truncate text-[length:calc(var(--pref-fs)*0.786)] text-dim2" title={pkCols.length ? `主键 ${pkCols.join(', ')}` : '无主键（只读）'}>
          {db ? `${db}.` : ''}{table}
          {pkCols.length > 0 ? '' : ' · 只读'}
        </span>
        {commitMsg && <span className="ml-2 truncate text-[length:calc(var(--pref-fs)*0.714)] text-dim">{commitMsg}</span>}
        {/* 子页切换：Navicat 表设计器（数据 / 列 / 索引 / 外键 / 触发器 / SQL 预览） */}
        <div className="ml-auto flex items-center gap-0.5 rounded border border-line p-0.5">
          {(
            [
              { k: 'data', label: '数据' },
              { k: 'columns', label: '列' },
              { k: 'indexes', label: '索引' },
              { k: 'foreign', label: '外键' },
              { k: 'triggers', label: '触发器' },
              { k: 'ddl', label: 'SQL 预览' },
            ] as { k: TableSubTab; label: string }[]
          ).map((t) => (
            <button
              key={t.k}
              onClick={() => setSubTab(t.k)}
              title={t.label}
              className={`rounded px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 ${subTab === t.k ? 'bg-panel3 text-fg' : 'text-dim2 hover:text-fg'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {subTab === 'data' ? (
        <>
          {/* 筛选栏：一体化筛选卡片（图标+标签+输入+清空 融合在一张卡内），回车执行真实查询；Esc/✕ 清空恢复全量；输入时提示字段名。
              有条件时卡片边框与标签点亮蓝色，一眼看出筛选/排序已生效 */}
          <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-panel px-2.5">
            <FilterInput
              className="flex-[3]"
              inputRef={whereInputRef}
              value={whereCl}
              onChange={(v) => {
                setWhereCl(v);
                filterRef.current.where = v;
              }}
              onSubmit={() => void reload(limit)}
              onClear={() => {
                setWhereCl('');
                filterRef.current.where = '';
                void reload(limit);
              }}
              fields={columns.map((c) => c.name)}
              keywords={['and', 'or', 'not', 'like', 'in', 'is null', 'is not null', 'between']}
              placeholder="条件，如 id = 1 and name like '%a%'"
              title="回车执行查询；Esc 或 ✕ 清空。支持任意 SQL WHERE 表达式（and / or / in / like / > < = 等）；输入字段名时自动提示"
              label="where"
              icon={
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path d="M3 5h18l-7 8v5.5L10 21v-8L3 5Z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
            />
            <FilterInput
              className="flex-[2]"
              value={orderByCl}
              onChange={(v) => {
                setOrderByCl(v);
                filterRef.current.orderBy = v;
              }}
              onSubmit={() => void reload(limit)}
              onClear={() => {
                setOrderByCl('');
                filterRef.current.orderBy = '';
                void reload(limit);
              }}
              fields={columns.map((c) => c.name)}
              keywords={['asc', 'desc']}
              placeholder="如 created_at desc, id asc"
              title="回车执行查询；Esc 清空。支持任意 SQL ORDER BY 表达式（多列、desc/asc）；输入字段名时自动提示"
              label="order by"
              icon={
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path d="M7 4v13M4 14l3 3 3-3M17 20V7M14 10l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              }
            />
          </div>
          <div
            ref={gridWrapRef}
            tabIndex={0}
          onScroll={(e) => {
            // 滚动到底部（余量 80px）自动追加下一页；记录视图/非数据内容不触发
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) void loadMore();
          }}
          onKeyDown={(e) => {
            // Tab：选中行时切换「记录视图」（该行竖排为 字段/值 两列）；输入框内不拦截
            if (e.key === 'Tab' && selected != null) {
              const t = e.target as HTMLElement;
              if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
              e.preventDefault();
              setDetail((d) => !d);
            }
          }}
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          {error ? (
            <ErrorBox message={error} onRetry={() => void reload()} />
          ) : result && detail && selected != null ? (
            /* 记录视图：选中行竖排展示（Tab 再次按下还原表格），双击值单元格进入编辑（与表格同款编辑器） */
            <RecordDetailView
              columns={columns}
              pkCols={pkCols}
              comments={colComments}
              rows={displayRows}
              ri={selected}
              edits={edits}
              deleted={deleted.has(selected)}
              editable={editable}
              editing={editing}
              onCellDblClick={(ri2, col) => setEditing({ ri: ri2, col })}
              onCellChange={(ri2, col, val) => setEdit(ri2, col, val)}
              onEditEnd={() => setEditing(null)}
              onCommitShortcut={commitViaShortcut}
              onBack={() => setDetail(false)}
            />
          ) : result ? (
            <EditableGrid
              columns={columns}
              pkCols={pkCols}
              comments={colComments}
              displayRows={displayRows}
              newRows={newRows}
              edits={edits}
              deleted={deleted}
              editing={editing}
              selected={selected}
              curCol={curCol}
              selRows={selRows}
              selCols={selCols}
              editable={editable}
              sort={sort}
              onCellDblClick={(ri, col) => setEditing({ ri, col })}
              onCellChange={(ri, col, val) => setEdit(ri, col, val)}
              onEditEnd={() => setEditing(null)}
              onCommitShortcut={commitViaShortcut}
              onNewChange={(i, col, val) =>
                setNewRows((r) => r.map((row, idx) => (idx === i ? { ...row, [col]: val } : row)))
              }
              onCellMouseDown={onCellMouseDown}
              onCellMouseEnter={onCellMouseEnter}
              onHeaderMouseDown={onHeaderMouseDown}
              onHeaderMouseEnter={onHeaderMouseEnter}
              onGutterMouseDown={onGutterMouseDown}
              onGutterMouseEnter={onGutterMouseEnter}
              onCellContextMenu={(ri, col, x, y, isNull) => {
                // 若右键落在当前矩形选区内，保留多选；否则定位到该格
                if (!(selRows.has(ri) && selCols.has(col))) {
                  bulkTypeBufRef.current = '';
                  applyRect(ri, col, ri, col);
                }
                setGridCellMenu({ x, y, ri, col, isNull });
              }}
              onSort={toggleSort}
              isPg={isPg}
            />
          ) : (
            <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载中…</div>
          )}
          {/* 数据网格值单元格右键菜单（置 NULL / 复制 / 粘贴 / 编辑） */}
          {gridCellMenu && (
            <ContextMenu
              x={gridCellMenu.x}
              y={gridCellMenu.y}
              items={buildGridCellMenu()}
              onClose={() => setGridCellMenu(null)}
            />
          )}
        </div>
        </>
      ) : subTab === 'columns' ? (
        /* 列结构子页（DBeaver 属性页风格） */
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <ErrorBox message={error} onRetry={() => void reload()} />
          ) : (
            <ColumnsView meta={colMeta} loading={loading} ddlMsg={ddlMsg} dialect={conn?.kind ?? ''} onAdd={() => setAddColOpen(true)} onDrop={(n) => void submitDropColumn(n)} onAlter={submitAlterColumn} />
          )}
        </div>
      ) : subTab === 'indexes' ? (
        <IndexListView
          items={indexes}
          loading={designLoading}
          error={designErr}
          ddlMsg={ddlMsg}
          onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'indexes'))); void loadDesign('indexes'); }}
          onAdd={() => setAddIdxOpen(true)}
        />
      ) : subTab === 'foreign' ? (
        <ForeignKeyListView
          items={fks}
          loading={designLoading}
          error={designErr}
          ddlMsg={ddlMsg}
          onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'foreign'))); void loadDesign('foreign'); }}
          onAdd={() => setAddFkOpen(true)}
        />
      ) : subTab === 'triggers' ? (
        <TriggerListView
          items={trigs}
          loading={designLoading}
          error={designErr}
          onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'triggers'))); void loadDesign('triggers'); }}
        />
      ) : (
        <DdlView ddl={buildTableDdl(conn?.kind ?? 'postgres', db, table, colMeta, indexes, fks, trigs, tableComment)} loading={designLoading} error={designErr} />
      )}

      {/* 底部状态栏（DBeaver 风格：行数/耗时/时间 + 导出 + 行数限制） */}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
        <button onClick={() => void reload()} disabled={loading} className="text-dim2 hover:text-fg disabled:opacity-40" title="刷新">
          {loading ? '获取中…' : '刷新'}
        </button>
        <div className="h-3 w-px bg-line" />
        <button onClick={exportCsv} disabled={!result} className="text-dim2 hover:text-fg disabled:opacity-40" title="导出当前结果为 CSV">
          导出数据…
        </button>
        <div className="h-3 w-px bg-line" />
        <select
          value={limit}
          onChange={(e) => {
            const lim = Number(e.target.value);
            setLimit(lim);
            void reload(lim);
          }}
          className="rounded border border-line bg-bg px-1 text-[length:calc(var(--pref-fs)*0.714)] text-dim outline-none"
          title="结果行数上限（修改后立即重新查询）"
        >
          {LIMITS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        <span className="ml-auto" title={result && subTab === 'data' ? result.sql : undefined}>
          {subTab === 'columns'
            ? `${colMeta.length} 列`
            : subTab === 'indexes'
              ? `${indexes.length} 个索引`
              : subTab === 'foreign'
                ? `${fks.length} 个外键`
                : subTab === 'triggers'
                  ? `${trigs.length} 个触发器`
                  : subTab === 'ddl'
                    ? 'SQL 预览'
                    : result
                      ? `${displayRows.length} 行已获取` + (whereCl.trim() || orderByCl.trim() ? '（已按条件筛选/排序）' : '') + (hasMore ? (loadingMore ? '，正在加载更多…' : '，滚动到底部自动加载') : '') + `, ${(result.elapsedMs / 1000).toFixed(3)}s(查询时间)` + (fetchedAt ? `, ${fetchedAt}` : '')
                      : ''}
        </span>
      </div>

      {/* 新增字段对话框（属性子页） */}
      {addColOpen && (
        <AddColumnDialog
          isPg={conn?.kind === 'postgres'}
          isMysql={conn?.kind === 'mysql'}
          onCancel={() => setAddColOpen(false)}
          onSubmit={(s) => void submitAddColumn(s)}
        />
      )}

      {/* 新增索引对话框（索引子页） */}
      {addIdxOpen && (
        <AddIndexDialog
          isPg={isPg}
          columns={colMeta.map((c) => c.name)}
          tableName={table}
          onCancel={() => setAddIdxOpen(false)}
          onSubmit={(name, cols, unique, method) => {
            setAddIdxOpen(false);
            void submitCreateIndex(name, cols, unique, method);
          }}
        />
      )}

      {/* 新增外键对话框（外键子页） */}
      {addFkOpen && (
        <AddForeignKeyDialog
          isPg={isPg}
          connId={connId}
          schema={db}
          pgDb={pgDb || undefined}
          columns={colMeta.map((c) => c.name)}
          tableName={table}
          onCancel={() => setAddFkOpen(false)}
          onSubmit={(name, cols, refTable, refCols, onDelete, onUpdate) => {
            setAddFkOpen(false);
            void submitCreateForeignKey(name, cols, refTable, refCols, onDelete, onUpdate);
          }}
        />
      )}
    </div>
  );
}

/**
 * 对象清单标签页（DBeaver 风格）：单击树上「表/视图/物化视图」分类时打开。
 * 列出模式内全部对象及注释，Ctrl+F 聚焦搜索框，双击行直接打开表数据。
 */
/** 字节数格式化（人类可读）：B / KB / MB / GB */
function fmtBytes(n?: number): string {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 数字千分位格式化（行数等） */
function fmtNum(n?: number): string {
  if (n == null || isNaN(n)) return '';
  return n.toLocaleString('en-US');
}

/** 清单页时间列：优先更新时间（MySQL），其次分析时间（Oracle） */
function metaTime(it: DbObjectMeta): string | undefined {
  return it.updatedAt ?? it.analyzedAt;
}

/** 是否展示存储类列（行数/大小/引擎）：视图无存储，不展示 */
function hasStorage(kind: 'table' | 'view' | 'mview'): boolean {
  return kind !== 'view';
}

function ObjListTab({ tab }: { tab: Extract<DbTab, { type: 'objlist' }> }) {
  const openDbTab = useAppStore((s) => s.openDbTab);
  const [items, setItems] = useState<DbObjectMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 搜索关键字（Ctrl+F 聚焦，实时过滤名称/注释） */
  const [kw, setKw] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  /** 右键菜单：{x,y} 为屏幕坐标；item 为右键的具体对象（无则代表空白区，仅提供新建/刷新） */
  const [menu, setMenu] = useState<{ x: number; y: number; item?: DbObjectMeta } | null>(null);
  /** 新建/编辑表弹窗（本地渲染，创建成功后刷新清单） */
  const [createOpen, setCreateOpen] = useState(false);
  const [editName, setEditName] = useState<string | undefined>(undefined);

  const kindLabel = tab.kind === 'table' ? '表' : tab.kind === 'view' ? '视图' : '物化视图';

  /** 双击行 / 菜单「打开表数据」：打开表数据标签 */
  const openTable = (name: string) =>
    openDbTab({
      id: `t:${tab.connId}:${tab.pgDb ?? ''}:${tab.schema}:${name}`,
      connId: tab.connId,
      type: 'table',
      db: tab.schema,
      pgDb: tab.pgDb,
      table: name,
      title: name,
    });

  /** 右键菜单项（按是否右键具体对象生成） */
  const menuItems = (item?: DbObjectMeta): MenuItem[] => {
    const items: MenuItem[] = [];
    if (item) {
      items.push(
        { label: '打开表数据', onClick: () => openTable(item.name) },
        { separator: true, label: '' },
        { label: '编辑结构…', onClick: () => { setEditName(item.name); setCreateOpen(true); } },
        { separator: true, label: '' },
        { label: '删除', danger: true, onClick: () => void (async () => {
            if (!confirm(`确认删除${kindLabel}「${item.name}」？此操作不可恢复。`)) return;
            try {
              await api.dropObject(tab.connId, tab.kind, tab.schema, item.name, tab.pgDb);
              await load();
            } catch (e) {
              setError((e as Error).message);
            }
          })() },
      );
    }
    items.push(
      { label: '新建表…', onClick: () => { setEditName(undefined); setCreateOpen(true); } },
      { label: '刷新', onClick: () => void load() },
    );
    return items;
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listObjectsMeta(tab.connId, tab.kind, tab.schema, tab.pgDb));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connId, tab.kind, tab.schema, tab.pgDb]);

  /** Ctrl+F / Cmd+F：聚焦搜索框并全选（DBeaver 同款快捷键） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const k = kw.trim().toLowerCase();
  const filtered = (items ?? []).filter(
    (it) => !k || it.name.toLowerCase().includes(k) || (it.comment ?? '').toLowerCase().includes(k),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      {/* 顶部工具栏：搜索（Ctrl+F）+ 刷新 + 计数 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">
          {kindLabel} · {tab.schema}
        </span>
        <div className="flex h-6 w-[280px] items-center gap-1.5 rounded border border-line bg-bg px-2 focus-within:border-accent">
          <svg className="h-3 w-3 shrink-0 text-dim2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={searchRef}
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setKw('')}
            placeholder="搜索名称或注释（Ctrl+F）"
            spellCheck={false}
            className="w-full bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2"
          />
          {kw && (
            <button onClick={() => setKw('')} className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2 hover:text-fg" title="清空搜索">
              ✕
            </button>
          )}
        </div>
        <button onClick={() => void load()} disabled={loading} className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2 hover:text-fg disabled:opacity-40" title="刷新">
          {loading ? '加载中…' : '刷新'}
        </button>
        <span className="ml-auto text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
          {items ? `${filtered.length}${k ? ` / ${items.length}` : ''} 个对象` : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : (
          <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-panel2 text-left text-dim2">
                <th className="w-12 border-b border-line px-2 py-1 text-right font-medium">#</th>
                <th className="border-b border-line px-2 py-1 font-medium">名称</th>
                <th className="border-b border-line px-2 py-1 font-medium">注释</th>
                {hasStorage(tab.kind) && (
                  <>
                    <th className="border-b border-line px-2 py-1 text-right font-medium">行数</th>
                    <th className="border-b border-line px-2 py-1 text-right font-medium">大小</th>
                    <th className="border-b border-line px-2 py-1 font-medium">引擎</th>
                  </>
                )}
                <th className="border-b border-line px-2 py-1 font-medium">更新/分析</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it, i) => (
                <tr
                  key={it.name}
                  className="cursor-pointer hover:bg-panel3"
                  title="双击打开表数据"
                  onDoubleClick={() => openTable(it.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, item: it });
                  }}
                >
                  <td className="border-b border-line px-2 py-1 text-right text-dim2">{i + 1}</td>
                  <td className="whitespace-nowrap border-b border-line px-2 py-1 text-fg">{it.name}</td>
                  <td className="border-b border-line px-2 py-1 text-dim">{it.comment ?? ''}</td>
                  {hasStorage(tab.kind) && (
                    <>
                      <td className="border-b border-line px-2 py-1 text-right tabular-nums text-fg">{fmtNum(it.rows)}</td>
                      <td className="border-b border-line px-2 py-1 text-right tabular-nums text-dim">{fmtBytes(it.sizeBytes)}</td>
                      <td className="whitespace-nowrap border-b border-line px-2 py-1 text-dim">{it.engine ?? ''}</td>
                    </>
                  )}
                  <td className="whitespace-nowrap border-b border-line px-2 py-1 text-dim">{metaTime(it) ?? ''}</td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={hasStorage(tab.kind) ? 7 : 4} className="px-3 py-6 text-center text-dim2">
                    {items && k ? '无匹配对象' : items ? '（空）' : '加载中…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex h-6 shrink-0 items-center border-t border-line bg-panel px-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
        <span>{items ? `${items.length} 个${kindLabel}` : ''}{k ? `，筛选出 ${filtered.length} 个` : ''}</span>
      </div>

      {/* 右键菜单：空白区 → 新建表/刷新；具体对象行 → 打开/编辑结构/删除/新建表/刷新 */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.item)} onClose={() => setMenu(null)} />}

      {/* 新建/编辑表弹窗（本地渲染，创建成功后刷新清单） */}
      {createOpen && (
        <CreateTableDialog
          connectionId={tab.connId}
          preset={{ db: tab.pgDb, schema: tab.schema, objectKind: tab.kind, editName }}
          onClose={() => { setCreateOpen(false); setEditName(undefined); }}
          onCreated={() => { setCreateOpen(false); setEditName(undefined); void load(); }}
        />
      )}
    </div>
  );
}

/** 列类型小图标（Navicat 表头风格）：主键钥匙 / 数值 # / 文本 A / 日期日历 / 其他格子 */
function ColKeyIcon() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" aria-hidden>
      <title>主键</title>
      <circle cx="5.5" cy="5.5" r="3.2" fill="none" stroke="#4aa8e8" strokeWidth="1.6" />
      <path d="M8 8l5 5M11 11l1.6-1.6M12.6 12.6l1.4-1.4" stroke="#4aa8e8" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}
function ColNumIcon() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" aria-hidden>
      <title>数值</title>
      <text x="8" y="12" textAnchor="middle" fontSize="10" fontWeight="700" fill="#5bb8d4">#</text>
    </svg>
  );
}
function ColTextIcon() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" aria-hidden>
      <title>文本</title>
      <text x="8" y="12.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#8fbf6f">A</text>
    </svg>
  );
}
function ColDateIcon() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="none" stroke="#c9a35a" strokeWidth="1.4" aria-hidden>
      <title>日期/时间</title>
      <rect x="2" y="3" width="12" height="11" rx="1" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
    </svg>
  );
}
function ColGenericIcon() {
  return (
    <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="none" stroke="#9aa3ad" strokeWidth="1.4" aria-hidden>
      <title>字段</title>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M2.5 6h11M2.5 10h11M6.5 2.5v11" />
    </svg>
  );
}
/** 按数据类型挑表头图标 */
function ColTypeIcon({ dataType, isPk }: { dataType?: string; isPk: boolean }) {
  if (isPk) return <ColKeyIcon />;
  const t = (dataType ?? '').toLowerCase();
  if (/int|decimal|numeric|float|double|real|number|bit|serial|money/.test(t)) return <ColNumIcon />;
  if (/char|text|clob|string|enum|json|uuid|xml/.test(t)) return <ColTextIcon />;
  if (/date|time/.test(t)) return <ColDateIcon />;
  return <ColGenericIcon />;
}

/** Navicat 风格数据网格（行号列 + 表头类型图标 + 整列高亮 + 当前单元格描边 + 排序 + 列筛选 + 内联编辑） */
/** 记录视图（选中行按 Tab 切换）：该行竖排为 字段名 / 值 两列，Navicat「记录」页风格；双击值单元格进入编辑（与表格网格同款编辑器） */
function RecordDetailView({ columns, pkCols, comments, rows, ri, edits, deleted, editable, editing, onCellDblClick, onCellChange, onEditEnd, onCommitShortcut, onBack }: {
  columns: QueryColumn[];
  pkCols: string[];
  /** 字段注释映射（hover 字段名展示；无注释的字段回退显示类型） */
  comments?: Record<string, string>;
  /** 筛选排序后的展示行（含原始行索引） */
  rows: { ri: number; row: Record<string, unknown> }[];
  /** 选中的原始行索引 */
  ri: number;
  /** 未提交编辑（应用后展示） */
  edits: Record<string, string>;
  /** 该行是否被标记删除 */
  deleted: boolean;
  /** 是否可编辑（有主键） */
  editable: boolean;
  /** 与表格共享的编辑状态（进入编辑的字段） */
  editing: { ri: number; col: string } | null;
  onCellDblClick: (ri: number, col: string) => void;
  onCellChange: (ri: number, col: string, val: string) => void;
  onEditEnd: () => void;
  /** Ctrl+S 提交（延迟一拍，等编辑值写入 edits） */
  onCommitShortcut: () => void;
  onBack: () => void;
}) {
  /** 值单元格右键菜单状态（{ x, y, 字段名, 当前值是否为 NULL }）——Hooks 必须在提前 return 之前无条件执行，否则行消失时 hooks 数量变化导致整树崩溃 */
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; col: string; isNull: boolean } | null>(null);
  const ent = rows.find(({ ri: r }) => r === ri);
  if (!ent) {
    return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">该行已不在当前筛选/排序结果中（按 Tab 返回表格）。</div>;
  }

  const copyText = (s: string) => {
    try {
      void navigator.clipboard?.writeText(s);
    } catch {
      /* 剪贴板不可用时静默忽略 */
    }
  };

  /** 构造值单元格右键菜单项 */
  const buildCellMenu = (): MenuItem[] => {
    const col = cellMenu!.col;
    const key = `${ri}::${col}`;
    const rawVal = edits[key] !== undefined ? edits[key] : ent.row[col];
    return [
      {
        label: '置为 NULL',
        disabled: !editable || cellMenu!.isNull,
        onClick: () => onCellChange(ri, col, ''),
      },
      { label: '', separator: true },
      {
        label: '复制值',
        onClick: () => copyText(rawVal === null || rawVal === undefined ? '' : String(rawVal)),
      },
      { label: '复制字段名', onClick: () => copyText(col) },
      { label: '', separator: true },
      {
        label: '编辑此字段',
        disabled: !editable,
        onClick: () => onCellDblClick(ri, col),
      },
    ];
  };

  return (
    <div className="p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded bg-accent/20 px-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-accent">记录视图 · 第 {ri + 1} 行</span>
        {deleted && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-prod">已标记删除</span>}
        {!editable && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">只读（无主键）</span>}
        <button onClick={onBack} className="ml-auto rounded border border-line px-1.5 py-px text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3" title="返回表格（也可按 Tab）">
          返回表格 (Tab)
        </button>
      </div>
      <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-panel2">
            <th className="w-40 border-b-2 border-r border-line px-2 py-1 text-left font-medium text-fg">字段</th>
            <th className="border-b-2 border-line px-2 py-1 text-left font-medium text-fg">值</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => {
            const key = `${ri}::${c.name}`;
            const raw = edits[key] !== undefined ? edits[key] : ent.row[c.name];
            const isNull = raw === null || raw === undefined;
            const isEditing = editing?.ri === ri && editing.col === c.name;
            return (
              <tr key={c.name} className="hover:bg-[rgb(255_255_255_/_0.03)]">
                <td
                  className="whitespace-nowrap border-b border-r border-line bg-panel px-2 py-1 align-top"
                  title={comments?.[c.name] ? `${c.name} · ${comments[c.name]}` : `${c.name}${c.dataType ? ` · ${c.dataType}` : ''}`}
                >
                  <span className="flex items-center gap-1">
                    <ColTypeIcon dataType={c.dataType} isPk={pkCols.includes(c.name)} />
                    <span className="font-medium text-fg">{c.name}</span>
                    {pkCols.includes(c.name) && <span className="text-[9px] text-[#e8b339]">PK</span>}
                    {c.dataType && <span className="text-[9px] text-dim2">{c.dataType}</span>}
                  </span>
                </td>
                <td
                  className="relative border-b border-line px-2 py-1 text-left"
                  onDoubleClick={() => editable && onCellDblClick(ri, c.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCellMenu({ x: e.clientX, y: e.clientY, col: c.name, isNull });
                  }}
                  title={editable ? '双击编辑 · 右键菜单' : '右键复制'}
                >
                  {/* 内联编辑：直接替换值内容（记录视图为竖向布局，无横向撑宽问题，对齐随列保持一致） */}
                  {isEditing ? (
                    isDateTimeType(c.dataType) ? (
                      /* 日期/时间类列：手输 + 日历时间选择弹窗（date 类型只有年月日） */
                      <DateTimeCellEditor
                        initialValue={edits[key] ?? editInit(ent.row[c.name], c.dataType)}
                        dataType={c.dataType}
                        autoOpen
                        onCommit={(v) => { onCellChange(ri, c.name, v); onEditEnd(); }}
                        onCancel={onEditEnd}
                      />
                    ) : (
                      <input
                        autoFocus
                        defaultValue={edits[key] ?? editInit(ent.row[c.name], c.dataType)}
                        onBlur={(e) => {
                          if (editChanged(ent.row[c.name], e.target.value)) onCellChange(ri, c.name, e.target.value);
                          onEditEnd();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (editChanged(ent.row[c.name], (e.target as HTMLInputElement).value)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                            onEditEnd();
                          }
                          if (e.key === 'Escape') onEditEnd();
                          /* Ctrl+S：先写入当前输入值，再延迟触发提交（不让 window 监听重复触发） */
                          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                            e.preventDefault();
                            e.stopPropagation();
                            if (editChanged(ent.row[c.name], (e.target as HTMLInputElement).value)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                            onEditEnd();
                            onCommitShortcut();
                          }
                        }}
                        className="w-full bg-bg px-1 py-0.5 text-left text-[length:calc(var(--pref-fs)*0.786)] text-fg outline outline-1 outline-accent"
                      />
                    )
                  ) : isNull ? (
                    <span className="italic text-dim2">(Null)</span>
                  ) : (
                    <span className={`block whitespace-pre-wrap break-all text-fg ${edits[key] !== undefined ? 'bg-warn/25' : ''}`}>{fmt(raw, c.dataType)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cellMenu && <ContextMenu x={cellMenu.x} y={cellMenu.y} items={buildCellMenu()} onClose={() => setCellMenu(null)} />}
    </div>
  );
}

function EditableGrid({
  columns,
  pkCols,
  comments,
  displayRows,
  newRows,
  edits,
  deleted,
  editing,
  selected,
  curCol,
  selRows,
  selCols,
  editable,
  sort,
  onCellDblClick,
  onCellChange,
  onCellContextMenu,
  onEditEnd,
  onCommitShortcut,
  onNewChange,
  onCellMouseDown,
  onCellMouseEnter,
  onHeaderMouseDown,
  onHeaderMouseEnter,
  onGutterMouseDown,
  onGutterMouseEnter,
  onSort,
}: {
  columns: QueryColumn[];
  pkCols: string[];
  /** 字段注释映射（表头 hover 展示；无注释的列回退显示类型） */
  comments?: Record<string, string>;
  /** 筛选排序后的展示行（ri=原始行索引） */
  displayRows: { ri: number; row: Record<string, unknown> }[];
  newRows: Record<string, string>[];
  edits: Record<string, string>;
  deleted: Set<number>;
  editing: { ri: number; col: string } | null;
  selected: number | null;
  /** 当前单元格所在列（整列高亮） */
  curCol: string | null;
  /** 多选行集合 / 多选列集合（共同构成矩形选区） */
  selRows: Set<number>;
  selCols: Set<string>;
  editable: boolean;
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  onCellDblClick: (ri: number, col: string) => void;
  onCellChange: (ri: number, col: string, val: string) => void;
  /** 值单元格右键菜单（x/y 为光标坐标，isNull 供「置为 NULL」禁用判断） */
  onCellContextMenu?: (ri: number, col: string, x: number, y: number, isNull: boolean) => void;
  onEditEnd: () => void;
  /** Ctrl+S 提交（延迟一拍，等编辑值写入 edits） */
  onCommitShortcut: () => void;
  onNewChange: (i: number, col: string, val: string) => void;
  /** 值单元格按下（左键单选并进入拖拽；Shift 扩展矩形）；拖拽经过的单元格 */
  onCellMouseDown: (ri: number, col: string, e: React.MouseEvent) => void;
  onCellMouseEnter: (ri: number, col: string) => void;
  /** 表头按下 / 拖拽经过：整列或多列选区 */
  onHeaderMouseDown: (col: string, e: React.MouseEvent) => void;
  onHeaderMouseEnter: (col: string) => void;
  /** 行号栏按下 / 拖拽经过：整行或多行选区 */
  onGutterMouseDown: (ri: number, e: React.MouseEvent) => void;
  onGutterMouseEnter: (ri: number) => void;
  onSort: (col: string) => void;
  isPg: boolean;
}) {
  /** 数值列右对齐（Navicat 习惯） */
  // 当前单元格整列高亮 / 选中行的底色（暗色主题下用主题蓝透明叠加，等价 Navicat 的浅蓝高亮）
  const colTint = 'bg-[rgb(14_99_156_/_0.16)]';
  const colTintHead = 'bg-[rgb(14_99_156_/_0.30)]';
  const rowSelBg = 'bg-[rgb(14_99_156_/_0.30)]';
  return (
    <table className="w-full select-none border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
      <thead className="sticky top-0 z-10">
        {/* 表头：图标 + 列名，点击排序（asc → desc → 取消） */}
        <tr className="bg-panel2">
          <th
            className="w-9 cursor-pointer select-none border-b-2 border-r border-line bg-panel px-1 py-1 text-right text-dim2 hover:bg-panel3"
            onMouseDown={(e) => onGutterMouseDown(-1, e)}
            onMouseEnter={() => onGutterMouseEnter(-1)}
            title="点击/拖拽选中所有行"
          >#</th>
          {columns.map((c) => {
            const isSorted = sort?.col === c.name;
            const isCur = curCol === c.name;
            const isColSel = selCols.has(c.name);
            return (
              <th
                key={c.name}
                onClick={() => onSort(c.name)}
                onMouseDown={(e) => onHeaderMouseDown(c.name, e)}
                onMouseEnter={() => onHeaderMouseEnter(c.name)}
                title={`${c.name}${comments?.[c.name] ? ` · ${comments[c.name]}` : c.dataType ? ` · ${c.dataType}` : ''}${c.nullable === false ? ' · NOT NULL' : ''}（点击排序；拖拽可选中多列）`}
                className={`cursor-pointer select-none whitespace-nowrap border-b-2 border-r border-line px-2 py-1 text-left font-medium ${isColSel ? colTintHead : isCur ? colTintHead : 'bg-panel2 hover:bg-panel3'} ${isSorted ? 'text-accent' : 'text-fg'}`}
              >
                <span className="flex items-center gap-1">
                  <ColTypeIcon dataType={c.dataType} isPk={pkCols.includes(c.name)} />
                  {c.name}
                  {isSorted && <span className="ml-0.5">{sort?.dir === 'asc' ? '▲' : '▼'}</span>}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {displayRows.map(({ ri, row }, order) => {
          const isDeleted = deleted.has(ri);
          const isSel = selRows.has(ri);
          const isAnchor = selected === ri;
          const isDirty = [...Object.keys(edits)].some((k) => k.startsWith(`${ri}::`));
          return (
            <tr
              key={`b${ri}`}
              data-ri={ri}
              className={`${isDeleted ? 'opacity-40 line-through' : ''} ${isDirty && !isSel ? 'bg-warn/20' : 'hover:bg-panel3/60'}`}
            >
              <td
                className={`cursor-pointer border-b border-r border-line bg-panel px-1 py-[3px] text-right ${isAnchor ? 'font-semibold text-accent' : isSel ? 'text-fg' : 'text-dim2'}`}
                onMouseDown={(e) => { e.stopPropagation(); onGutterMouseDown(ri, e); }}
                onMouseEnter={() => onGutterMouseEnter(ri)}
                title="点击/拖拽选中该行（可沿行号栏上下拖拽多选整行）；标记删除请用工具栏「删除选中行」按钮；选中后按 Tab 切换记录视图"
              >
                {order + 1}
              </td>
              {columns.map((c) => {
                const key = `${ri}::${c.name}`;
                const isEditing = editing?.ri === ri && editing?.col === c.name;
                const isCellSel = selRows.has(ri) && selCols.has(c.name);
                const isCurCell = isAnchor && curCol === c.name;
                const val = edits[key] !== undefined ? edits[key] : row[c.name];
                const cellBg = isCellSel ? rowSelBg : curCol === c.name ? colTint : '';
                return (
                  <td
                    key={c.name}
                    className={`relative max-w-[280px] cursor-cell border-b border-r border-line px-2 py-[3px] ${cellBg} text-fg ${isCurCell && !isEditing ? 'outline outline-1 -outline-offset-1 outline-[rgb(90_170_240)]' : ''}`}
                    onMouseDown={(e) => {
                      // 编辑器内部点击（含 portal 到 body 的日历弹层）不触发选区/抢焦点
                      if ((e.target as HTMLElement).closest('[data-dt-cell-editor]')) return;
                      onCellMouseDown(ri, c.name, e);
                    }}
                    onMouseEnter={() => onCellMouseEnter(ri, c.name)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onCellContextMenu?.(ri, c.name, e.clientX, e.clientY, val === null || val === undefined);
                    }}
                    onDoubleClick={() => editable && onCellDblClick(ri, c.name)}
                    title={editable ? '拖拽/Shift 多选整列多行；双击编辑；右键菜单' : undefined}
                  >
                    {/* 原内容始终渲染以撑住列宽；编辑器用绝对定位悬浮覆盖，不影响表格布局 */}
                    <span className={val === null || val === undefined ? 'italic text-dim2' : 'block truncate'}>{val === null || val === undefined ? '(Null)' : fmt(val, c.dataType)}</span>
                    {isEditing && (
                      <div data-dt-cell-editor className="absolute inset-0 z-20 flex items-stretch">
                        {isDateTimeType(c.dataType) ? (
                          /* 日期/时间类列：手输 + 日历时间选择弹窗（date 类型只有年月日） */
                          <DateTimeCellEditor
                            initialValue={edits[key] ?? editInit(row[c.name], c.dataType)}
                            dataType={c.dataType}
                            autoOpen
                            onCommit={(v) => { onCellChange(ri, c.name, v); onEditEnd(); }}
                            onCancel={onEditEnd}
                          />
                        ) : (
                          <input
                            autoFocus
                            defaultValue={edits[key] ?? editInit(row[c.name], c.dataType)}
                            onBlur={(e) => {
                              if (editChanged(row[c.name], e.target.value)) onCellChange(ri, c.name, e.target.value);
                              onEditEnd();
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                if (editChanged(row[c.name], (e.target as HTMLInputElement).value)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                                onEditEnd();
                              }
                              if (e.key === 'Escape') onEditEnd();
                              /* Ctrl+S：先写入当前输入值，再延迟触发提交（不让 window 监听重复触发） */
                              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                                e.preventDefault();
                                e.stopPropagation();
                                if (editChanged(row[c.name], (e.target as HTMLInputElement).value)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                                onEditEnd();
                                onCommitShortcut();
                              }
                            }}
                            className={`h-full w-full bg-bg px-1 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline outline-1 outline-accent text-left`}
                          />
                        )}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}

        {/* 新增行 */}
        {newRows.map((nr, i) => (
          <tr key={`n${i}`} className="bg-ok/10">
            <td className="border-b border-r border-line bg-panel px-1 py-[3px] text-right text-ok" title="新增行">
              +{i + 1}
            </td>
            {columns.map((c) => (
              <td key={c.name} className={`border-b border-r border-line px-2 py-[3px]`}>
                {isDateTimeType(c.dataType) ? (
                  <DateTimeCellEditor
                    initialValue={nr[c.name] ?? ''}
                    dataType={c.dataType}
                    onCommit={(v) => onNewChange(i, c.name, v)}
                    onCancel={() => {}}
                  />
                ) : (
                  <input
                    value={nr[c.name] ?? ''}
                    onChange={(e) => onNewChange(i, c.name, e.target.value)}
                    placeholder={pkCols.includes(c.name) ? '自增可留空' : ''}
                    className="w-full min-w-0 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2"
                  />
                )}
              </td>
            ))}
          </tr>
        ))}

        {displayRows.length === 0 && newRows.length === 0 && (
          <tr>
            <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-dim2">
              无数据
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** 属性子页：列结构一览（DBeaver 属性页风格）+ 结构编辑（新增/删除字段/双击编辑） */
function ColumnsView({ meta, loading, ddlMsg, dialect, onAdd, onDrop, onAlter }: {
  meta: DbColumn[];
  loading: boolean;
  ddlMsg: string | null;
  /** 连接方言（mysql / postgres / oracle），决定双击编辑生成的 ALTER 行为 */
  dialect: string;
  onAdd: () => void;
  onDrop: (name: string) => void;
  /** 双击提交修改（仅变化的字段）；resolve = 成功（父组件已刷新结构） */
  onAlter: (oldName: string, spec: DbColumnAlterSpec) => Promise<void>;
}) {
  /** 内联编辑状态：目标列 + 编辑字段 + 当前输入值（null = 未在编辑） */
  const [edit, setEdit] = useState<{ name: string; field: 'name' | 'type' | 'default' | 'comment'; value: string } | null>(null);
  /** 空性内联编辑：目标列名（双击弹出 可空/非空 下拉） */
  const [nullEdit, setNullEdit] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (edit) inputRef.current?.focus();
  }, [edit]);

  if (loading && meta.length === 0) return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载列结构…</div>;

  /**
   * 组装并提交 ALTER 规格（仅提交变化的字段）。
   * MySQL 语义要求完整列定义，故始终带上 fullType/nullable/autoIncrement，否则 MODIFY 会丢属性。
   */
  const commit = async (field: 'name' | 'type' | 'default' | 'comment', value: string, col: DbColumn) => {
    setEdit(null);
    const isMysql = dialect === 'mysql';
    const spec: DbColumnAlterSpec = {};
    if (isMysql) {
      spec.fullType = col.fullType ?? col.dataType;
      spec.nullable = col.nullable;
      if (col.extra === 'auto_increment') spec.autoIncrement = true;
    }
    let changed = false;
    if (field === 'name') {
      const nv = value.trim();
      if (nv && nv !== col.name) { spec.name = nv; changed = true; }
    } else if (field === 'type') {
      const tv = value.trim();
      if (tv && tv !== (col.fullType ?? col.dataType)) { spec.fullType = tv; changed = true; }
    } else if (field === 'default') {
      if (value !== (col.defaultValue ?? '')) { spec.defaultValue = value; changed = true; }
    } else if (field === 'comment') {
      if (value !== (col.comment ?? '')) { spec.comment = value; changed = true; }
    }
    if (!changed) return;
    await onAlter(col.name, spec);
  };

  /** 提交空性变更（可空 ⇄ 非空） */
  const commitNullable = async (col: DbColumn, nullable: boolean) => {
    setNullEdit(null);
    if (nullable === col.nullable) return;
    const spec: DbColumnAlterSpec = { nullable };
    if (dialect === 'mysql') {
      spec.fullType = col.fullType ?? col.dataType;
      if (col.extra === 'auto_increment') spec.autoIncrement = true;
    }
    await onAlter(col.name, spec);
  };

  /** 通用内联输入框（Enter 提交 / Esc 取消 / 失焦提交）——样式与数据网格编辑态一致：整格宽度 + 蓝色 outline */
  const InlineInput = ({ field, initial }: { field: 'name' | 'type' | 'default' | 'comment'; initial: string }) => (
    <input
      ref={inputRef}
      defaultValue={initial}
      /* size=2 压掉 input 固有宽度：auto 列布局下 input 的默认 size(≈20字符) 会把整列撑宽 */
      size={2}
      className="w-full min-w-0 bg-bg px-1 py-0.5 text-left text-fg outline outline-1 outline-accent"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit(field, (e.target as HTMLInputElement).value, meta.find((c) => c.name === edit?.name)!);
        if (e.key === 'Escape') setEdit(null);
      }}
      onBlur={(e) => void commit(field, e.target.value, meta.find((c) => c.name === edit?.name)!)}
    />
  );

  /** 单元格通用双击起点（样式类合并进各自的 className，避免覆盖） */
  const startEdit = (col: DbColumn, field: 'name' | 'type' | 'default' | 'comment', hint: string) => ({
    onDoubleClick: () => setEdit({ name: col.name, field, value: '' }),
    title: `${hint}（双击编辑，Enter 提交 / Esc 取消）`,
  });

  return (
    <div>
      {/* 结构编辑工具条：新增字段 + 操作结果提示 */}
      <div className="flex items-center gap-2 border-b border-line bg-panel px-2 py-1">
        <button
          onClick={onAdd}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-accent hover:bg-panel3"
          title="新增字段（ALTER TABLE ADD COLUMN）"
        >
          ＋ 新增字段
        </button>
        <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">双击 列名 / 类型 / 非空 / 默认值 / 注释 可直接编辑</span>
        {ddlMsg && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{ddlMsg}</span>}
      </div>
      <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
        <thead className="sticky top-0 z-10 bg-panel2">
          <tr className="text-left text-dim2">
            <th className="w-10 border-b border-r border-line px-2 py-1 text-right font-medium">#</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">列名</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">数据类型</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">标识</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">排序规则</th>
            <th className="w-12 border-b border-r border-line px-2 py-1 font-medium">非空</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">默认值</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">注释</th>
            <th className="w-14 border-b border-line px-2 py-1 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {meta.map((c) => (
            <tr key={c.name} className="hover:bg-panel3">
              <td className="border-b border-r border-line px-2 py-1 text-right text-dim2">{c.ordinal ?? ''}</td>
              <td className="cursor-text whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg" {...startEdit(c, 'name', '修改列名（RENAME）')}>
                {edit?.name === c.name && edit.field === 'name' ? (
                  <InlineInput field="name" initial={c.name} />
                ) : (
                  <>
                    {c.key === 'PRI' && <span className="mr-1 text-warn" title="主键">🔑</span>}
                    {c.name}
                  </>
                )}
              </td>
              <td className="cursor-text whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg" {...startEdit(c, 'type', '修改数据类型（ALTER TYPE / MODIFY）')}>
                {edit?.name === c.name && edit.field === 'type' ? (
                  <InlineTypeSelect
                    initial={shortTypeName(c.fullType ?? c.dataType)}
                    options={commonTypesFor(dialect)}
                    onCommit={(v) => void commit('type', v, c)}
                    onCancel={() => setEdit(null)}
                  />
                ) : shortTypeName(c.fullType ?? c.dataType)}
              </td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-accent">
                {c.extra === 'auto_increment' ? 'auto_increment' : c.extra === 'identity' ? 'identity' : ''}
              </td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-dim">{c.collation ?? ''}</td>
              <td
                className="cursor-pointer border-b border-r border-line px-2 py-1 text-center text-dim2"
                onDoubleClick={() => { if (c.key !== 'PRI') setNullEdit(c.name); }}
                title={c.key === 'PRI' ? '主键列固定非空' : '双击切换 可空 / 非空'}
              >
                {nullEdit === c.name ? (
                  <select
                    autoFocus
                    defaultValue={c.nullable ? 'y' : 'n'}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => void commitNullable(c, e.target.value === 'y')}
                    onBlur={() => setNullEdit(null)}
                    className="rounded border border-accent bg-bg px-0.5 text-fg outline-none"
                  >
                    <option value="y">可空</option>
                    <option value="n">非空</option>
                  </select>
                ) : (
                  c.nullable ? '' : '√'
                )}
              </td>
              <td
                className="max-w-[220px] cursor-text truncate border-b border-r border-line px-2 py-1 text-dim"
                {...startEdit(c, 'default', '修改默认值（清空 = 移除默认值）')}
              >
                {edit?.name === c.name && edit.field === 'default' ? <InlineInput field="default" initial={c.defaultValue ?? ''} /> : (c.defaultValue ?? '')}
              </td>
              <td
                className="max-w-[320px] cursor-text truncate border-b border-r border-line px-2 py-1 text-dim"
                {...startEdit(c, 'comment', '修改注释（清空 = 清除注释）')}
              >
                {edit?.name === c.name && edit.field === 'comment' ? <InlineInput field="comment" initial={c.comment ?? ''} /> : (c.comment ?? '')}
              </td>
              <td className="border-b border-line px-2 py-1 text-center">
                <button
                  onClick={() => onDrop(c.name)}
                  className="text-[length:calc(var(--pref-fs)*0.714)] text-prod hover:underline"
                  title={`删除字段 ${c.name}（ALTER TABLE DROP COLUMN，不可恢复）`}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
          {meta.length === 0 && !loading && (
            <tr>
              <td colSpan={9} className="px-3 py-6 text-center text-dim2">
                无列信息
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 各方言常用数据类型（列设计类型下拉） */
function commonTypesFor(dialect: string): string[] {
  if (dialect === 'postgres') {
    return [
      'bigint', 'integer', 'smallint', 'numeric(10,2)', 'double precision', 'real',
      'varchar(255)', 'char(36)', 'text', 'boolean', 'jsonb', 'json',
      'date', 'timestamp', 'timestamptz', 'time', 'uuid', 'bytea',
    ];
  }
  if (dialect === 'oracle') {
    return [
      'NUMBER(10)', 'NUMBER(19,4)', 'NUMBER', 'VARCHAR2(255)', 'VARCHAR2(1000)', 'CHAR(36)',
      'CLOB', 'NCLOB', 'BLOB', 'DATE', 'TIMESTAMP', 'TIMESTAMP(6)', 'RAW(16)', 'FLOAT',
    ];
  }
  return [
    'bigint(20)', 'int', 'smallint', 'tinyint', 'decimal(10,2)', 'double', 'float',
    'varchar(255)', 'char(36)', 'text', 'longtext', 'json',
    'date', 'datetime', 'timestamp', 'time', 'blob',
  ];
}

/** 类型内联下拉（双击类型单元格出现）：不做筛选——始终弹出全量类型列表，也可直接键入任意类型；选择/Enter 提交，Esc 取消 */
function InlineTypeSelect({ initial, options, onCommit, onCancel }: {
  initial: string;
  options: string[];
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // 下拉不筛选：datalist 会按输入内容过滤选项，这里换成自定义全量列表（portal 到 body，避免被表格滚动容器裁剪）
  const [open, setOpen] = useState(true);
  const [hi, setHi] = useState(-1);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const list = options.includes(initial) ? options : [initial, ...options];

  const syncRect = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setRect({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 180) });
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    syncRect();
  }, []);
  const commitValue = (v: string) => {
    const t = v.trim();
    if (t) onCommit(t);
    else onCancel();
  };
  return (
    <>
      <input
        ref={ref}
        defaultValue={initial}
        /* size=2 压掉 input 固有宽度，避免编辑态把「数据类型」列撑宽 */
        size={2}
        spellCheck={false}
        className="w-full min-w-0 bg-bg px-1 py-0.5 text-left font-mono text-fg outline outline-1 outline-accent"
        onClick={(e) => { e.stopPropagation(); syncRect(); setOpen(true); setHi(-1); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { syncRect(); setOpen(true); }
            const d = e.key === 'ArrowDown' ? 1 : -1;
            setHi((p) => (p + d + list.length) % list.length);
          } else if (e.key === 'Enter') {
            commitValue(open && hi >= 0 ? list[hi] : (e.target as HTMLInputElement).value);
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
        onBlur={(e) => commitValue(e.target.value)}
        title="输入或选择数据类型（↑↓ 选择 / Enter 提交 / Esc 取消）"
      />
      {open && rect && createPortal(
        <div
          className="fixed z-[60] max-h-64 min-w-[180px] overflow-auto rounded-md border border-line bg-panel2 py-1 font-mono text-[13px] text-fg shadow-lg"
          style={{ left: rect.left, top: rect.top, width: rect.width }}
        >
          {list.map((t, i) => (
            <div
              key={t}
              /* onMouseDown + preventDefault：先于 input blur 触发，避免失焦提交导致下拉未点先卸载 */
              onMouseDown={(e) => { e.preventDefault(); onCommit(t); }}
              onMouseEnter={() => setHi(i)}
              className={`cursor-pointer px-2.5 py-1 ${i === hi ? 'bg-sel text-accent' : ''}`}
            >
              {t}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 由内省元数据合成 CREATE TABLE DDL（方言感知：PG/Oracle 双引号、MySQL 反引号；含表/列注释） */
function buildTableDdl(dialect: string, schema: string | undefined, table: string, cols: DbColumn[], indexes: DbIndex[], fks: DbForeignKey[], trigs: DbTrigger[], tableComment?: string): string {
  try {
    const q = (n: string) => (dialect === 'mysql' ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`);
    const qStr = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
    const tbl = schema ? `${q(schema)}.${q(table)}` : q(table);
    const isPg = dialect === 'postgres';
    const isMysql = dialect === 'mysql';
    const colLines = (cols ?? []).map((c) => {
      const name = c?.name ?? 'unknown_column';
      const type = shortTypeName(c?.fullType ?? c?.dataType ?? 'unknown_type');
      let line = `  ${q(name)} ${type}`;
      if (isPg && c?.extra === 'identity') line += ' GENERATED BY DEFAULT AS IDENTITY';
      if (!c?.nullable) line += ' NOT NULL';
      if (c?.defaultValue != null && c?.defaultValue !== '') line += ` DEFAULT ${c.defaultValue}`;
      if (isMysql && c?.extra === 'auto_increment') line += ' AUTO_INCREMENT';
      // MySQL 列注释内联在列定义里；PG/Oracle 走 COMMENT ON 语句（见后）
      if (isMysql && c?.comment) line += ` COMMENT ${qStr(c.comment)}`;
      return line;
    });
    const pk = (cols ?? []).filter((c) => c?.key === 'PRI').map((c) => q(c.name));
    if (pk.length) colLines.push(`  PRIMARY KEY (${pk.join(', ')})`);
    let ddl = isMysql
      ? `CREATE TABLE ${tbl} (\n${colLines.join(',\n')}\n)${tableComment ? ` COMMENT=${qStr(tableComment)}` : ''};`
      : `CREATE TABLE ${tbl} (\n${colLines.join(',\n')}\n);`;
    // PG / Oracle：表与列注释以 COMMENT ON 语句补齐
    if (!isMysql) {
      if (tableComment) ddl += `\n\nCOMMENT ON TABLE ${tbl} IS ${qStr(tableComment)};`;
      for (const c of cols ?? []) {
        if (c?.comment) ddl += `\nCOMMENT ON COLUMN ${tbl}.${q(c.name)} IS ${qStr(c.comment)};`;
      }
    }
    for (const ix of indexes ?? []) {
      if (ix.columns.length && ix.columns.every((col) => pk.includes(q(col)))) continue; // 跳过主键索引（已含在 PK 约束）
      ddl += `\n\nCREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${tbl} (${ix.columns.map(q).join(', ')});`;
    }
    for (const fk of fks ?? []) {
      const ref = fk.refTable.includes('.') ? fk.refTable : schema ? `${q(schema)}.${q(fk.refTable)}` : q(fk.refTable);
      const extra = `${fk.onDelete && fk.onDelete !== 'NO ACTION' ? ` ON DELETE ${fk.onDelete}` : ''}${fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${fk.onUpdate}` : ''}`;
      ddl += `\n\nALTER TABLE ${tbl} ADD CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map(q).join(', ')})${extra};`;
    }
    for (const tg of trigs ?? []) {
      ddl += `\n\n-- Trigger: ${q(tg.name)} (${tg.timing} ${tg.events} ON ${tg.table})`;
      if (tg.body) ddl += `\n-- ${tg.body.replace(/\n/g, '\n-- ')}`;
    }
    return ddl;
  } catch (e) {
    return `/* DDL 生成失败：${(e as Error).message} */`;
  }
}

/** 表设计器「索引」子页（Navicat 索引列表风格） */
function IndexListView({ items, loading, error, ddlMsg, onReload, onAdd }: { items: DbIndex[]; loading: boolean; error: string | null; ddlMsg?: string | null; onReload: () => void; onAdd: () => void }) {
  if (error) return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-prod">加载索引失败：{error} <button onClick={onReload} className="ml-2 text-accent hover:underline">重试</button></div>;
  if (loading && items.length === 0) return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载索引…</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 索引工具条：新增索引 + 操作结果提示 */}
      <div className="flex items-center gap-2 border-b border-line bg-panel px-2 py-1">
        <button
          onClick={onAdd}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-accent hover:bg-panel3"
          title="新增索引（CREATE INDEX）"
        >
          ＋ 新增索引
        </button>
        {ddlMsg && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{ddlMsg}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
        <thead className="sticky top-0 z-10 bg-panel2">
          <tr className="text-left text-dim2">
            <th className="w-10 border-b border-r border-line px-2 py-1 text-right font-medium">#</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">索引名</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">列</th>
            <th className="w-16 border-b border-r border-line px-2 py-1 text-center font-medium">唯一</th>
            <th className="border-b border-line px-2 py-1 font-medium">方法</th>
          </tr>
        </thead>
        <tbody>
          {items.map((ix, i) => (
            <tr key={ix.name} className="hover:bg-panel3">
              <td className="border-b border-r border-line px-2 py-1 text-right text-dim2">{i + 1}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">{ix.name}</td>
              <td className="border-b border-r border-line px-2 py-1 text-dim">{ix.columns.join(', ')}</td>
              <td className="border-b border-r border-line px-2 py-1 text-center text-dim2">{ix.unique ? '√' : ''}</td>
              <td className="border-b border-line px-2 py-1 text-dim">{ix.method ?? ''}</td>
            </tr>
          ))}
          {items.length === 0 && !loading && <tr><td colSpan={5} className="px-3 py-6 text-center text-dim2">无索引</td></tr>}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** 表设计器「外键」子页（Navicat 外键列表风格） */
function ForeignKeyListView({ items, loading, error, ddlMsg, onReload, onAdd }: { items: DbForeignKey[]; loading: boolean; error: string | null; ddlMsg?: string | null; onReload: () => void; onAdd: () => void }) {
  if (error) return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-prod">加载外键失败：{error} <button onClick={onReload} className="ml-2 text-accent hover:underline">重试</button></div>;
  if (loading && items.length === 0) return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载外键…</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 外键工具条：新增外键 + 操作结果提示 */}
      <div className="flex items-center gap-2 border-b border-line bg-panel px-2 py-1">
        <button
          onClick={onAdd}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-accent hover:bg-panel3"
          title="新增外键（ALTER TABLE ADD CONSTRAINT … FOREIGN KEY）"
        >
          ＋ 新增外键
        </button>
        {ddlMsg && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{ddlMsg}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
        <thead className="sticky top-0 z-10 bg-panel2">
          <tr className="text-left text-dim2">
            <th className="w-10 border-b border-r border-line px-2 py-1 text-right font-medium">#</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">约束名</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">本表列</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">引用表</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">引用列</th>
            <th className="border-b border-line px-2 py-1 font-medium">删除/更新</th>
          </tr>
        </thead>
        <tbody>
          {items.map((fk, i) => (
            <tr key={fk.name} className="hover:bg-panel3">
              <td className="border-b border-r border-line px-2 py-1 text-right text-dim2">{i + 1}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">{fk.name}</td>
              <td className="border-b border-r border-line px-2 py-1 text-dim">{fk.columns.join(', ')}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">{fk.refTable}</td>
              <td className="border-b border-r border-line px-2 py-1 text-dim">{fk.refColumns.join(', ')}</td>
              <td className="border-b border-line px-2 py-1 text-dim">{[fk.onDelete, fk.onUpdate].filter(Boolean).join(' / ')}</td>
            </tr>
          ))}
          {items.length === 0 && !loading && <tr><td colSpan={6} className="px-3 py-6 text-center text-dim2">无外键</td></tr>}
        </tbody>
      </table>
      </div>
    </div>
  );
}

/** 表设计器「触发器」子页 */
function TriggerListView({ items, loading, error, onReload }: { items: DbTrigger[]; loading: boolean; error: string | null; onReload: () => void }) {
  if (error) return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-prod">加载触发器失败：{error} <button onClick={onReload} className="ml-2 text-accent hover:underline">重试</button></div>;
  if (loading && items.length === 0) return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载触发器…</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
        <thead className="sticky top-0 z-10 bg-panel2">
          <tr className="text-left text-dim2">
            <th className="w-10 border-b border-r border-line px-2 py-1 text-right font-medium">#</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">触发器名</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">时机</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">事件</th>
            <th className="border-b border-line px-2 py-1 font-medium">定义</th>
          </tr>
        </thead>
        <tbody>
          {items.map((tg, i) => (
            <tr key={tg.name} className="hover:bg-panel3">
              <td className="border-b border-r border-line px-2 py-1 text-right text-dim2">{i + 1}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">{tg.name}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-dim">{tg.timing}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-dim">{tg.events}</td>
              <td className="max-w-[420px] truncate border-b border-line px-2 py-1 text-dim" title={tg.body ?? ''}>{tg.body ?? '—'}</td>
            </tr>
          ))}
          {items.length === 0 && !loading && <tr><td colSpan={5} className="px-3 py-6 text-center text-dim2">无触发器</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 轻量 SQL 语法高亮（正则分词 → 彩色 span）。
 * 配色走主题 token（VS Code Dark+ 同源）：注释灰、关键字紫、类型蓝、字符串橙、数字绿、标点弱化。
 * 用于 DDL 预览等只读场景；可编辑场景仍用 CodeMirror。
 */
const SQL_KEYWORDS = new Set([
  'create', 'table', 'primary', 'key', 'not', 'null', 'default', 'comment', 'on', 'column', 'index', 'unique',
  'constraint', 'references', 'foreign', 'alter', 'add', 'drop', 'and', 'or', 'if', 'exists', 'identity', 'always',
  'by', 'asc', 'desc', 'check', 'using', 'with', 'without', 'generated', 'as', 'select', 'from', 'where', 'insert',
  'into', 'values', 'update', 'set', 'delete', 'order', 'group', 'limit', 'cascade', 'restrict', 'is', 'in', 'like',
  'ilike', 'between', 'auto_increment', 'autoincrement', 'collate', 'sequence', 'trigger', 'before', 'after', 'each',
  'row', 'begin', 'end', 'commit', 'grant', 'revoke', 'view', 'materialized', 'returns', 'language', 'plpgsql',
]);
const SQL_TYPES = new Set([
  'bigint', 'bigserial', 'binary', 'bit', 'boolean', 'bool', 'bytea', 'char', 'character', 'clob', 'date', 'datetime',
  'decimal', 'double', 'enum', 'float', 'int', 'int2', 'int4', 'int8', 'integer', 'interval', 'json', 'jsonb',
  'mediumint', 'number', 'numeric', 'nchar', 'nvarchar', 'precision', 'real', 'serial', 'serial4', 'serial8',
  'smallint', 'smallserial', 'text', 'time', 'timestamp', 'timestamptz', 'tinyint', 'uuid', 'varchar', 'varchar2', 'year',
]);

function highlightSql(code: string): React.ReactNode[] {
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$]*)|(\s+)|(.)/g;
  const out: React.ReactNode[] = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(code))) {
    const [tok, com, str, num, word, ws] = m;
    const key = i++;
    if (com) out.push(<span key={key} className="italic text-dim2">{tok}</span>);
    else if (str) out.push(<span key={key} className="text-str">{tok}</span>);
    else if (num) out.push(<span key={key} className="text-num">{tok}</span>);
    else if (word) {
      const low = tok.toLowerCase();
      if (SQL_KEYWORDS.has(low)) out.push(<span key={key} className="font-medium text-purple">{tok}</span>);
      else if (SQL_TYPES.has(low)) out.push(<span key={key} className="text-blue">{tok}</span>);
      else out.push(<span key={key}>{tok}</span>);
    } else out.push(<span key={key} className={ws ? undefined : 'text-dim'}>{tok}</span>);
  }
  return out;
}

/** 表设计器「SQL 预览」子页：展示由元数据合成的 CREATE TABLE + 索引/外键/触发器（SQL 语法高亮） */
function DdlView({ ddl, loading, error }: { ddl: string; loading: boolean; error: string | null }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await api.clipboardWrite(ddl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 忽略：剪贴板不可用时静默 */
    }
  };
  // 兜底：ddl 为空或异常时显示提示，避免黑屏
  const displayDdl = ddl?.trim() ? ddl : '/* 无法生成 DDL：元数据为空或生成失败 */';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">建表 DDL 预览（由内省元数据合成）</span>
        <button onClick={() => void copy()} className="ml-auto text-[length:calc(var(--pref-fs)*0.714)] text-accent hover:underline" title="复制到剪贴板">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-bg p-3 font-mono text-[length:calc(var(--pref-fs)*0.786)] leading-5 text-fg border-t border-line">
        {error ? <span className="text-prod">加载失败：{error}</span> : loading ? '生成中…' : highlightSql(displayDdl)}
      </pre>
    </div>
  );
}

const ddlInputCls = 'h-7 w-full rounded border border-line bg-bg px-2 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2 focus:border-accent/60';

/** 新增字段对话框：对齐 Navicat/DBeaver PG 属性页字段集 —— 列名/类型/标识/排序规则/非空/默认值/注释 */
function AddColumnDialog({ onCancel, onSubmit, isPg, isMysql }: {
  onCancel: () => void;
  onSubmit: (spec: DbColumnSpec) => void;
  isPg: boolean;
  isMysql: boolean;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('varchar(255)');
  const [nullable, setNullable] = useState(true);
  const [def, setDef] = useState('');
  const [comment, setComment] = useState('');
  // PG 专属：标识列策略与排序规则
  const [identity, setIdentity] = useState<'' | 'always' | 'default'>('');
  const [collation, setCollation] = useState('');
  // MySQL 专属：自增
  const [autoIncrement, setAutoIncrement] = useState(false);
  const nameOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim());
  const typeOk = !identity || /^(smallint|integer|bigint)/i.test(type.trim());
  const canSubmit = nameOk && type.trim() !== '' && typeOk;
  const buildSpec = (): DbColumnSpec => ({
    name: name.trim(),
    fullType: type.trim(),
    nullable,
    defaultValue: def.trim() || undefined,
    comment: comment.trim() || undefined,
    ...(isPg && identity ? { identity: identity as 'always' | 'default' } : {}),
    ...(isPg && collation.trim() ? { collation: collation.trim() } : {}),
    ...(isMysql && autoIncrement ? { autoIncrement: true } : {}),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onCancel}>
      <div className="w-[420px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">新增字段</div>
        <div className="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-2 text-[length:calc(var(--pref-fs)*0.786)] text-dim">
          <span>列名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && onSubmit(buildSpec())}
            placeholder="column_name"
            className={ddlInputCls}
          />
          <span>数据类型</span>
          <input
            value={type}
            onChange={(e) => setType(e.target.value)}
            placeholder={isPg ? 'varchar(255) / integer / timestamptz' : 'varchar(255) / int / datetime'}
            className={ddlInputCls}
          />
          {isPg && (
            <>
              <span>标识</span>
              <select
                value={identity}
                onChange={(e) => setIdentity(e.target.value as '' | 'always' | 'default')}
                className={`${ddlInputCls} h-7`}
              >
                <option value="">无</option>
                <option value="always">GENERATED ALWAYS AS IDENTITY</option>
                <option value="default">GENERATED BY DEFAULT AS IDENTITY</option>
              </select>
              <span>排序规则</span>
              <input value={collation} onChange={(e) => setCollation(e.target.value)} placeholder="留空用默认；如 C / zh_CN.utf8" className={ddlInputCls} />
            </>
          )}
          {isMysql && (
            <>
              <span>自增</span>
              <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
                <input type="checkbox" checked={autoIncrement} onChange={(e) => setAutoIncrement(e.target.checked)} />
                AUTO_INCREMENT（需为主键或唯一索引）
              </label>
            </>
          )}
          <span>非空</span>
          <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
            <input type="checkbox" checked={!nullable} onChange={(e) => setNullable(!e.target.checked)} />
            NOT NULL
          </label>
          <span>默认值</span>
          <input value={def} onChange={(e) => setDef(e.target.value)} placeholder="留空表示无；可写 0 / 'x' / CURRENT_TIMESTAMP" className={ddlInputCls} />
          <span>注释</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="字段备注（可选）" className={ddlInputCls} />
        </div>
        {!nameOk && name.trim() !== '' && <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-prod">列名仅允许字母、数字、下划线，且以字母或下划线开头</div>}
        {isPg && !typeOk && <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-prod">PG 标识列仅支持 smallint / integer / bigint 类型</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="h-7 rounded border border-line px-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim hover:bg-panel3">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit(buildSpec())}
            className="h-7 rounded bg-accent px-3 text-[length:calc(var(--pref-fs)*0.786)] text-white hover:opacity-90 disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 新增索引对话框（索引子页）：索引名手输（留空自动生成 idx_{表}_{首列}），
 * 列多选（含顺序即声明顺序）、唯一约束、索引方法（PG: btree/hash/gist/gin/brin…；MySQL: btree/hash）。
 * 提交后由父组件拼 CREATE INDEX 执行。
 */
function AddIndexDialog({ isPg, columns, tableName, onCancel, onSubmit }: {
  isPg: boolean;
  /** 可选列名（来自当前表结构元数据） */
  columns: string[];
  tableName: string;
  onCancel: () => void;
  onSubmit: (name: string, cols: string[], unique: boolean, method: string) => void;
}) {
  const [name, setName] = useState('');
  const [cols, setCols] = useState<string[]>(columns.length ? [columns[0]] : []);
  const [unique, setUnique] = useState(false);
  const [method, setMethod] = useState('btree');
  const methods = isPg ? ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist'] : ['btree', 'hash'];
  const autoName = () => {
    if (name.trim()) return name.trim();
    const first = cols[0];
    return first ? `idx_${tableName}_${first}` : `idx_${tableName}`;
  };
  const toggleCol = (c: string) =>
    setCols((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  const canSubmit = cols.length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onCancel}>
      <div className="w-[400px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">新增索引</div>
        <div className="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-2 text-[length:calc(var(--pref-fs)*0.786)] text-dim">
          <span>索引名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`留空自动生成 idx_${tableName}_…`}
            className={ddlInputCls}
          />
          <span>列</span>
          <div className="max-h-32 overflow-auto rounded border border-line bg-bg p-1.5">
            {columns.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
                <input type="checkbox" checked={cols.includes(c)} onChange={() => toggleCol(c)} />
                {c}
              </label>
            ))}
            {columns.length === 0 && <span className="text-dim2">（无列元数据，请先打开「列」子页加载结构）</span>}
          </div>
          <span>唯一</span>
          <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
            UNIQUE（唯一索引）
          </label>
          <span>方法</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={`${ddlInputCls} h-7`}>
            {methods.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
          将执行：CREATE {unique ? 'UNIQUE ' : ''}INDEX <span className="font-mono">{autoName()}</span> ON … ({cols.join(', ')}){isPg && method ? ` USING ${method}` : ''}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="h-7 rounded border border-line px-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim hover:bg-panel3">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit(autoName(), cols, unique, method)}
            className="h-7 rounded bg-accent px-3 text-[length:calc(var(--pref-fs)*0.786)] text-white hover:opacity-90 disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 新增外键对话框（外键子页）：约束名手输（留空自动生成 fk_{表}_{引用表}），
 * 本表列多选（顺序即声明顺序）、引用表（下拉/手输，可带 schema 前缀）、
 * 引用列（选中引用表后自动加载其列，加载失败可手输逗号分隔）、删除/更新规则。
 * 提交后由父组件拼 ALTER TABLE ADD CONSTRAINT … FOREIGN KEY 执行。
 */
function AddForeignKeyDialog({ isPg, connId, schema, pgDb, columns, tableName, onCancel, onSubmit }: {
  isPg: boolean;
  connId: string;
  /** 当前库 / 模式（PG=模式 / MySQL=库），可能为空 */
  schema: string | undefined;
  pgDb?: string;
  /** 本表可选列名（来自当前表结构元数据） */
  columns: string[];
  tableName: string;
  onCancel: () => void;
  onSubmit: (name: string, cols: string[], refTable: string, refCols: string[], onDelete: string, onUpdate: string) => void;
}) {
  const [name, setName] = useState('');
  const [cols, setCols] = useState<string[]>(columns.length ? [columns[0]] : []);
  const [refTable, setRefTable] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [refCols, setRefCols] = useState<string[]>([]);
  const [refColsManual, setRefColsManual] = useState('');
  const [refColOptions, setRefColOptions] = useState<string[] | null>(null);
  const [refColsLoading, setRefColsLoading] = useState(false);
  const [onDelete, setOnDelete] = useState('');
  const [onUpdate, setOnUpdate] = useState('');
  const rules = ['', 'CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'];
  const refTableOk = /^[a-zA-Z_][\w$]*(\.[a-zA-Z_][\w$]*)*$/.test(refTable.trim());
  const bareTable = refTable.trim().includes('.') ? refTable.trim().split('.').pop()! : refTable.trim();
  const autoName = () => {
    if (name.trim()) return name.trim();
    return bareTable ? `fk_${tableName}_${bareTable}` : `fk_${tableName}`;
  };
  const toggleCol = (c: string) =>
    setCols((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  const toggleRefCol = (c: string) =>
    setRefCols((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]));
  // 引用表候选：打开对话框时拉取当前库/模式下的表清单（失败静默，仍可手输）
  useEffect(() => {
    let alive = true;
    api.listTables(connId, schema || undefined)
      .then((list) => { if (alive) setTables((list ?? []).filter(Boolean)); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [connId, schema]);
  // 引用表变化：自动加载其列清单（失败回退手输）
  useEffect(() => {
    const t = refTable.trim();
    setRefColOptions(null);
    setRefCols([]);
    setRefColsManual('');
    if (!/^[a-zA-Z_][\w$]*(\.[a-zA-Z_][\w$]*)*$/.test(t)) return;
    const bare = t.includes('.') ? t.split('.').pop()! : t;
    let alive = true;
    setRefColsLoading(true);
    api.listColumns(connId, schema || '', bare, pgDb)
      .then((list) => {
        if (!alive) return;
        setRefColOptions((list ?? []).map((c) => c.name).filter(Boolean));
        setRefColsLoading(false);
      })
      .catch(() => { if (alive) setRefColsLoading(false); });
    return () => { alive = false; };
  }, [refTable, connId, schema, pgDb]);
  const effectiveRefCols = refColOptions ? refCols : refColsManual.split(',').map((s) => s.trim()).filter(Boolean);
  const canSubmit = cols.length > 0 && refTableOk && effectiveRefCols.length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onCancel}>
      <div className="w-[440px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">新增外键</div>
        <div className="grid grid-cols-[76px_1fr] items-center gap-x-2 gap-y-2 text-[length:calc(var(--pref-fs)*0.786)] text-dim">
          <span>约束名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`留空自动生成 fk_${tableName}_…`}
            className={ddlInputCls}
          />
          <span>本表列</span>
          <div className="max-h-28 overflow-auto rounded border border-line bg-bg p-1.5">
            {columns.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
                <input type="checkbox" checked={cols.includes(c)} onChange={() => toggleCol(c)} />
                {c}
              </label>
            ))}
            {columns.length === 0 && <span className="text-dim2">（无列元数据，请先打开「列」子页加载结构）</span>}
          </div>
          <span>引用表</span>
          <div>
            <input
              value={refTable}
              onChange={(e) => setRefTable(e.target.value)}
              list="dataroost-fk-ref-tables"
              placeholder={isPg ? '如 users 或 schema.users' : '如 users 或 db.users'}
              className={ddlInputCls}
            />
            <datalist id="dataroost-fk-ref-tables">
              {tables.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <span>引用列</span>
          <div className="min-h-[28px] rounded border border-line bg-bg p-1.5">
            {refColsLoading ? (
              <span className="text-dim2">加载引用表列…</span>
            ) : refColOptions ? (
              <div className="max-h-28 overflow-auto">
                {refColOptions.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
                    <input type="checkbox" checked={refCols.includes(c)} onChange={() => toggleRefCol(c)} />
                    {c}
                  </label>
                ))}
                {refColOptions.length === 0 && <span className="text-dim2">（引用表无列元数据）</span>}
              </div>
            ) : (
              <input
                value={refColsManual}
                onChange={(e) => setRefColsManual(e.target.value)}
                placeholder="手输引用列，逗号分隔，如 id"
                className="h-6 w-full border-0 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2"
              />
            )}
          </div>
          <span>删除规则</span>
          <select value={onDelete} onChange={(e) => setOnDelete(e.target.value)} className={`${ddlInputCls} h-7`}>
            {rules.map((r) => (
              <option key={r} value={r}>{r || '无（跟随默认）'}</option>
            ))}
          </select>
          <span>更新规则</span>
          <select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)} className={`${ddlInputCls} h-7`}>
            {rules.map((r) => (
              <option key={r} value={r}>{r || '无（跟随默认）'}</option>
            ))}
          </select>
        </div>
        <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
          将执行：ALTER TABLE … ADD CONSTRAINT <span className="font-mono">{autoName()}</span> FOREIGN KEY ({cols.join(', ')}) REFERENCES {refTable.trim() || '…'} ({effectiveRefCols.join(', ')})
          {onDelete && ` ON DELETE ${onDelete}`}{onUpdate && ` ON UPDATE ${onUpdate}`}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="h-7 rounded border border-line px-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim hover:bg-panel3">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit(autoName(), cols, refTable.trim(), effectiveRefCols, onDelete, onUpdate)}
            className="h-7 rounded bg-accent px-3 text-[length:calc(var(--pref-fs)*0.786)] text-white hover:opacity-90 disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** SQL 查询标签页（CodeMirror 编辑器 + 分页结果集：默认 200 行，滚动到底自动追加下一页） */
const QUERY_PAGE_SIZE = 200;

/** SQL 查询标签页（CodeMirror 编辑器 + 分页结果网格 + 顶部连接信息栏） */
function QueryTab({ connId, tabId, initialSql, initialDb }: { connId: string; tabId: string; initialSql?: string; /** 初始库/模式（树中选中节点新建查询时携带）：MySQL=库 / PG=库 / Oracle=模式 */ initialDb?: string }) {
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<QueryColumn[] | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isDml, setIsDml] = useState(false);
  /** 脚本运行结果（多语句逐条日志；单条语句仍走普通 run 的网格展示） */
  const [scriptResult, setScriptResult] = useState<ScriptResult | null>(null);
  /** @ai 命令：提问内容与流式回答 */
  const [aiAsked, setAiAsked] = useState<string | null>(null);
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiStreaming, setAiStreaming] = useState(false);
  const lastSqlRef = useRef('');
  const offsetRef = useRef(0);
  const busyRef = useRef(false);
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
      setError((e as Error).message);
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
      const tables = schema ? Object.keys(schema).slice(0, limit).join('、') : '';
      await api.aiAsk(
        [{ id: `u-${Date.now().toString(36)}`, role: 'user', content: instruction, ts: Date.now() }],
        tables ? [`当前库包含的表：${tables}`] : undefined,
        undefined,
        conn ? { id: connId, label: `${conn.name}（${conn.host}）`, kind: conn.kind } : undefined,
      );
    } catch (e) {
      offChunk();
      offDone();
      setAiStreaming(false);
      busyRef.current = false;
      setLoading(false);
      setAiAnswer((prev) => prev || `错误：${(e as Error).message}`);
    }
  };

  /** 执行指定 SQL 文本（运行 / 运行选中 共用链路：@ai / 安全检查 / 超时取消 / 结果网格 / 历史） */
  const runText = async (text: string) => {
    if (busyRef.current) return;
    // @ai 命令：交给 AI 生成 / 解答（Ctrl+Enter 同样触发）
    const m = /^@ai\b[\s:：]*(.*)$/is.exec(text);
    if (m && m[1].trim()) {
      await runAi(m[1].trim());
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
    offsetRef.current = 0;
    try {
      const prefs = usePrefs.getState().prefs;
      const r = await withTimeout(
        api.runSqlPaged(connId, text, 0, QUERY_PAGE_SIZE, conn?.kind === 'oracle' ? undefined : activeDbRef.current),
        prefs.queryTimeoutSec,
        () => { void api.cancelQuery(connId, conn?.kind === 'oracle' ? undefined : activeDbRef.current).catch(() => {}); },
      );
      // 结果集行数上限：超出截断并停止继续分页加载
      const max = prefs.maxResultRows;
      const rows = max > 0 && r.result.rows.length > max ? r.result.rows.slice(0, max) : r.result.rows;
      setColumns(r.result.columns);
      setRows(rows);
      setTotal(r.total);
      setHasMore(max > 0 && r.total !== null && r.total > rows.length + offsetRef.current ? false : r.hasMore);
      setElapsedMs(r.result.elapsedMs);
      setIsDml(r.result.affectedRows !== undefined);
      pushHistory(text);
    } catch (e) {
      setError((e as Error).message);
      setColumns(null);
      setRows([]);
      setTotal(null);
      setHasMore(false);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  };

  /** 运行（工具栏 / Ctrl+Enter）：编辑器有选中时只跑选中，否则全文 */
  const run = async () => {
    if (busyRef.current) return;
    const text = pickRunText();
    if (text) await runText(text);
  };

  /** 运行选中的 SQL（编辑器右键菜单）：只执行当前选中文本，无选中不动作 */
  const runSelection = async () => {
    const sel = (selectionRef.current?.() ?? '').trim();
    if (sel) await runText(sel);
  };

  /** 脚本运行：编辑器全文按语句切分（识别字符串/注释/$$ 引用）逐条顺序执行，遇错停止；结果区显示逐条日志 */
  const runScriptAll = async () => {
    if (busyRef.current) return;
    const text = (sqlRef.current || '').trim();
    if (!text) return;
    const m = /^@ai\b[\s:：]*(.*)$/is.exec(text);
    if (m && m[1].trim()) {
      await runAi(m[1].trim());
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
      pushHistory(text.replace(/\s+/g, ' ').slice(0, 200));
    } catch (e) {
      setError((e as Error).message);
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
      setError(`导入失败：${(e as Error).message}`);
    }
  };

  /** 滚动到底部：追加下一页 */
  const loadMore = async () => {
    if (busyRef.current || loadingMore || !hasMore || !lastSqlRef.current) return;
    busyRef.current = true;
    setLoadingMore(true);
    try {
      const nextOffset = offsetRef.current + QUERY_PAGE_SIZE;
      const r = await api.runSqlPaged(connId, lastSqlRef.current, nextOffset, QUERY_PAGE_SIZE, conn?.kind === 'oracle' ? undefined : activeDbRef.current);
      offsetRef.current = nextOffset;
      setRows((prev) => [...prev, ...r.result.rows]);
      setHasMore(r.hasMore);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busyRef.current = false;
      setLoadingMore(false);
    }
  };

  const onGridScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) void loadMore();
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 连接信息栏：明确当前查询连的是哪个实例 / 库 */}
      {conn && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-3 text-[length:calc(var(--pref-fs)*0.786)]">
          <ConnIcon kind={conn.kind} />
          <span className="font-medium text-fg">{conn.name}</span>
          <span className="rounded bg-panel3 px-1.5 py-px text-[9px] text-dim2">{connKindLabel}</span>
          <span className="text-dim2">{conn.host}:{conn.port}</span>
          {conn.username && <span className="text-dim2">· {conn.username}</span>}
          {/* 库切换紧跟连接信息（不再 ml-auto 推到最右），切库时鼠标不用横穿整个窗口 */}
          {dbOptions.length > 0 && (
            <span className="ml-1 flex items-center gap-1 border-l border-line pl-2">
              <span className="text-dim2">库</span>
              <select
                value={currentDb ?? ''}
                onChange={(e) => void switchDb(e.target.value)}
                className="rounded border border-line bg-bg px-1.5 py-px text-[length:calc(var(--pref-fs)*0.714)] text-fg outline-none hover:border-accent"
                title="切换当前库（PG 跨库直查，MySQL/Oracle 会话级切换）"
              >
                {dbOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>
      )}
      <div
        className="shrink-0 overflow-hidden border-b border-line"
        style={{ height: editorH }}
        onContextMenu={(e) => { e.preventDefault(); setSqlMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <SqlEditor initialValue={initSql} schema={schema} dialect={conn?.kind === 'postgres' ? 'postgres' : conn?.kind === 'mysql' ? 'mysql' : undefined} onRun={run} onRunScript={runScriptAll} onSave={() => setSaveDlg(true)} injectRef={injectRef} selectionRef={selectionRef} onChange={(v) => { sqlRef.current = v; persistSql(v); }} />
      </div>
      {/* 编辑器右键菜单：运行（有选中只跑选中）/ 运行选中（无选中置灰）/ 脚本运行 / 格式化 / 导入 SQL */}
      {sqlMenu && (
        <ContextMenu
          x={sqlMenu.x}
          y={sqlMenu.y}
          onClose={() => setSqlMenu(null)}
          items={[
            { label: '运行', onClick: () => void run(), disabled: loading },
            { label: '运行选中', onClick: () => void runSelection(), disabled: loading || !(selectionRef.current?.() ?? '').trim() },
            { label: '脚本运行', onClick: () => void runScriptAll(), disabled: loading },
            { separator: true, label: '' },
            { label: '格式化', onClick: formatSql },
            { separator: true, label: '' },
            { label: '导入 SQL', onClick: () => void importSqlFile(), disabled: loading },
          ]}
        />
      )}
      {/* 可拖拽分隔条：上下拖动调整编辑器高度 */}
      <div
        onMouseDown={onSplitMouseDown}
        className="group h-1 shrink-0 cursor-row-resize bg-line transition-colors hover:bg-accent"
        title="拖动调整编辑器高度"
      />
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3 text-[length:calc(var(--pref-fs)*0.786)]">
        <button onClick={run} disabled={loading} className="rounded bg-accent px-2.5 py-0.5 font-medium text-white hover:bg-accent2 disabled:opacity-50" title="Ctrl/⌘+Enter：有选中时只执行选中文本，否则执行编辑器全文；@ai 开头交给 AI">
          {loading ? '执行中…' : '运行'}
        </button>
        {history.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const s = e.target.value;
              if (s) setEditorSql(s);
              e.target.value = '';
            }}
            className="max-w-[240px] rounded border border-line bg-bg px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim outline-none hover:border-accent"
            title="本连接最近执行过的 SQL（点击回填编辑器）"
          >
            <option value="">历史 ({history.length})</option>
            {history.map((s, i) => (
              <option key={i} value={s}>
                {s.replace(/\s+/g, ' ').slice(0, 80)}
              </option>
            ))}
          </select>
        )}
        {columns && !isDml && total !== null && (
          <span className="text-dim2">
            · 共 <span className="font-medium text-fg">{total.toLocaleString()}</span> 行 · 已显示 {rows.length.toLocaleString()} 行
            {hasMore && <span className="ml-1 text-dim">（滚动到底自动加载）</span>}
          </span>
        )}
        {columns && !isDml && total === null && <span className="text-dim2">· {rows.length.toLocaleString()} 行</span>}
        {isDml && <span className="text-dim2">· 写操作执行成功 · {elapsedMs}ms</span>}
        {columns && !isDml && elapsedMs > 0 && <span className="text-dim2">· {elapsedMs}ms</span>}
        {loadingMore && <span className="text-dim">· 加载中…</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" onScroll={onGridScroll}>
        {aiAsked !== null ? (
          /* @ai 回答面板：流式输出，完成后可一键提取 SQL 回填编辑器 */
          <div className="p-3">
            <div className="mb-2 flex items-center gap-2 text-[length:calc(var(--pref-fs)*0.786)]">
              <span className="rounded bg-ai/20 px-1.5 py-px text-[10px] text-ai">AI</span>
              <span className="min-w-0 flex-1 truncate text-dim2" title={aiAsked}>{aiAsked}</span>
              {!aiStreaming && aiAnswer && (
                <>
                  <button
                    onClick={() => setEditorSql(extractSql(aiAnswer))}
                    className="rounded border border-line px-2 py-0.5 text-dim hover:border-accent hover:text-fg"
                    title="提取回答中的 SQL（代码块优先）替换编辑器内容"
                  >
                    填入编辑器
                  </button>
                  <button
                    onClick={() => { setAiAsked(null); setAiAnswer(''); }}
                    className="rounded border border-line px-2 py-0.5 text-dim hover:border-accent hover:text-fg"
                  >
                    关闭
                  </button>
                </>
              )}
            </div>
            <pre className="whitespace-pre-wrap break-words rounded border border-line bg-panel p-2 font-mono text-[length:calc(var(--pref-fs)*0.786)] text-fg">
              {aiAnswer || (aiStreaming ? '思考中…' : '')}
            </pre>
          </div>
        ) : scriptResult ? (
          /* 脚本运行日志：逐条状态 + 行数 + SELECT 前 5 行样例 */
          <div>
            <div className="flex h-7 items-center gap-2 border-b border-line px-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
              <span>脚本执行完成 · {scriptResult.statements.length} 条语句 · {scriptResult.totalMs}ms</span>
              {scriptResult.stoppedAt !== undefined && <span className="text-red-400">· 在第 {scriptResult.stoppedAt} 条语句处停止</span>}
              <span className="ml-auto">（点击「运行」可切回网格视图）</span>
            </div>
            {scriptResult.statements.map((s) => (
              <div key={s.index} className="border-b border-line px-3 py-1.5 text-[length:calc(var(--pref-fs)*0.786)]">
                <div className="flex items-center gap-2">
                  <span className={s.ok ? 'text-green-500' : 'text-red-400'}>{s.ok ? '✓' : '✕'}</span>
                  <span className="w-8 shrink-0 text-dim2">#{s.index}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-fg" title={s.sql}>{s.sql.replace(/\s+/g, ' ').slice(0, 160)}</span>
                  {s.affectedRows !== undefined && <span className="shrink-0 text-dim2">影响 {s.affectedRows} 行</span>}
                  {s.rowCount !== undefined && <span className="shrink-0 text-dim2">{s.rowCount.toLocaleString()} 行</span>}
                  <span className="shrink-0 text-dim2">{s.elapsedMs}ms</span>
                </div>
                {s.error && <div className="ml-10 mt-1 text-red-400">{s.error}</div>}
                {s.sample && s.sample.rows.length > 0 && (
                  <div className="ml-10 mt-1 max-h-32 overflow-auto rounded border border-line">
                    <table className="w-full border-collapse text-left font-mono text-[length:calc(var(--pref-fs)*0.714)]">
                      <thead>
                        <tr>
                          {s.sample.columns.map((c) => (
                            <th key={c.name} className="border-b border-line bg-panel px-2 py-0.5 font-medium text-dim">{c.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {s.sample.rows.map((r, ri) => (
                          <tr key={ri} className="border-b border-line/50">
                            {s.sample!.columns.map((c) => (
                              <td key={c.name} className="max-w-[240px] truncate px-2 py-0.5 text-fg">{r[c.name] === null || r[c.name] === undefined ? 'NULL' : String(r[c.name])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : error ? (
          <ErrorBox message={error} onRetry={run} />
        ) : columns ? (
          <PagedGrid columns={columns} rows={rows} />
        ) : (
          <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">执行 SQL 查看结果（Ctrl/⌘+Enter 运行 · 有选中只跑选中 · Ctrl/⌘+Shift+Enter 脚本运行 · 输入 @ai 提问让 AI 生成或查询）</div>
        )}
      </div>
      {/* Ctrl+S 保存脚本弹框 */}
      {saveDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={() => setSaveDlg(false)}>
          <div className="w-72 rounded border border-line bg-panel2 p-3 shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-2 text-[length:calc(var(--pref-fs)*0.857)] font-medium text-fg">保存脚本</div>
            <input
              autoFocus
              value={scriptName}
              onChange={(e) => setScriptName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSaveScript();
                if (e.key === 'Escape') setSaveDlg(false);
              }}
              placeholder="输入脚本名称"
              className="w-full rounded border border-line bg-bg px-2 py-1 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none focus:border-accent"
            />
            <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">同名脚本将覆盖内容 · 保存到左侧连接树「脚本」节点</div>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setSaveDlg(false)} className="rounded border border-line px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-dim hover:bg-panel3">
                取消
              </button>
              <button
                onClick={submitSaveScript}
                disabled={!scriptName.trim()}
                className="rounded bg-accent px-2.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] font-medium text-white hover:bg-accent2 disabled:opacity-50"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 分页结果网格（只读；行号连续累加） */
function PagedGrid({ columns, rows }: { columns: QueryColumn[]; rows: Record<string, unknown>[] }) {
  return (
    <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
      <thead className="sticky top-0 z-10 bg-panel2">
        <tr>
          <th className="w-10 border-b border-r border-line px-1 py-1 text-right text-dim2">#</th>
          {columns.map((c) => (
            <th key={c.name} className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-left font-medium text-fg">
              {c.dataType && <span className="mr-1 text-[9px] text-dim2">{c.dataType}</span>}
              {c.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="hover:bg-panel3">
            <td className="border-b border-r border-line px-1 py-1 text-right text-dim2">{i + 1}</td>
            {columns.map((c) => (
              <td key={c.name} className="max-w-[280px] truncate border-b border-r border-line px-2 py-1 text-fg" title={fmt(row[c.name], c.dataType)}>
                {fmt(row[c.name], c.dataType)}
              </td>
            ))}
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-dim2">
              无数据
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** 通用结果集网格（只读，用于 SQL 查询） */
function ResultGrid({ result }: { result: QueryResult }) {
  return (
    <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
      <thead className="sticky top-0 z-10 bg-panel2">
        <tr>
          <th className="w-10 border-b border-r border-line px-1 py-1 text-right text-dim2">#</th>
          {result.columns.map((c) => (
            <th key={c.name} className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-left font-medium text-fg">
              {c.primaryKey && <span className="mr-1">🔑</span>}
              {c.name}
              {c.dataType && <span className="ml-1 text-[9px] text-dim2">{c.dataType}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, i) => (
          <tr key={i} className="hover:bg-panel3">
            <td className="border-b border-r border-line px-1 py-1 text-right text-dim2">{i + 1}</td>
            {result.columns.map((c) => (
              <td key={c.name} className="max-w-[280px] truncate border-b border-r border-line px-2 py-1 text-fg" title={fmt(row[c.name], c.dataType)}>
                {fmt(row[c.name], c.dataType)}
              </td>
            ))}
          </tr>
        ))}
        {result.rows.length === 0 && (
          <tr>
            <td colSpan={result.columns.length + 1} className="px-3 py-6 text-center text-dim2">
              无数据
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** 视图/函数 定义标签页（视图浏览器：查看定义 + 保存重建 + 预览数据；函数浏览器：查看源 + 保存） */
function DefTab({ connId, kind, pgDb, schema, name }: { connId: string; kind: 'view' | 'mview' | 'function' | 'procedure'; pgDb?: string; schema: string; name: string }) {
  const [, setDef] = useState<DbObjectDef | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const isView = kind === 'view' || kind === 'mview';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = isView
        ? await api.getViewDefinition(connId, kind, schema, name, pgDb)
        : await api.getFunctionDefinition(connId, schema, name, pgDb);
      setDef(d);
      setText(d.ddl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, kind, schema, name, pgDb]);

  /** 保存：直接执行 DDL（CREATE OR REPLACE / CREATE FUNCTION）重建对象 */
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.runSql(connId, text, pgDb || undefined);
      setMsg('已保存（执行 DDL 成功）');
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  /** 预览数据（仅视图/物化视图）：SELECT * FROM schema.name LIMIT 200 */
  const previewData = async () => {
    setPreviewErr(null);
    try {
      const q = (n: string) => (connId ? n : n);
      const from = schema ? `${q(schema)}.${q(name)}` : q(name);
      setPreview(await api.runSql(connId, `SELECT * FROM ${from} LIMIT 200`, pgDb || undefined));
    } catch (e) {
      setPreviewErr((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">
          {kind === 'function' ? '函数' : kind === 'procedure' ? '存储过程' : kind === 'mview' ? '物化视图' : '视图'} · {schema}.{name}
        </span>
        <button onClick={() => void save()} disabled={saving} className="rounded bg-accent px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-white hover:opacity-90 disabled:opacity-40">
          {saving ? '保存中…' : '保存到数据库'}
        </button>
        <button onClick={() => void api.clipboardWrite(text).catch(() => undefined)} className="rounded border border-line px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3">
          复制
        </button>
        {isView && (
          <button onClick={() => void previewData()} className="rounded border border-line px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3">
            预览数据
          </button>
        )}
        <button onClick={() => void load()} className="ml-auto rounded border border-line px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3">
          刷新
        </button>
      </div>
      {msg && <div className={`shrink-0 px-2 py-1 text-[length:calc(var(--pref-fs)*0.714)] ${msg.startsWith('保存失败') ? 'text-prod' : 'text-ok'}`}>{msg}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : loading ? (
          <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载定义…</div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-bg p-3 font-mono text-[length:calc(var(--pref-fs)*0.786)] leading-5 text-fg outline-none"
          />
        )}
      </div>
      {isView && (preview || previewErr) && (
        <div className="h-[40%] min-h-[120px] shrink-0 overflow-auto border-t border-line">
          {previewErr ? (
            <div className="p-2 text-[length:calc(var(--pref-fs)*0.714)] text-prod">预览失败：{previewErr}</div>
          ) : preview ? (
            <ResultGrid result={preview} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 序列标签页（序列浏览器：当前值/上下限/步长 + 下一个值） */
function SequenceTab({ connId, pgDb, schema, name }: { connId: string; pgDb?: string; schema: string; name: string }) {
  const [info, setInfo] = useState<DbSequenceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const isPg = conn?.kind === 'postgres';

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setInfo(await api.getSequenceInfo(connId, schema, name, pgDb));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, schema, name, pgDb]);

  /** 下一个值（PG：nextval；Oracle：.NEXTVAL） */
  const nextval = async () => {
    setMsg(null);
    try {
      const seq = schema ? `${schema}.${name}` : name;
      const sql = isPg ? `SELECT nextval('${seq.replace(/'/g, "''")}') AS v` : `SELECT ${seq}.NEXTVAL AS v FROM dual`;
      const r = await api.runSql(connId, sql, pgDb || undefined);
      const v = r.rows[0]?.v;
      setMsg(`下一个值：${v}`);
      await load();
    } catch (e) {
      setMsg(`获取失败：${(e as Error).message}`);
    }
  };

  const rows: [string, string][] = info
    ? [
        ['序列名', info.name],
        ['当前值', info.currentValue == null ? '（尚未调用）' : String(info.currentValue)],
        ['最小值', info.minValue == null ? '—' : String(info.minValue)],
        ['最大值', info.maxValue == null ? '—' : String(info.maxValue)],
        ['步长', info.increment == null ? '—' : String(info.increment)],
        ['循环', info.cycle ? '是' : '否'],
      ]
    : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">序列 · {schema}.{name}</span>
        <button onClick={() => void nextval()} className="rounded bg-accent px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-white hover:opacity-90">
          下一个值
        </button>
        <button onClick={() => void load()} className="ml-auto rounded border border-line px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3">
          刷新
        </button>
      </div>
      {msg && <div className={`shrink-0 px-2 py-1 text-[length:calc(var(--pref-fs)*0.714)] ${msg.startsWith('获取失败') ? 'text-prod' : 'text-ok'}`}>{msg}</div>}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : loading ? (
          <div className="text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载序列信息…</div>
        ) : (
          <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} className="border-b border-line">
                  <td className="w-24 py-1 text-dim2">{k}</td>
                  <td className="py-1 font-mono text-fg">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** 布尔标记格（✓ / — / ?） */
function Flag({ v }: { v?: boolean }) {
  return v ? <span className="text-ok">✓</span> : v === false ? <span className="text-dim2">—</span> : <span className="text-dim2">?</span>;
}

/** 用户与权限管理标签页（PG 角色 / MySQL 用户 / Oracle 用户：列表 + 权限查看 + 新建/删除） */
function UsersTab({ connId }: { connId: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const dialect = conn?.kind ?? 'postgres';
  const isMysql = dialect === 'mysql';
  const isOra = dialect === 'oracle';
  const [users, setUsers] = useState<DbUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DbUser | null>(null);
  const [privs, setPrivs] = useState<DbUserPrivilege[]>([]);
  const [privLoading, setPrivLoading] = useState(false);
  const [privError, setPrivError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await api.listUsers(connId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const viewPrivs = async (u: DbUser) => {
    setSelected(u);
    setPrivLoading(true);
    setPrivError(null);
    try {
      setPrivs(await api.getUserPrivileges(connId, u.name, u.host));
    } catch (e) {
      setPrivError((e as Error).message);
      setPrivs([]);
    } finally {
      setPrivLoading(false);
    }
  };

  const del = async (u: DbUser) => {
    const label = u.host ? `'${u.name}'@'${u.host}'` : u.name;
    if (!window.confirm(`确认删除用户 ${label}？该操作不可撤销${isOra ? '（DROP USER ... CASCADE 会一并清理其对象）' : ''}。`)) return;
    try {
      await api.dropUser(connId, u.name, u.host);
      await load();
      if (selected?.name === u.name) setSelected(null);
    } catch (e) {
      window.alert(`删除失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">用户与权限管理</span>
        <span className="rounded bg-panel3 px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{isOra ? 'Oracle' : isMysql ? 'MySQL' : 'PostgreSQL'}</span>
        <button onClick={() => setShowCreate(true)} className="rounded bg-accent px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-white hover:opacity-90">
          新建用户
        </button>
        <button onClick={() => void load()} className="ml-auto rounded border border-line px-2 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3">
          刷新
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 用户列表 */}
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <ErrorBox message={error} onRetry={() => void load()} />
          ) : loading ? (
            <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载用户…</div>
          ) : users.length === 0 ? (
            <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">（无用户）</div>
          ) : (
            <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
              <thead className="sticky top-0 bg-panel2 text-dim2">
                <tr>
                  <th className="px-2 py-1 text-left font-normal">用户名</th>
                  {isMysql && <th className="px-2 py-1 text-left font-normal">主机</th>}
                  <th className="px-2 py-1 text-left font-normal">可登录</th>
                  <th className="px-2 py-1 text-left font-normal">超级用户</th>
                  <th className="px-2 py-1 text-left font-normal">锁定</th>
                  <th className="px-2 py-1 text-left font-normal">口令过期</th>
                  <th className="px-2 py-1 text-left font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={`${u.name}@${u.host ?? ''}`} className={`border-b border-line ${selected?.name === u.name && selected?.host === u.host ? 'bg-panel3' : ''}`}>
                    <td className="px-2 py-1 font-mono text-fg">{u.name}</td>
                    {isMysql && <td className="px-2 py-1 text-dim">{u.host}</td>}
                    <td className="px-2 py-1"><Flag v={u.canLogin} /></td>
                    <td className="px-2 py-1"><Flag v={u.superuser} /></td>
                    <td className="px-2 py-1"><Flag v={u.locked} /></td>
                    <td className="px-2 py-1"><Flag v={u.expired} /></td>
                    <td className="px-2 py-1">
                      <button onClick={() => void viewPrivs(u)} className="rounded border border-line px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3">权限</button>
                      <button onClick={() => void del(u)} className="ml-1 rounded border border-line px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-prod hover:bg-panel3">删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {/* 权限面板（编辑 + 查看明细） */}
        {selected && (
          <div className="flex w-[46%] min-w-[300px] shrink-0 flex-col border-l border-line">
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-2">
              <span className="truncate text-[length:calc(var(--pref-fs)*0.714)] text-dim2">权限 · {selected.host ? `${selected.name}@${selected.host}` : selected.name}</span>
              <button onClick={() => void viewPrivs(selected)} className="ml-auto rounded border border-line px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3">
                刷新
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {privError ? (
                <div className="text-[length:calc(var(--pref-fs)*0.714)] text-prod">{privError}</div>
              ) : privLoading ? (
                <div className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">加载权限…</div>
              ) : (
                <>
                  <PrivEditor connId={connId} kind={dialect} user={selected} privs={privs} users={users} onApplied={() => { void viewPrivs(selected); void load(); }} />
                  <div className="mb-1 mt-3 text-[length:calc(var(--pref-fs)*0.714)] font-medium text-dim2">当前授权明细</div>
                  {privs.length === 0 ? (
                    <div className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">（无显式授权）</div>
                  ) : (
                    <ul className="space-y-1">
                      {privs.map((p, i) => (
                        <li key={i} className="rounded border border-line bg-panel2 px-2 py-1 text-[length:calc(var(--pref-fs)*0.714)]">
                          <div className="font-mono text-fg">{p.privilege}</div>
                          <div className="text-dim2">{p.target}{p.grantable ? ' · 可转授' : ''}</div>
                          {p.raw && <div className="mt-0.5 break-all text-dim">{p.raw}</div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {showCreate && conn && (
        <CreateUserDialog connId={connId} kind={dialect} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />
      )}
    </div>
  );
}

/** MySQL 常用全局权限清单（权限编辑勾选） */
const MYSQL_GLOBAL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT', 'TRIGGER'];
/** Oracle 常用系统权限（权限编辑勾选） */
const ORA_SYS_PRIVS = ['CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE', 'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE USER', 'ALTER USER', 'DROP USER', 'UNLIMITED TABLESPACE'];
/** Oracle 常用预定义角色 */
const ORA_ROLES = ['CONNECT', 'RESOURCE', 'DBA'];

/**
 * 权限编辑器（随权限面板展示，点「应用」差量提交）：
 * - PG：角色属性开关（ALTER ROLE）+ 成员角色增删（GRANT/REVOKE role）；
 * - MySQL：全局权限（ON *.*）勾选差量 + WITH GRANT OPTION；
 * - Oracle：系统权限/预定义角色勾选差量（GRANT/REVOKE ... TO/FROM user）。
 */
function PrivEditor({ connId, kind, user, privs, users, onApplied }: {
  connId: string;
  kind: string;
  user: DbUser;
  privs: DbUserPrivilege[];
  users: DbUser[];
  onApplied: () => void;
}) {
  const isPg = kind === 'postgres';
  const isMysql = kind === 'mysql';
  const isOra = kind === 'oracle';

  // —— PG 编辑状态（pgAttrs0 为进入时快照，用于差量） ——
  const [pgAttrs, setPgAttrs] = useState<Record<string, boolean>>({});
  const pgAttrs0 = useRef<Record<string, boolean>>({});
  const [pgMembers, setPgMembers] = useState<string[]>([]);
  const [pgGrant, setPgGrant] = useState<string[]>([]);
  const [pgRevoke, setPgRevoke] = useState<string[]>([]);
  const [pgRoleSel, setPgRoleSel] = useState('');
  // —— MySQL / Oracle 勾选状态 ——
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const checks0 = useRef<Record<string, boolean>>({});
  const [grantOption, setGrantOption] = useState(false);
  const grantOption0 = useRef(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 选中用户 / 权限刷新后，从当前授权初始化编辑状态
  useEffect(() => {
    setMsg(null);
    setPgGrant([]);
    setPgRevoke([]);
    setPgRoleSel('');
    if (isPg) {
      const a: Record<string, boolean> = { login: false, superuser: false, createDb: false, createRole: false, replication: false, inherit: true };
      const members: string[] = [];
      for (const p of privs) {
        if (p.target === 'ROLE') {
          members.push(p.privilege);
          continue;
        }
        switch (p.privilege) {
          case 'LOGIN': a.login = true; break;
          case 'SUPERUSER': a.superuser = true; break;
          case 'CREATEDB': a.createDb = true; break;
          case 'CREATEROLE': a.createRole = true; break;
          case 'REPLICATION': a.replication = true; break;
          case 'NOINHERIT': a.inherit = false; break;
        }
      }
      setPgAttrs(a);
      pgAttrs0.current = { ...a };
      setPgMembers(members);
      return;
    }
    const list = isMysql ? MYSQL_GLOBAL_PRIVS : [...ORA_SYS_PRIVS, ...ORA_ROLES];
    const s: Record<string, boolean> = {};
    for (const p of list) s[p] = false;
    let go = false;
    for (const p of privs) {
      if (isMysql) {
        if (/WITH GRANT OPTION/i.test(p.raw ?? '')) go = true;
        // 仅解析全局授权（ON *.*）：GRANT priv[, priv] ON *.* TO ...
        if (/ON\s+\*\.\*/i.test(p.raw ?? '')) {
          const m = (p.raw ?? '').match(/^GRANT\s+(.+?)\s+ON\s/i);
          if (m) {
            for (const part of m[1].split(',')) {
              const name = part.trim().toUpperCase();
              if (!name || name === 'USAGE') continue;
              if (name === 'ALL PRIVILEGES' || name === 'ALL') for (const k of list) s[k] = true;
              else if (name in s) s[name] = true;
            }
          }
        }
      } else if (p.privilege in s) {
        s[p.privilege] = true;
      }
    }
    setChecks(s);
    checks0.current = { ...s };
    setGrantOption(go);
    grantOption0.current = go;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.name, user.host, privs]);

  const apply = async () => {
    const edit: DbUserPrivEdit = {};
    if (isPg) {
      const attrs: NonNullable<DbUserPrivEdit['attrs']> = {};
      for (const k of Object.keys(pgAttrs)) {
        if (pgAttrs[k] !== pgAttrs0.current[k]) (attrs as Record<string, boolean>)[k] = pgAttrs[k];
      }
      if (Object.keys(attrs).length) edit.attrs = attrs;
      if (pgGrant.length) edit.grantRoles = pgGrant;
      if (pgRevoke.length) edit.revokeRoles = pgRevoke;
      if (!edit.attrs && !edit.grantRoles && !edit.revokeRoles) {
        setMsg({ ok: false, text: '没有修改' });
        return;
      }
    } else {
      const grant: string[] = [];
      const revoke: string[] = [];
      for (const k of Object.keys(checks)) {
        if (checks[k] && !checks0.current[k]) grant.push(k);
        if (!checks[k] && checks0.current[k]) revoke.push(k);
      }
      if (isMysql) {
        if (grantOption0.current && !grantOption) revoke.push('GRANT OPTION');
        if (grant.length) edit.grantPrivs = grant;
        if (revoke.length) edit.revokePrivs = revoke;
        if (grant.length && grantOption && !grantOption0.current) edit.grantOption = true;
      } else {
        if (grant.length) edit.grantPrivs = grant;
        if (revoke.length) edit.revokePrivs = revoke;
      }
      if (!edit.grantPrivs && !edit.revokePrivs) {
        setMsg({ ok: false, text: '没有修改' });
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.updateUserPrivileges(connId, user.name, user.host, edit);
      setMsg({ ok: true, text: '权限已更新' });
      onApplied();
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const removeMember = (r: string) => {
    setPgMembers((s) => s.filter((x) => x !== r));
    if (pgGrant.includes(r)) setPgGrant((s) => s.filter((x) => x !== r));
    else setPgRevoke((s) => (s.includes(r) ? s : [...s, r]));
  };

  const cb = 'h-3 w-3 accent-[#0e639c]';
  const lab = 'flex items-center gap-1 text-[length:calc(var(--pref-fs)*0.714)] text-fg';
  return (
    <div className="rounded border border-line bg-panel2 p-2">
      <div className="mb-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium text-dim2">权限编辑（调整后点「应用」生效）</div>
      {isPg && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {([
              ['login', '可登录 LOGIN'],
              ['superuser', '超级用户 SUPERUSER'],
              ['createDb', '建库 CREATEDB'],
              ['createRole', '建角色 CREATEROLE'],
              ['replication', '流复制 REPLICATION'],
              ['inherit', '继承 INHERIT'],
            ] as const).map(([k, label]) => (
              <label key={k} className={lab}>
                <input type="checkbox" className={cb} checked={!!pgAttrs[k]} onChange={(e) => setPgAttrs((s) => ({ ...s, [k]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>
          <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">角色成员（× 移除）</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {pgMembers.length === 0 && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">（无）</span>}
            {pgMembers.map((r) => (
              <span key={r} className="flex items-center gap-1 rounded bg-panel3 px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-fg">
                {r}
                <button title="移除该角色" className="text-prod hover:opacity-80" onClick={() => removeMember(r)}>×</button>
              </span>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <select value={pgRoleSel} onChange={(e) => setPgRoleSel(e.target.value)} className="h-5 rounded-sm border border-line bg-bg px-1 text-[length:calc(var(--pref-fs)*0.714)] text-fg outline-none focus:border-accent">
              <option value="">选择要授予的角色…</option>
              {users.filter((u) => u.name !== user.name && !pgMembers.includes(u.name)).map((u) => (
                <option key={u.name} value={u.name}>{u.name}</option>
              ))}
            </select>
            <button
              disabled={!pgRoleSel}
              onClick={() => {
                if (!pgRoleSel) return;
                setPgMembers((s) => (s.includes(pgRoleSel) ? s : [...s, pgRoleSel]));
                setPgGrant((s) => (s.includes(pgRoleSel) ? s : [...s, pgRoleSel]));
                setPgRevoke((s) => s.filter((x) => x !== pgRoleSel));
                setPgRoleSel('');
              }}
              className="rounded border border-line px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel3 disabled:opacity-40"
            >授予</button>
          </div>
        </>
      )}
      {isMysql && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {MYSQL_GLOBAL_PRIVS.map((p) => (
              <label key={p} className={lab}>
                <input type="checkbox" className={cb} checked={!!checks[p]} onChange={(e) => setChecks((s) => ({ ...s, [p]: e.target.checked }))} />
                {p}
              </label>
            ))}
          </div>
          <label className={`${lab} mt-2`}>
            <input type="checkbox" className={cb} checked={grantOption} onChange={(e) => setGrantOption(e.target.checked)} />
            WITH GRANT OPTION（可转授）
          </label>
        </>
      )}
      {isOra && (
        <>
          <div className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">系统权限</div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {ORA_SYS_PRIVS.map((p) => (
              <label key={p} className={lab}>
                <input type="checkbox" className={cb} checked={!!checks[p]} onChange={(e) => setChecks((s) => ({ ...s, [p]: e.target.checked }))} />
                {p}
              </label>
            ))}
          </div>
          <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">角色</div>
          <div className="mt-1 flex gap-3">
            {ORA_ROLES.map((p) => (
              <label key={p} className={lab}>
                <input type="checkbox" className={cb} checked={!!checks[p]} onChange={(e) => setChecks((s) => ({ ...s, [p]: e.target.checked }))} />
                {p}
              </label>
            ))}
          </div>
        </>
      )}
      {msg && <div className={`mt-1.5 text-[length:calc(var(--pref-fs)*0.714)] ${msg.ok ? 'text-ok' : 'text-prod'}`}>{msg.text}</div>}
      <button onClick={() => void apply()} disabled={busy} className="mt-2 w-full rounded bg-accent px-2 py-1 text-[length:calc(var(--pref-fs)*0.714)] text-white hover:opacity-90 disabled:opacity-40">
        {busy ? '应用中…' : '应用权限修改'}
      </button>
    </div>
  );
}

/** 新建用户对话框（按方言差异化字段：MySQL 主机 / PG LOGIN+CREATEDB / Oracle 表空间） */
function CreateUserDialog({ connId, kind, onClose, onCreated }: { connId: string; kind: string; onClose: () => void; onCreated: () => void }) {
  const isMysql = kind === 'mysql';
  const isOra = kind === 'oracle';
  const isPg = kind === 'postgres';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [host, setHost] = useState('%');
  const [superuser, setSuperuser] = useState(false);
  const [canLogin, setCanLogin] = useState(true);
  const [createDb, setCreateDb] = useState(false);
  const [tablespace, setTablespace] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name.trim())) {
      setErr('请填写合法的用户名（字母/数字/下划线，以字母或下划线开头）');
      return;
    }
    if (!password) {
      setErr('口令不能为空');
      return;
    }
    setSubmitting(true);
    setErr(null);
    const spec: DbUserSpec = { name: name.trim(), password, host, superuser, canLogin, createDb, tablespace: tablespace.trim() || undefined };
    try {
      await api.createUser(connId, spec);
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const fieldCls = 'w-full rounded-sm border border-line bg-bg px-1.5 py-1 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none focus:border-accent';
  const labelCls = 'text-[length:calc(var(--pref-fs)*0.786)] text-dim';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div className="w-[360px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">
          新建用户
          <span className="ml-1 rounded bg-panel3 px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] font-normal text-dim2">{isOra ? 'Oracle' : isMysql ? 'MySQL' : 'PostgreSQL'}</span>
        </div>
        <div className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2.5">
          <span className={labelCls}>用户名</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="user_name" className={fieldCls} />
          <span className={labelCls}>口令</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={fieldCls} />
          {isMysql && (
            <>
              <span className={labelCls}>主机</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="%（任意主机）" className={fieldCls} />
            </>
          )}
          {isOra && (
            <>
              <span className={labelCls}>默认表空间</span>
              <input value={tablespace} onChange={(e) => setTablespace(e.target.value)} placeholder="USERS" className={fieldCls} />
            </>
          )}
          <span className={labelCls}>超级用户</span>
          <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
            <input type="checkbox" checked={superuser} onChange={(e) => setSuperuser(e.target.checked)} />
            {isPg ? 'SUPERUSER' : isOra ? '授予 DBA' : 'GRANT ALL PRIVILEGES'}
          </label>
          {isPg && (
            <>
              <span className={labelCls}>可登录</span>
              <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
                <input type="checkbox" checked={canLogin} onChange={(e) => setCanLogin(e.target.checked)} /> LOGIN
              </label>
              <span className={labelCls}>建库权限</span>
              <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg">
                <input type="checkbox" checked={createDb} onChange={(e) => setCreateDb(e.target.checked)} /> CREATEDB
              </label>
            </>
          )}
        </div>
        {err && <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-prod">{err}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-line px-3 py-1 text-[length:calc(var(--pref-fs)*0.786)] text-dim hover:bg-panel3">取消</button>
          <button onClick={() => void submit()} disabled={submitting} className="rounded bg-accent px-3 py-1 text-[length:calc(var(--pref-fs)*0.786)] text-white hover:opacity-90 disabled:opacity-40">
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 顶部工具栏图标按钮（24×24 命中区；accent=提交等主动作，可用时高亮）。icon 传 svg path 片段 */
function IBtn({ title, onClick, disabled, accent, icon }: { title: string; onClick: () => void; disabled?: boolean; accent?: boolean; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        accent
          ? 'text-ok hover:bg-panel3 disabled:opacity-30'
          : 'text-dim hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30'
      }`}
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
    </button>
  );
}

/** 日期格式化：date 类型（时间为零点）→ yyyy-MM-dd；时间/时间戳 → yyyy-MM-dd HH:mm:ss */
function fmtDate(d: Date, dataType?: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  // 纯 date 类型（PG date / MySQL DATE）值为零点，只显示日期；
  // Oracle DATE 本身带时间部分，非零点时保留完整时间避免丢信息
  const isPureDate = /^date$/i.test((dataType ?? '').trim()) && d.getHours() + d.getMinutes() + d.getSeconds() + d.getMilliseconds() === 0;
  if (isPureDate) return date;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 单元格值格式化 */
function fmt(v: unknown, dataType?: string): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : fmtDate(v, dataType);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 内联编辑器初始值：NULL 单元格以空串开局（空串提交即 NULL），避免把显示用的 "NULL" 字面量填进输入框当成文本写回 */
function editInit(v: unknown, dataType?: string): string {
  return v === null || v === undefined ? '' : fmt(v, dataType);
}

/** 编辑提交的 NULL 感知守卫：原值为 NULL 且输入仍为空串 → 不落编辑（避免点开又点走留下脏编辑、(Null) 显示消失） */
function editChanged(orig: unknown, nv: string): boolean {
  return !(nv === '' && (orig === null || orig === undefined));
}

/**
 * 把用户输入值转为 SQL 字面量（基础版，单用户工具内部使用）。
 * - 空串 → NULL（清空单元格即置空，符合 DBeaver 习惯）；
 * - 数值类型 → 裸数字；否则加单引号并转义。
 * - 整数不再走 Number() 往返：19 位雪花 ID 会被舍成 15 位精度（末尾变 0），直接原样输出。
 */
function sqlVal(dataType: string, raw: unknown): string {
  const v = raw == null ? '' : String(raw).trim();
  if (v === '') return 'NULL';
  const numeric = /int|decimal|float|double|numeric|real|serial|money|smallint|tinyint|year/i.test(dataType);
  if (numeric) {
    // 纯整数（含超长 bigint）原样输出，不经 Number 转换避免精度丢失
    if (/^[+-]?\d+$/.test(v)) return v.replace(/^[+]/, '');
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  return `'${v.replace(/'/g, "''")}'`;
}

/** 判断列类型是否为日期/时间类（date / datetime / timestamp / time 及各方言变体） */
function isDateTimeType(dataType?: string): boolean {
  return /date|time/i.test((dataType ?? '').trim());
}

/** 解析常见日期时间文本（yyyy-MM-dd、yyyy-MM-dd HH:mm:ss、ISO 含 T）；无法解析返回 null */
function parseDateTimeStr(s: string): { d: Date; hasTime: boolean } | null {
  const str = (s ?? '').trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/.exec(str);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : { d, hasTime: m[4] !== undefined };
  }
  const d = new Date(str);
  if (!Number.isNaN(d.getTime()) && /\d/.test(str)) return { d, hasTime: /[T ]\d{1,2}:/.test(str) };
  return null;
}

/**
 * 日期/时间类单元格编辑器：双击进入编辑即直接弹出日历选择面板，面板内仍保留文本框手输。
 * - date（MySQL/PG DATE 且值为零点）：只有年月日，点选即提交关闭；Oracle DATE 带
 *   时间部分时自动回退为「日历 + 时:分:秒」避免丢时间；
 * - datetime / timestamp：日历 + 时:分:秒，点日期更新草稿，「确定」提交；
 * - time：只有 时:分:秒。
 * 双击进入编辑（autoOpen）时挂载即弹层；新增行无双击手势，聚焦输入框才弹层。
 * 弹层用 fixed 视口定位（表格滚动容器不会裁剪）；面板内 mousedown 阻止默认行为，
 * 保持输入框焦点，避免 blur 提前提交。失焦 / Enter / 确定 均提交草稿。
 */
function DateTimeCellEditor({ initialValue, dataType, onCommit, onCancel, autoOpen = false }: {
  initialValue: string;
  dataType?: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  /** true：挂载即直接弹出日历（双击单元格进入编辑用）；false：聚焦输入框才弹出（新增行用） */
  autoOpen?: boolean;
}) {
  const t = (dataType ?? '').trim().toLowerCase();
  // 纯时间列：time / time without time zone 等，但不含 timestamp（负向断言排除）
  const timeOnly = /^time(?!stamp)/.test(t);
  const parsed = parseDateTimeStr(initialValue);
  /** 纯 date：只有年月日（Oracle DATE 带时间部分时为 false） */
  const pureDate = !timeOnly && /^date$/.test(t) && !(parsed?.hasTime ?? false);
  const showCal = !timeOnly;
  const showTime = timeOnly || !pureDate;

  const base = parsed?.d ?? new Date();
  const [draft, setDraft] = useState(initialValue);
  const [open, setOpen] = useState(autoOpen);
  const [vy, setVy] = useState(base.getFullYear());
  const [vm, setVm] = useState(base.getMonth());
  const [hh, setHh] = useState(base.getHours());
  const [mm, setMm] = useState(base.getMinutes());
  const [ss, setSs] = useState(base.getSeconds());
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  /** draft 的最新值镜像（供事件监听 / onBlur 读取，避免闭包过期） */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** 提交防重：失焦 / 外部点击 / Enter / 确定按钮可能连续触发 */
  const doneRef = useRef(false);
  const commit = (v: string) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(v.trim());
  };

  const p2 = (n: number) => String(n).padStart(2, '0');
  const fmtParts = (y: number, mo: number, d: number) =>
    timeOnly
      ? `${p2(hh)}:${p2(mm)}:${p2(ss)}`
      : `${y}-${p2(mo + 1)}-${p2(d)}${showTime ? ` ${p2(hh)}:${p2(mm)}:${p2(ss)}` : ''}`;

  /** 根据单元格位置计算弹层定位（靠近窗口底部/右侧自动翻上/内缩） */
  const placePopup = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 240;
    const H = showCal ? (showTime ? 318 : 292) : 96;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - W - 8);
    const top = r.bottom + H > window.innerHeight - 8 ? Math.max(8, r.top - H - 4) : r.bottom + 4;
    setPos({ left, top });
  };
  const openPopup = () => { placePopup(); setOpen(true); };

  // 弹层打开期间：定位 + 点击外部提交关闭 + 滚动/缩放跟随定位刷新
  useEffect(() => {
    if (!open) return;
    placePopup();
    const onDoc = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (popupRef.current?.contains(tgt) || wrapRef.current?.contains(tgt)) return;
      setOpen(false);
      commit(draftRef.current);
    };
    document.addEventListener('mousedown', onDoc, true);
    window.addEventListener('resize', placePopup);
    window.addEventListener('scroll', placePopup, true);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      window.removeEventListener('resize', placePopup);
      window.removeEventListener('scroll', placePopup, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 点选某天：纯 date 类型立即提交关闭；带时间类型仅更新草稿，时间可继续调整 */
  const pickDay = (d: number) => {
    const val = fmtParts(vy, vm, d);
    setDraft(val);
    if (!showTime) {
      setOpen(false);
      commit(val);
    }
  };

  /** 修改时:分:秒：若草稿是可解析的日期时间则同步更新草稿 */
  const setTime = (h: number, m: number, s: number) => {
    setHh(h); setMm(m); setSs(s);
    const pd = parseDateTimeStr(draft);
    if (pd) {
      const val = timeOnly
        ? `${p2(h)}:${p2(m)}:${p2(s)}`
        : `${pd.d.getFullYear()}-${p2(pd.d.getMonth() + 1)}-${p2(pd.d.getDate())} ${p2(h)}:${p2(m)}:${p2(s)}`;
      setDraft(val);
    }
  };

  const setNow = () => {
    const n = new Date();
    setVy(n.getFullYear()); setVm(n.getMonth());
    setHh(n.getHours()); setMm(n.getMinutes()); setSs(n.getSeconds());
    const val = timeOnly
      ? `${p2(n.getHours())}:${p2(n.getMinutes())}:${p2(n.getSeconds())}`
      : `${n.getFullYear()}-${p2(n.getMonth() + 1)}-${p2(n.getDate())}${showTime ? ` ${p2(n.getHours())}:${p2(n.getMinutes())}:${p2(n.getSeconds())}` : ''}`;
    setDraft(val);
    setOpen(false);
    commit(val);
  };

  // 周一为首列；选中日与今天高亮
  const firstDow = (new Date(vy, vm, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(vy, vm + 1, 0).getDate();
  const sel = parseDateTimeStr(draft)?.d;
  const today = new Date();
  const isSelDay = (d: number) =>
    !!sel && sel.getFullYear() === vy && sel.getMonth() === vm && sel.getDate() === d;
  const isToday = (d: number) =>
    today.getFullYear() === vy && today.getMonth() === vm && today.getDate() === d;

  return (
    <div ref={wrapRef} className="flex h-full w-full items-center">
      <input
        autoFocus={autoOpen}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={openPopup}
        onBlur={(e) => {
          // 焦点移入弹层（如时:分:秒输入框）时不提交，等弹层内操作完成
          if (popupRef.current?.contains(e.relatedTarget as Node)) return;
          setOpen(false);
          commit(draftRef.current);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(draftRef.current);
          // 弹层打开时 Esc 先关弹层，再按一次才取消编辑
          else if (e.key === 'Escape') { if (open) setOpen(false); else onCancel(); }
        }}
        placeholder={timeOnly ? 'HH:mm:ss' : pureDate ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss'}
        className="h-full w-full min-w-0 bg-bg px-1 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline outline-1 outline-accent"
      />
      {open && pos && createPortal(
        <div
          ref={popupRef}
          data-dt-cell-editor
          className="fixed z-50 w-[240px] rounded-md border border-line bg-panel2 p-2 text-fg shadow-lg"
          style={{ left: pos.left, top: pos.top }}
          onMouseDown={(e) => e.preventDefault()}
          /* 弹层虽 portal 到 body，但 React 合成事件仍沿 React 树冒泡到 td（触发 onCellMouseDown 抢焦点
             → blur 提交旧草稿）。必须在此截断冒泡，且根节点带 data-dt-cell-editor 供 td 守卫识别 */
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {showCal && (
            <>
              {/* 年月导航：« 上一年 / ‹ 上月 / 标题 / › 下月 / » 下一年 */}
              <div className="mb-1 flex items-center justify-between px-0.5">
                <button className="rounded px-1 text-dim hover:bg-panel3 hover:text-fg" title="上一年" onClick={() => setVy((v) => v - 1)}>«</button>
                <button className="rounded px-1 text-dim hover:bg-panel3 hover:text-fg" title="上月" onClick={() => { vm === 0 ? (setVy((v) => v - 1), setVm(11)) : setVm((m) => m - 1); }}>‹</button>
                <span className="text-[length:calc(var(--pref-fs)*0.857)] font-medium tabular-nums">{vy}-{p2(vm + 1)}</span>
                <button className="rounded px-1 text-dim hover:bg-panel3 hover:text-fg" title="下月" onClick={() => { vm === 11 ? (setVy((v) => v + 1), setVm(0)) : setVm((m) => m + 1); }}>›</button>
                <button className="rounded px-1 text-dim hover:bg-panel3 hover:text-fg" title="下一年" onClick={() => setVy((v) => v + 1)}>»</button>
              </div>
              <div className="grid grid-cols-7 gap-px text-center text-[length:calc(var(--pref-fs)*0.714)]">
                {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
                  <span key={w} className="py-0.5 text-dim2">{w}</span>
                ))}
                {Array.from({ length: firstDow }).map((_, i) => (
                  <span key={`b${i}`} />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const d = i + 1;
                  return (
                    <button
                      key={d}
                      onClick={() => pickDay(d)}
                      className={`rounded py-0.5 tabular-nums hover:bg-accent hover:text-white ${
                        isSelDay(d) ? 'bg-accent text-white' : isToday(d) ? 'text-accent' : 'text-fg'
                      }`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {showTime && (
            <div className="mt-1 flex items-center justify-center gap-1">
              <TimeNum value={hh} max={23} onChange={(v) => setTime(v, mm, ss)} />
              <span className="text-dim">:</span>
              <TimeNum value={mm} max={59} onChange={(v) => setTime(hh, v, ss)} />
              <span className="text-dim">:</span>
              <TimeNum value={ss} max={59} onChange={(v) => setTime(hh, mm, v)} />
            </div>
          )}
          <div className="mt-1 flex items-center gap-1 border-t border-line pt-1 text-[length:calc(var(--pref-fs)*0.786)]">
            <button
              className="rounded px-1.5 py-0.5 text-dim2 hover:bg-panel3 hover:text-fg"
              title="置为 NULL"
              onClick={() => { setOpen(false); commit(''); }}
            >
              NULL
            </button>
            <div className="flex-1" />
            <button className="rounded px-1.5 py-0.5 text-dim hover:bg-panel3 hover:text-fg" onClick={setNow}>
              现在
            </button>
            <button
              className="rounded bg-accent px-2 py-0.5 text-white hover:bg-accent2"
              onClick={() => { setOpen(false); commit(draft); }}
            >
              确定
            </button>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

/** 弹层内 时/分/秒 数字输入（两位显示，越界自动截断；stopPropagation 放行默认聚焦以便鼠标编辑） */
function TimeNum({ value, max, onChange }: { value: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      onMouseDown={(e) => e.stopPropagation()}
      value={String(Math.min(Math.max(0, value), max)).padStart(2, '0')}
      onChange={(e) => {
        const n = parseInt(e.target.value.replace(/\D/g, ''), 10);
        onChange(Number.isNaN(n) ? 0 : Math.min(Math.max(0, n), max));
      }}
      className="w-9 rounded border border-line bg-bg px-1 text-center text-[length:calc(var(--pref-fs)*0.786)] tabular-nums text-fg outline-none focus:border-accent"
    />
  );
}
