import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/api';
import { PageHeaderCard } from '@renderer/components/common/PageHeaderCard';
import { useAppStore, type DbTab } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import { useScriptStore } from '@renderer/store/scriptStore';
import { usePrefs } from '@renderer/store/prefsStore';
import type { DbColumn, DbColumnAlterSpec, DbColumnSpec, DbForeignKey, DbIndex, DbObjectMeta, DbSequenceInfo, DbTrigger, DbUser, DbUserPrivEdit, DbUserPrivilege, DbUserSpec, QueryColumn, QueryResult, ScriptResult } from '@shared/types';
import { ErrorBox } from '@renderer/components/common/States';
import { promptDialog } from '@renderer/components/common/PromptDialog';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { CreateTableDialog } from '@renderer/components/common/CreateTableDialog';
import { Markdown } from '@renderer/components/common/Markdown';
import { RoutineStudio } from '@renderer/components/workbench/RoutineStudio';
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

/** 当前时间格式化（YYYY-MM-DD HH:mm:ss，状态栏「获取时间」展示用） */
const fmtNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 表标签页子页（Navicat 表设计器：数据 + 列/索引/外键/触发器/SQL 预览） */
type TableSubTab = 'data' | 'columns' | 'indexes' | 'foreign' | 'triggers' | 'ddl';

/** 子页分段控件的项（表设计器顶部右侧） */
const SUB_TABS: { k: TableSubTab; label: string }[] = [
  { k: 'data', label: '数据' },
  { k: 'columns', label: '列' },
  { k: 'indexes', label: '索引' },
  { k: 'foreign', label: '外键' },
  { k: 'triggers', label: '触发器' },
  { k: 'ddl', label: 'SQL 预览' },
];

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
  /** 结果内快捷筛选（客户端过滤已载入行，不触发查询；联动状态栏「已载入」计数） */
  const [qf, setQf] = useState('');
  /** 条件/排序输入框是否展开（设计稿默认收起，显示 ＋条件/＋排序 虚线按钮；点击或已有值时展开真实输入） */
  const [showWhere, setShowWhere] = useState(whereCl !== '');
  const [showOrder, setShowOrder] = useState(orderByCl !== '');
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
  /** 新建触发器对话框开关（触发器子页） */
  const [addTrigOpen, setAddTrigOpen] = useState(false);
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
  /** 筛选栏 order by 输入框（顶部工具条「＋ 排序」聚焦） */
  const orderByInputRef = useRef<HTMLInputElement>(null);
  /** 是否还有更多行（翻页「下一页」可用性） */
  const [hasMore, setHasMore] = useState(false);
  /** 当前页码（0 起，真分页；重查/筛选/档位变更时归零） */
  const [tbPage, setTbPage] = useState(0);

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
      setTbPage(0);
      return res;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  };

  /** 真分页翻页（DBeaver 同款）：按页码整页替换数据（offset = 页码 × 行数限制）。编辑按行索引缓存，跨页会错位，有未提交改动时禁止翻页 */
  const gotoTbPage = async (p: number) => {
    if (loading || p < 0 || !result || detail) return;
    if (dirtyCount > 0) {
      setCommitMsg('有未提交改动，请先提交或回滚再翻页');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { where, orderBy } = filterRef.current;
      const res = await api.tableData(connId, db, table, limit, pgDb, p * limit, {
        where: quoteWhereValues(where, colMeta) || undefined,
        orderBy: orderBy.trim() || undefined,
      });
      setResult(res);
      setHasMore(res.rowCount >= limit);
      setTbPage(p);
      setSelected(null);
      setCurCol(null);
      setDetail(false);
      setFetchedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
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
    /** 复制为 SQL（Navicat 风格）：作用于选区内行（右键不在选区则仅当前行），INSERT 全列 / UPDATE 按主键定位（无主键退化为全列 WHERE） */
    const sqlRowIdx = (inRect ? [...selRows] : [m.ri]).filter((ri) => baseRows[ri]).sort((a, b) => a - b);
    const rowVal = (ri: number, c: QueryColumn) =>
      edits[`${ri}::${c.name}`] !== undefined ? edits[`${ri}::${c.name}`] : baseRows[ri][c.name];
    const qName = (name: string) => (isPg ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``);
    const qTable = db ? `${qName(db)}.${qName(table)}` : qName(table);
    const copyAsSql = (kind: 'insert' | 'update') => {
      const stmts = sqlRowIdx.map((ri) => {
        if (kind === 'insert') {
          const names = columns.map((c) => qName(c.name)).join(', ');
          const vals = columns.map((c) => sqlVal(c.dataType ?? '', rowVal(ri, c))).join(', ');
          return `INSERT INTO ${qTable} (${names}) VALUES (${vals});`;
        }
        const sets = columns.map((c) => `${qName(c.name)} = ${sqlVal(c.dataType ?? '', rowVal(ri, c))}`).join(', ');
        const whereCols = pkCols.length ? columns.filter((c) => pkCols.includes(c.name)) : columns;
        const wheres = whereCols.map((c) => `${qName(c.name)} = ${sqlVal(c.dataType ?? '', rowVal(ri, c))}`).join(' AND ');
        return `UPDATE ${qTable} SET ${sets} WHERE ${wheres};`;
      });
      copyText(stmts.join('\n'));
    };
    const sqlRowsLabel = sqlRowIdx.length > 1 ? `（${sqlRowIdx.length} 行）` : '';
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
        label: `复制为 INSERT${sqlRowsLabel}`,
        onClick: () => copyAsSql('insert'),
      },
      {
        label: `复制为 UPDATE${sqlRowsLabel}`,
        onClick: () => copyAsSql('update'),
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

  /** 结果内快捷筛选：在已载入行中客户端过滤（顶部工具条「在结果中筛选」联动状态栏已载入计数） */
  const viewRows = useMemo(() => {
    const kw = qf.trim().toLowerCase();
    if (!kw) return displayRows;
    return displayRows.filter(({ row }) =>
      columns.some((c) => String(row[c.name] ?? '').toLowerCase().includes(kw)),
    );
  }, [displayRows, qf, columns]);

  /** 导出下拉展开状态（数据网格顶部工具条，与 SQL 结果导出一致） */
  const [exportOpen, setExportOpen] = useState(false);

  /** 导出当前结果集（CSV / JSON / INSERT / Markdown，均基于已取回行本地生成下载；与 SQL 查询结果导出一致） */
  const exportData = (kindArg: 'csv' | 'json' | 'insert' | 'md') => {
    setExportOpen(false);
    if (columns.length === 0 || viewRows.length === 0) return;
    if (kindArg === 'csv') {
      const esc = (v: unknown, dt?: string) => {
        if (v === null || v === undefined) return '';
        const s = fmt(v, dt);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [columns.map((c) => esc(c.name)).join(',')];
      for (const { row } of viewRows) lines.push(columns.map((c) => esc(row[c.name], c.dataType)).join(','));
      downloadFile(`${table}.csv`, 'text/csv;charset=utf-8', '\uFEFF' + lines.join('\r\n'));
    } else if (kindArg === 'json') {
      const data = viewRows.map(({ row }) => {
        const o: Record<string, unknown> = {};
        for (const c of columns) o[c.name] = row[c.name] === undefined ? null : row[c.name];
        return o;
      });
      downloadFile(`${table}.json`, 'application/json', JSON.stringify(data, null, 2));
    } else if (kindArg === 'insert') {
      const q = (name: string) => (isPg ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``);
      const lit = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
      const colList = columns.map((c) => q(c.name)).join(', ');
      const stmts = viewRows.map(({ row }) => `INSERT INTO ${q(table)} (${colList}) VALUES (${columns.map((c) => lit(row[c.name])).join(', ')});`);
      downloadFile(`${table}_insert.sql`, 'text/sql', stmts.join('\n'));
    } else {
      const row1 = `| ${columns.map((c) => c.name).join(' | ')} |`;
      const sep = `| ${columns.map(() => '---').join(' | ')} |`;
      const body = viewRows.map(({ row }) => `| ${columns.map((c) => { const v = row[c.name]; return v === null || v === undefined ? '' : String(v); }).join(' | ')} |`);
      downloadFile(`${table}.md`, 'text/markdown', [row1, sep, ...body].join('\n'));
    }
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

  /** 新建触发器（触发器子页 → CREATE TRIGGER；PG 需先建 plpgsql 触发器函数再挂触发器） */
  const submitCreateTrigger = async (name: string, timing: string, event: string, body: string) => {
    if (!name.trim() || !body.trim()) return;
    const q = (n: string) => (isPg ? `"${n.replace(/"/g, '""')}"` : `\`${n.replace(/`/g, '``')}\``);
    const tbl = db ? `${q(db)}.${q(table)}` : q(table);
    setDdlMsg(null);
    try {
      if (isPg) {
        const fn = `${name.trim()}_fn`;
        await api.runSql(
          connId,
          `CREATE OR REPLACE FUNCTION ${q(fn)}() RETURNS trigger AS $trg$\nBEGIN\n  ${body.trim()}\n  RETURN NEW;\nEND;\n$trg$ LANGUAGE plpgsql`,
          pgDb || undefined,
        );
        await api.runSql(
          connId,
          `CREATE TRIGGER ${q(name.trim())} ${timing} ${event} ON ${tbl} FOR EACH ROW EXECUTE FUNCTION ${q(fn)}()`,
          pgDb || undefined,
        );
      } else {
        await api.runSql(connId, `CREATE TRIGGER ${q(name.trim())} ${timing} ${event} ON ${tbl} FOR EACH ROW ${body.trim()}`, pgDb || undefined);
      }
      await loadDesign('triggers', true);
      setDdlMsg(`已创建触发器 ${name.trim()}`);
    } catch (e) {
      window.alert(`创建触发器失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部「表名 + 子页签」条（设计稿同款：文字页签，激活项主题色文字 + 底部 2px 下划线） */}
      <div className="flex h-[38px] shrink-0 items-center gap-1 border-b border-line bg-panel px-3.5">
        {/* 表身份：图标 + 库.表 */}
        <div
          className="flex min-w-0 items-center gap-1.5"
          title={pkCols.length ? `主键 ${pkCols.join(', ')}` : '无主键（只读）'}
        >
          <svg className="h-3.5 w-3.5 shrink-0 text-dim2" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="1.5" />
            <path d="M3 9.5h18M9 9.5V20" />
          </svg>
          <span className="truncate text-[13px] font-semibold text-fg">
            {db && <span className="font-normal text-dim">{db}.</span>}
            {table}
          </span>
          {pkCols.length === 0 && (
            <span className="shrink-0 rounded border border-line2/70 px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-dim2">只读</span>
          )}
        </div>

        {commitMsg && (
          <span className="ml-1.5 min-w-0 truncate text-[length:calc(var(--pref-fs)*0.714)] text-dim" title={commitMsg}>
            {commitMsg}
          </span>
        )}

        {/* 子页切换（数据 / 列 / 索引 / 外键 / 触发器 / SQL 预览） */}
        <div className="ml-3 flex h-full shrink-0 items-stretch gap-0.5">
          {SUB_TABS.map((t) => (
            <button
              key={t.k}
              onClick={() => setSubTab(t.k)}
              title={t.label}
              className={`relative inline-flex items-center px-2.5 text-[12.5px] transition-colors ${
                subTab === t.k ? 'font-medium text-accent2' : 'text-dim hover:text-fg'
              }`}
            >
              {t.label}
              {subTab === t.k && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t-[2px] bg-accent" />}
            </button>
          ))}
        </div>

        {/* 未提交改动徽标（设计稿放在表名条最右） */}
        {editable && dirtyCount > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] text-warn" title={`${dirtyCount} 处未提交改动，工具栏「提交」写入数据库`}>
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" strokeLinejoin="round" /></svg>
            {dirtyCount} 处未提交
          </span>
        )}
      </div>

      {subTab === 'data' ? (
        <>
          {/* 顶部工具条（设计稿同款单行：排序 chip + where / order by 输入 + 结果内筛选 + 右侧操作按钮） */}
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2.5">
            {sort && (
              <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-2 text-[11.5px] text-fg2">
                排序<b className="font-semibold text-accent2">{sort.col} {sort.dir === 'asc' ? '↑' : '↓'}</b>
                <span className="cursor-pointer text-dim2 hover:text-prod" onClick={() => setSort(null)} title="清除排序">×</span>
              </span>
            )}
            {showWhere ? (
              <FilterInput
                className="min-w-0 flex-[2]"
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
                  setShowWhere(false);
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
            ) : (
              <span
                onClick={() => { setShowWhere(true); requestAnimationFrame(() => whereInputRef.current?.focus()); }}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-line2 px-2 text-[11.5px] text-dim hover:border-accent hover:text-accent2"
                title="展开 WHERE 条件输入（回车执行查询；Esc 清空）"
              >＋ 条件</span>
            )}
            {showOrder ? (
              <FilterInput
                className="min-w-0 flex-1"
                inputRef={orderByInputRef}
                value={orderByCl}
                onChange={(v) => {
                  setOrderByCl(v);
                  filterRef.current.orderBy = v;
                }}
                onSubmit={() => void reload(limit)}
                onClear={() => {
                  setOrderByCl('');
                  filterRef.current.orderBy = '';
                  setShowOrder(false);
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
            ) : (
              <span
                onClick={() => { setShowOrder(true); requestAnimationFrame(() => orderByInputRef.current?.focus()); }}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-line2 px-2 text-[11.5px] text-dim hover:border-accent hover:text-accent2"
                title="展开 ORDER BY 输入（回车执行查询；Esc 清空）"
              >＋ 排序</span>
            )}
            <span className="h-4 w-px shrink-0 bg-line2" />
            <label className="flex h-6 w-[180px] shrink-0 items-center gap-1.5 rounded-md border border-line2 bg-panel2 px-2 text-dim focus-within:border-accent">
              <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4-4" /></svg>
              <input
                value={qf}
                onChange={(e) => setQf(e.target.value)}
                placeholder="在结果中筛选…"
                className="w-full border-none bg-transparent text-[12px] text-fg outline-none placeholder:text-dim2"
              />
            </label>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <TBtn label="插入行" onClick={() => setNewRows((r) => [...r, {}])} icon={<><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M12 9v6M9 12h6" /></>} />
              <TBtn label="删除行" danger disabled={selected == null} onClick={() => selected != null && setDeleted((s) => new Set(s).add(selected))} icon={<><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M9 12h6" /></>} />
              <span className="h-4 w-px bg-line2" />
              <span className="relative">
                <TBtn label="导出" onClick={() => setExportOpen((o) => !o)} disabled={!result} icon={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>} />
                {exportOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 min-w-[156px] rounded-md border border-line bg-panel p-1 shadow-xl">
                    {([
                      ['csv', 'CSV（Excel 可开）'],
                      ['json', 'JSON 数据'],
                      ['insert', 'INSERT 语句'],
                      ['md', 'Markdown 表格'],
                    ] as const).map(([k, label]) => (
                      <button key={k} onClick={() => exportData(k)} className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-fg hover:bg-panel3">
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </span>
              <TBtn label="刷新" onClick={() => void reload()} disabled={loading} icon={<><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" /></>} />
              {editable && (
                <>
                  <TBtn label="提交" accent disabled={committing || dirtyCount === 0} onClick={() => void commit()} icon={<><path d="M5 13l4 4L19 7" /></>} />
                  <TBtn label="回滚" onClick={rollback} disabled={dirtyCount === 0} icon={<><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v1" /></>} />
                </>
              )}
            </div>
          </div>
          <div
            ref={gridWrapRef}
            tabIndex={0}
          onKeyDown={(e) => {
            // Tab：选中行时切换「记录视图」（该行竖排为 字段/值 两列）；输入框内不拦截
            if (e.key === 'Tab' && selected != null) {
              const t = e.target as HTMLElement;
              if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
              e.preventDefault();
              setDetail((d) => !d);
            }
          }}
          className="min-h-0 flex-1 overflow-auto bg-panel outline-none"
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
              displayRows={viewRows}
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
        /* 列结构子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
        <div className="flex min-h-0 flex-1 flex-col p-2.5">
          {error ? (
            <ErrorBox message={error} onRetry={() => void reload()} />
          ) : (
            <ColumnsView meta={colMeta} loading={loading} ddlMsg={ddlMsg} dialect={conn?.kind ?? ''} onAdd={() => setAddColOpen(true)} onDrop={(n) => void submitDropColumn(n)} onAlter={submitAlterColumn} />
          )}
        </div>
      ) : subTab === 'indexes' ? (
        /* 索引子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
        <div className="flex min-h-0 flex-1 flex-col p-2.5">
          <IndexListView
            items={indexes}
            loading={designLoading}
            error={designErr}
            ddlMsg={ddlMsg}
            onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'indexes'))); void loadDesign('indexes'); }}
            onAdd={() => setAddIdxOpen(true)}
          />
        </div>
      ) : subTab === 'foreign' ? (
        /* 外键子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
        <div className="flex min-h-0 flex-1 flex-col p-2.5">
          <ForeignKeyListView
            items={fks}
            loading={designLoading}
            error={designErr}
            ddlMsg={ddlMsg}
            onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'foreign'))); void loadDesign('foreign'); }}
            onAdd={() => setAddFkOpen(true)}
          />
        </div>
      ) : subTab === 'triggers' ? (
        /* 触发器子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
        <div className="flex min-h-0 flex-1 flex-col p-2.5">
          <TriggerListView
            items={trigs}
            loading={designLoading}
            error={designErr}
            ddlMsg={ddlMsg}
            onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'triggers'))); void loadDesign('triggers'); }}
            onAdd={() => setAddTrigOpen(true)}
          />
        </div>
      ) : (
        /* SQL 预览子页（对齐「用户与权限管理」页的卡片语言） */
        <div className="flex min-h-0 flex-1 flex-col p-2.5">
          <DdlView ddl={buildTableDdl(conn?.kind ?? 'postgres', db, table, colMeta, indexes, fks, trigs, tableComment)} loading={designLoading} error={designErr} />
        </div>
      )}

      {/* 底部状态条（数据网格设计稿同款：已载入行数 + 翻页 + 每页 + 双击编辑提示 + 行列坐标） */}
      <div className="flex h-8 shrink-0 items-center gap-2.5 border-t border-line2 bg-panel2 px-2.5 text-[11.5px] text-dim">
        {/* 翻页导航（设计稿同款：首页 / 上一页 / 下一页） */}
        <div className="flex items-center gap-0.5">
          <button onClick={() => void gotoTbPage(0)} disabled={loading || tbPage === 0} className="grid h-[22px] w-[22px] place-items-center rounded-md text-dim2 hover:bg-panel3 hover:text-fg disabled:opacity-30" title="第一页">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m11 19-7-7 7-7M20 5v14" /></svg>
          </button>
          <button onClick={() => void gotoTbPage(tbPage - 1)} disabled={loading || tbPage === 0} className="grid h-[22px] w-[22px] place-items-center rounded-md text-dim2 hover:bg-panel3 hover:text-fg disabled:opacity-30" title="上一页">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button onClick={() => void gotoTbPage(tbPage + 1)} disabled={loading || !hasMore} className="grid h-[22px] w-[22px] place-items-center rounded-md text-dim2 hover:bg-panel3 hover:text-fg disabled:opacity-30" title="下一页">
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>
        <span className="flex items-center gap-1 text-dim2">每页
          <select
            value={limit}
            onChange={(e) => {
              const lim = Number(e.target.value);
              setLimit(lim);
              void reload(lim);
            }}
            className="h-5 rounded border border-line2 bg-panel px-1 text-[11px] text-fg2 outline-none"
            title="结果行数上限（修改后立即重新查询）"
          >
            {LIMITS.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          行 · 第 {tbPage + 1} 页
        </span>
        {subTab === 'data' && result ? (
          <>
            <span className="shrink-0 tabular-nums">
              已载入 <b className="font-semibold tabular-nums text-fg2">{viewRows.length}</b> 行
              {(whereCl.trim() || orderByCl.trim() || qf.trim()) ? '（已筛选）' : ''}
              {`, ${(result.elapsedMs / 1000).toFixed(3)}s`}
              {fetchedAt ? ` · ${fetchedAt}` : ''}
            </span>
            <div className="ml-auto flex items-center gap-3">
              {selected != null && curCol ? (
                <span className="shrink-0 tabular-nums">行 {viewRows.findIndex((e) => e.ri === selected) + 1}, 列 {colOrder(curCol) + 1}</span>
              ) : (
                <span className="text-ok">双击单元格可直接编辑</span>
              )}
              <span className="h-3.5 w-px bg-line2" />
              <button
                onClick={() => {
                  if (selected == null || !curCol) return;
                  const key = `${selected}::${curCol}`;
                  const raw = edits[key] !== undefined ? edits[key] : result?.rows[selected]?.[curCol];
                  copyText(raw === null || raw === undefined ? '' : String(raw));
                }}
                disabled={!(subTab === 'data' && selected != null && curCol)}
                className="text-dim2 hover:text-fg disabled:opacity-40"
                title="复制选中单元格值"
              >
                复制
              </button>
            </div>
          </>
        ) : (
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
                      : ''}
          </span>
        )}
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

      {/* 新建触发器对话框（触发器子页） */}
      {addTrigOpen && (
        <AddTriggerDialog
          isPg={isPg}
          tableName={table}
          onCancel={() => setAddTrigOpen(false)}
          onSubmit={(name, timing, event, body) => {
            setAddTrigOpen(false);
            void submitCreateTrigger(name, timing, event, body);
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

/** 从 SQL 提取来源表名（导出文件名 / 结果条来源标签共用）；无 FROM/INTO/UPDATE 时回退 query_result */
function sqlSourceTable(sql: string): string {
  return sql.match(/(?:from|into|update)\s+(`?[\w$]+`?(?:\s*\.\s*`?[\w$]+`?)?)/i)?.[1]?.replace(/[`"\s]/g, '') || 'query_result';
}

/** 是否展示存储类列（行数/大小/引擎）：视图无存储，不展示 */
function hasStorage(kind: 'table' | 'view' | 'mview'): boolean {
  return kind !== 'view';
}

/** 对象图标片配色：按名称哈希从柔和色板取色（同一对象颜色固定） */
const OBJ_HUES = ['59 130 246', '139 92 246', '14 165 233', '22 163 74', '217 119 6', '225 29 72', '20 184 166'];
function objHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return OBJ_HUES[h % OBJ_HUES.length];
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
  /** 行内重命名：正在改名的对象名 + 输入框当前值 */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  /** 单击选中行（纯视觉，双击/菜单打开数据） */
  const [selName, setSelName] = useState<string | null>(null);

  const kindLabel = tab.kind === 'table' ? '表' : tab.kind === 'view' ? '视图' : '物化视图';
  const connObj = useConnections((s) => s.connections.find((c) => c.id === tab.connId));
  const dialectLabel = connObj?.kind === 'oracle' ? 'Oracle' : connObj?.kind === 'mysql' ? 'MySQL' : 'PostgreSQL';

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

  /** 开始行内重命名 */
  const startRename = (name: string) => {
    setRenameVal(name);
    setRenaming(name);
  };

  /** 提交重命名（Enter/失焦触发；Esc 在 onKeyDown 里取消） */
  const submitRename = async () => {
    const oldName = renaming;
    setRenaming(null);
    if (!oldName) return;
    const nn = renameVal.trim();
    if (!nn || nn === oldName) return;
    try {
      await api.renameObject(tab.connId, tab.kind, tab.schema, oldName, nn, tab.pgDb);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** 右键菜单项（按是否右键具体对象生成；破坏性的「删除」固定沉底，与日常操作隔离） */
  const menuItems = (item?: DbObjectMeta): MenuItem[] => {
    const items: MenuItem[] = [];
    if (item) {
      items.push(
        { label: '打开表数据', onClick: () => openTable(item.name) },
        { separator: true, label: '' },
        { label: '编辑结构…', onClick: () => { setEditName(item.name); setCreateOpen(true); } },
        { label: '重命名', onClick: () => startRename(item.name) },
        { separator: true, label: '' },
        { label: '新建表…', onClick: () => { setEditName(undefined); setCreateOpen(true); } },
        { label: '刷新', onClick: () => void load() },
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
    } else {
      items.push(
        { label: '新建表…', onClick: () => { setEditName(undefined); setCreateOpen(true); } },
        { label: '刷新', onClick: () => void load() },
      );
    }
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
  /** 引擎列仅在有引擎数据时展示（MySQL 有 / PG、Oracle 无） */
  const showEngine = hasStorage(tab.kind) && !!items?.some((it) => it.engine);
  /** 大小比例微条基准：全量对象中的最大值 */
  const maxBytes = Math.max(0, ...(items ?? []).map((x) => x.sizeBytes ?? 0));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      {/* 页头卡（统一 PageHeaderCard） */}
      <PageHeaderCard
        icon={
          <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.9} viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M3 10h18M9.5 10v10" />
          </svg>
        }
        title={`${kindLabel}清单`}
        subtitle={
          <>
            <span className="shrink-0 rounded bg-accent2/10 px-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium leading-[18px] text-accent2">{dialectLabel}</span>
            <span className="truncate font-mono">{tab.schema}</span>
            {items && hasStorage(tab.kind) && (
              <span className="truncate">
                {items.length} 个{kindLabel} · 总行数 {fmtNum(items.reduce((s, x) => s + (x.rows ?? 0), 0))} · 占用 {fmtBytes(items.reduce((s, x) => s + (x.sizeBytes ?? 0), 0))}
              </span>
            )}
            {items && !hasStorage(tab.kind) && <span className="truncate">{items.length} 个{kindLabel}</span>}
          </>
        }
        search={{ value: kw, onChange: setKw, placeholder: `筛选${kindLabel}名 / 注释（Ctrl+F）`, inputRef: searchRef }}
        actions={
          <>
            <button onClick={() => void load()} disabled={loading} className="btn shrink-0" title="重新读取对象列表">
              <svg className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
              刷新
            </button>
            <button className="btn-primary shrink-0" onClick={() => { setEditName(undefined); setCreateOpen(true); }}>
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              新建{tab.kind === 'table' ? '表' : kindLabel}
            </button>
          </>
        }
      />

      {/* 表格卡 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : (
          <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-panel2 text-left text-[length:calc(var(--pref-fs)*0.714)] tracking-wide text-dim">
                <th className="border-b border-line2 px-3 py-1.5 font-medium">名称</th>
                <th className="border-b border-line2 px-3 py-1.5 font-medium">注释</th>
                {hasStorage(tab.kind) && (
                  <>
                    <th className="border-b border-line2 px-3 py-1.5 text-right font-medium">行数</th>
                    <th className="border-b border-line2 px-3 py-1.5 text-right font-medium">大小</th>
                    {showEngine && <th className="border-b border-line2 px-3 py-1.5 font-medium">引擎</th>}
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const on = selName === it.name;
                const hue = objHue(it.name);
                return (
                  <tr
                    key={it.name}
                    className={`group cursor-pointer ${on ? 'bg-accent/10' : 'even:bg-panel2/50 hover:bg-panel3'}`}
                    style={on ? { boxShadow: 'inset 2.5px 0 0 rgb(var(--c-accent2))' } : undefined}
                    title="单击选中，双击打开表数据"
                    onClick={() => setSelName(it.name)}
                    onDoubleClick={() => openTable(it.name)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, item: it });
                    }}
                  >
                    <td className="border-b border-line whitespace-nowrap px-3 py-2">
                      <span className="flex items-center gap-2.5">
                        {/* 彩色图标片：按名称哈希取色，同一对象颜色固定 */}
                        <span
                          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-transform group-hover:scale-105"
                          style={{ background: `rgb(${hue} / .13)`, color: `rgb(${hue})`, outline: on ? '1.5px solid rgb(var(--c-accent2))' : undefined, outlineOffset: 1 }}
                        >
                          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
                            <rect x="3" y="4" width="18" height="16" rx="2.5" />
                            <path d="M3 10h18M9.5 10v10" />
                          </svg>
                        </span>
                        {renaming === it.name ? (
                          /* 行内重命名输入：Enter 提交 / Esc 取消 / 失焦提交；阻断行级双击打开与点击冒泡 */
                          <input
                            autoFocus
                            value={renameVal}
                            onChange={(e) => setRenameVal(e.target.value)}
                            onFocus={(e) => e.target.select()}
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void submitRename();
                              if (e.key === 'Escape') setRenaming(null);
                            }}
                            onBlur={() => void submitRename()}
                            className="w-56 rounded border border-accent bg-bg px-1.5 py-0.5 font-medium text-fg outline-none"
                            title="Enter 提交，Esc 取消"
                          />
                        ) : (
                          <span className={`font-mono font-medium ${on ? 'text-accent2' : 'text-fg'}`}>{it.name}</span>
                        )}
                      </span>
                    </td>
                    <td className="max-w-[280px] truncate border-b border-line px-3 py-2 text-dim">
                      {it.comment ?? <span className="text-dim2/50">—</span>}
                    </td>
                    {hasStorage(tab.kind) && (
                      <>
                        <td className={`border-b border-line px-3 py-2 text-right tabular-nums ${it.rows ? 'font-semibold text-accent2' : 'text-dim2'}`}>
                          {fmtNum(it.rows)}
                        </td>
                        <td className="border-b border-line px-3 py-2">
                          <div className="flex flex-col items-end gap-[3px]">
                            <span className="tabular-nums text-dim">{fmtBytes(it.sizeBytes)}</span>
                            {/* 大小比例微条：相对全库最大表 */}
                            <span className="h-[3px] w-16 overflow-hidden rounded-full bg-line2/60">
                              <span
                                className="block h-full rounded-full"
                                style={{
                                  width: it.sizeBytes ? `${Math.max(4, Math.round((it.sizeBytes / maxBytes) * 100))}%` : '0%',
                                  background: 'linear-gradient(90deg, rgb(var(--c-accent) / .65), rgb(var(--c-accent2) / .9))',
                                }}
                              />
                            </span>
                          </div>
                        </td>
                        {showEngine && (
                          <td className="whitespace-nowrap border-b border-line px-3 py-2">
                            {it.engine && (
                              <span className="rounded-md bg-panel3 px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim">
                                {it.engine}
                              </span>
                            )}
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={2 + (hasStorage(tab.kind) ? (showEngine ? 3 : 2) : 0)} className="px-3 py-10 text-center text-dim2">
                    {items && k ? '无匹配对象' : items ? '（空）' : '加载中…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部状态栏：汇总统计（筛选时数字联动） */}
      <div className="flex h-7 shrink-0 items-center gap-3.5 rounded-b-[10px] border-t border-line bg-panel2 px-3 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
        {items && (
          <>
            <span>
              共 <b className="font-semibold tabular-nums text-dim">{filtered.length}</b> {kindLabel}
            </span>
            {hasStorage(tab.kind) && (
              <>
                <span>
                  总行数 <b className="font-semibold tabular-nums text-dim">{fmtNum(filtered.reduce((s, x) => s + (x.rows ?? 0), 0))}</b>
                </span>
                <span>
                  占用 <b className="font-semibold tabular-nums text-dim">{fmtBytes(filtered.reduce((s, x) => s + (x.sizeBytes ?? 0), 0))}</b>
                </span>
              </>
            )}
          </>
        )}
        <span className="ml-auto">
          {tab.schema}
          {k && items ? ` · 筛选 ${filtered.length} / ${items.length}` : ''}
        </span>
      </div>
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
  /* 设计稿网格：无整列高亮；选中格 = accent 10% 底 + inset 描边（见下方 cellBg / isCurCell） */
  return (
    <table className="w-full select-none border-separate border-spacing-0 text-[length:calc(var(--pref-fs)*0.786)]">
      <thead className="sticky top-0 z-10">
        {/* 表头：图标 + 列名，点击排序（asc → desc → 取消） */}
        <tr className="bg-panel2">
          <th
            className="w-11 cursor-pointer select-none border-b border-r border-line bg-panel2 px-1 py-[7px] text-right text-dim2 hover:bg-panel3"
            onMouseDown={(e) => onGutterMouseDown(-1, e)}
            onMouseEnter={() => onGutterMouseEnter(-1)}
            title="点击/拖拽选中所有行"
          >#</th>
          {columns.map((c) => {
            const isSorted = sort?.col === c.name;
            const isColSel = selCols.has(c.name);
            return (
              <th
                key={c.name}
                onClick={() => onSort(c.name)}
                onMouseDown={(e) => onHeaderMouseDown(c.name, e)}
                onMouseEnter={() => onHeaderMouseEnter(c.name)}
                title={`${c.name}${comments?.[c.name] ? ` · ${comments[c.name]}` : c.dataType ? ` · ${c.dataType}` : ''}${c.nullable === false ? ' · NOT NULL' : ''}（点击排序；拖拽可选中多列）`}
                className={`cursor-pointer select-none whitespace-nowrap border-b border-r border-line2 px-2.5 py-[7px] text-[11px] font-semibold ${isColSel ? 'bg-accent/10' : 'bg-panel2 hover:bg-panel3'} ${isSorted ? 'text-accent2 shadow-[inset_0_-2px_0_rgb(var(--c-accent))]' : 'text-fg2'}`}
              >
                <span className="flex items-center gap-1">
                  {c.name}
                  {pkCols.includes(c.name) && (
                    <svg className="h-2.5 w-2.5 shrink-0 text-ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
                  )}
                  {c.dataType && <span className="max-w-[88px] truncate text-[9.5px] font-normal leading-none tracking-wide text-dim2">{c.dataType}</span>}
                  {isSorted && <span className="text-[8.5px]">{sort?.dir === 'asc' ? '▲' : '▼'}</span>}
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
              className={`group ${isDeleted ? 'opacity-40 line-through' : ''} ${isDirty && !isSel ? 'bg-warn/20' : 'hover:bg-panel3/60'}`}
            >
              <td
                className={`cursor-pointer border-b border-r border-line bg-panel2 px-1 py-[6px] group-hover:bg-panel3 text-right ${isAnchor ? 'font-semibold text-accent' : isSel ? 'text-fg' : 'text-dim2'}`}
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
                const cellBg = isCurCell || isCellSel ? 'bg-accent/10' : '';
                return (
                  <td
                    key={c.name}
                    className={`relative max-w-[280px] cursor-cell border-b border-line border-r border-line/55 px-2.5 py-[6px] ${cellBg} text-left text-fg ${isCurCell && !isEditing ? 'shadow-[inset_0_0_0_1.5px_rgb(var(--c-accent))]' : ''}`}
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
                    <span className={val === null || val === undefined ? 'italic text-dim2' : 'block truncate'}>{val === null || val === undefined ? 'NULL' : fmt(val, c.dataType)}</span>
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
            <td className="border-b border-r border-line bg-panel2 px-1 py-[6px] text-right text-ok" title="新增行">
              +{i + 1}
            </td>
            {columns.map((c) => (
              <td key={c.name} className={`border-b border-line border-r border-line/55 px-2.5 py-[6px]`}>
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

/** 属性子页：列结构一览（对齐用户与权限管理页的卡片表格语言）+ 结构编辑（新增/删除字段/双击编辑） */
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

  if (loading && meta.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载列结构…</div>
      </div>
    );

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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
      {/* 卡头：bar + 标题 + 列数 pill + 编辑提示 + 新增（对齐「用户与权限管理」卡头） */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent2" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">结构</span>
        <span className="shrink-0 rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-dim">
          {meta.length} 列
        </span>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{ddlMsg}</span>}
        <span className="min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.714)] text-dim2">双击 列名 / 类型 / 非空 / 默认值 / 注释 可直接编辑</span>
        <button onClick={onAdd} className="btn-primary shrink-0" title="新增字段（ALTER TABLE ADD COLUMN）">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          新增字段
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 固定布局 + 百分比列宽用内联 style：复用 dev 服务的 JIT 缓存可能停更，内联保证生效 */}
        <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '13%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '13%' }} />
            <col />
            <col style={{ width: '6%' }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-panel2">
              <th className="w-9 border-b-2 border-r border-line bg-panel px-1 py-1 text-right text-dim2">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">列名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">数据类型</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">标识</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">排序规则</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-center font-medium text-fg">非空</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">默认值</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">注释</th>
              <th className="whitespace-nowrap border-b-2 border-line bg-panel2 px-2 py-1 text-center font-medium text-fg">操作</th>
            </tr>
          </thead>
          <tbody>
            {meta.map((c) => {
              const isPk = c.key === 'PRI';
              return (
                <tr key={c.name} className="hover:bg-panel3/60">
                  <td className="border-b border-r border-line bg-panel px-1 py-[3px] text-right text-dim2 tabular-nums">{c.ordinal ?? ''}</td>
                  <td className="cursor-text border-b border-r border-line px-2 py-[3px] text-fg" {...startEdit(c, 'name', '修改列名（RENAME）')}>
                    {edit?.name === c.name && edit.field === 'name' ? (
                      <InlineInput field="name" initial={c.name} />
                    ) : (
                      <span className="flex items-center gap-1.5">
                        {isPk && <ColKeyIcon />}
                        <span className="truncate" title={c.name}>{c.name}</span>
                      </span>
                    )}
                  </td>
                  <td className="cursor-text border-b border-r border-line px-2 py-[3px] text-dim" {...startEdit(c, 'type', '修改数据类型（ALTER TYPE / MODIFY）')}>
                    {edit?.name === c.name && edit.field === 'type' ? (
                      <InlineTypeSelect
                        initial={shortTypeName(c.fullType ?? c.dataType)}
                        options={commonTypesFor(dialect)}
                        onCommit={(v) => void commit('type', v, c)}
                        onCancel={() => setEdit(null)}
                      />
                    ) : (
                      shortTypeName(c.fullType ?? c.dataType)
                    )}
                  </td>
                  <td className="border-b border-r border-line px-2 py-[3px]">
                    {c.extra === 'auto_increment' || c.extra === 'identity' ? (
                      <span className="rounded bg-accent/10 px-1 text-[length:calc(var(--pref-fs)*0.714)] leading-4 text-accent" title="自增/标识列">
                        {c.extra === 'identity' ? 'identity' : 'auto_inc'}
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                  <td className="border-b border-r border-line px-2 py-[3px] text-dim">
                    <span className="block truncate" title={c.collation ?? ''}>{c.collation ?? ''}</span>
                  </td>
                  <td
                    className="cursor-pointer border-b border-r border-line px-2 py-[3px] text-center"
                    onDoubleClick={() => { if (!isPk) setNullEdit(c.name); }}
                    title={isPk ? '主键列固定非空' : '双击切换 可空 / 非空'}
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
                    ) : isPk ? (
                      <span className="text-[length:calc(var(--pref-fs)*0.714)] text-warn">主键</span>
                    ) : c.nullable ? (
                      <span className="text-dim2">可空</span>
                    ) : (
                      <span className="text-dim">非空</span>
                    )}
                  </td>
                  <td
                    className="cursor-text border-b border-r border-line px-2 py-[3px] text-dim"
                    {...startEdit(c, 'default', '修改默认值（清空 = 移除默认值）')}
                  >
                    {edit?.name === c.name && edit.field === 'default' ? <InlineInput field="default" initial={c.defaultValue ?? ''} /> : <span className="block truncate">{c.defaultValue ?? ''}</span>}
                  </td>
                  <td
                    className="cursor-text border-b border-r border-line px-2 py-[3px] text-dim"
                    {...startEdit(c, 'comment', '修改注释（清空 = 清除注释）')}
                  >
                    {edit?.name === c.name && edit.field === 'comment' ? <InlineInput field="comment" initial={c.comment ?? ''} /> : <span className="block truncate" title={c.comment ?? ''}>{c.comment ?? ''}</span>}
                  </td>
                  <td className="border-b border-line px-2 py-[3px] text-center">
                    {/* tabIndex={-1}：行内操作不参与 Tab 键序；图标按钮替代红字，降低整页噪音 */}
                    <button
                      tabIndex={-1}
                      onClick={() => onDrop(c.name)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-prod/80 hover:bg-prod/10 hover:text-prod"
                      title={`删除字段 ${c.name}（ALTER TABLE DROP COLUMN，不可恢复）`}
                    >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
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

/** 表设计器「索引」子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
function IndexListView({ items, loading, error, ddlMsg, onReload, onAdd }: { items: DbIndex[]; loading: boolean; error: string | null; ddlMsg?: string | null; onReload: () => void; onAdd: () => void }) {
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
        <ErrorBox message={`加载索引失败：${error}`} onRetry={onReload} />
      </div>
    );
  if (loading && items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载索引…</div>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
      {/* 卡头：bar + 标题 + 索引数 pill + 操作结果提示 + 新增（对齐「用户与权限管理」卡头） */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent2" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">索引</span>
        <span className="shrink-0 rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-dim">
          {items.length} 个
        </span>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{ddlMsg}</span>}
        <button onClick={onAdd} className="btn-primary ml-auto shrink-0" title="新增索引（CREATE INDEX）">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          新增索引
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 固定布局 + 百分比列宽用内联 style：复用 dev 服务的 JIT 缓存可能停更，内联保证生效 */}
        <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '22%' }} />
            <col />
            <col style={{ width: '8%' }} />
            <col style={{ width: '10%' }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-panel2">
              <th className="w-9 border-b-2 border-r border-line bg-panel px-1 py-1 text-right text-dim2">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">索引名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">列</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-center font-medium text-fg">唯一</th>
              <th className="whitespace-nowrap border-b-2 border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">方法</th>
            </tr>
          </thead>
          <tbody>
            {items.map((ix, i) => (
              <tr key={ix.name} className="hover:bg-panel3/60">
                <td className="border-b border-r border-line bg-panel px-1 py-[3px] text-right text-dim2 tabular-nums">{i + 1}</td>
                <td className="border-b border-r border-line px-2 py-[3px] text-fg"><span className="block truncate" title={ix.name}>{ix.name}</span></td>
                <td className="border-b border-r border-line px-2 py-[3px] text-dim"><span className="block truncate" title={ix.columns.join(', ')}>{ix.columns.join(', ')}</span></td>
                <td className="border-b border-r border-line px-2 py-[3px] text-center">
                  {ix.unique ? <span className="rounded bg-accent/10 px-1 text-[length:calc(var(--pref-fs)*0.714)] leading-4 text-accent">唯一</span> : ''}
                </td>
                <td className="whitespace-nowrap border-b border-line px-2 py-[3px] text-dim">{ix.method ?? ''}</td>
              </tr>
            ))}
            {items.length === 0 && !loading && <tr><td colSpan={5} className="px-3 py-6 text-center text-dim2">无索引</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 表设计器「外键」子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
function ForeignKeyListView({ items, loading, error, ddlMsg, onReload, onAdd }: { items: DbForeignKey[]; loading: boolean; error: string | null; ddlMsg?: string | null; onReload: () => void; onAdd: () => void }) {
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
        <ErrorBox message={`加载外键失败：${error}`} onRetry={onReload} />
      </div>
    );
  if (loading && items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载外键…</div>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
      {/* 卡头：bar + 标题 + 外键数 pill + 操作结果提示 + 新增（对齐「用户与权限管理」卡头） */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent2" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">外键</span>
        <span className="shrink-0 rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-dim">
          {items.length} 个
        </span>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{ddlMsg}</span>}
        <button onClick={onAdd} className="btn-primary ml-auto shrink-0" title="新增外键（ALTER TABLE ADD CONSTRAINT … FOREIGN KEY）">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          新增外键
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 固定布局 + 百分比列宽用内联 style：复用 dev 服务的 JIT 缓存可能停更，内联保证生效 */}
        <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '17%' }} />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-panel2">
              <th className="w-9 border-b-2 border-r border-line bg-panel px-1 py-1 text-right text-dim2">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">约束名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">本表列</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">引用表</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">引用列</th>
              <th className="whitespace-nowrap border-b-2 border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">删除/更新</th>
            </tr>
          </thead>
          <tbody>
            {items.map((fk, i) => (
              <tr key={fk.name} className="hover:bg-panel3/60">
                <td className="border-b border-r border-line bg-panel px-1 py-[3px] text-right text-dim2 tabular-nums">{i + 1}</td>
                <td className="border-b border-r border-line px-2 py-[3px] text-fg"><span className="block truncate" title={fk.name}>{fk.name}</span></td>
                <td className="border-b border-r border-line px-2 py-[3px] text-dim"><span className="block truncate" title={fk.columns.join(', ')}>{fk.columns.join(', ')}</span></td>
                <td className="border-b border-r border-line px-2 py-[3px] text-fg">{fk.refTable}</td>
                <td className="border-b border-r border-line px-2 py-[3px] text-dim"><span className="block truncate" title={fk.refColumns.join(', ')}>{fk.refColumns.join(', ')}</span></td>
                <td className="whitespace-nowrap border-b border-line px-2 py-[3px] text-dim">{[fk.onDelete, fk.onUpdate].filter(Boolean).join(' / ')}</td>
              </tr>
            ))}
            {items.length === 0 && !loading && <tr><td colSpan={6} className="px-3 py-6 text-center text-dim2">无外键</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 表设计器「触发器」子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
function TriggerListView({ items, loading, error, ddlMsg, onReload, onAdd }: { items: DbTrigger[]; loading: boolean; error: string | null; ddlMsg?: string | null; onReload: () => void; onAdd: () => void }) {
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
        <ErrorBox message={`加载触发器失败：${error}`} onRetry={onReload} />
      </div>
    );
  if (loading && items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载触发器…</div>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
      {/* 卡头：bar + 标题 + 触发器数 pill + 操作结果提示 + 新建（对齐「用户与权限管理」卡头） */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent2" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">触发器</span>
        <span className="shrink-0 rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-dim">
          {items.length} 个
        </span>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{ddlMsg}</span>}
        <button onClick={onAdd} className="btn-primary ml-auto shrink-0" title="新建触发器（CREATE TRIGGER）">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
          新建触发器
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 固定布局 + 百分比列宽用内联 style：复用 dev 服务的 JIT 缓存可能停更，内联保证生效 */}
        <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '14%' }} />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-panel2">
              <th className="w-9 border-b-2 border-r border-line bg-panel px-1 py-1 text-right text-dim2">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">触发器名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">时机</th>
              <th className="whitespace-nowrap border-b-2 border-r border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">事件</th>
              <th className="whitespace-nowrap border-b-2 border-line bg-panel2 px-2 py-1 text-left font-medium text-fg">定义</th>
            </tr>
          </thead>
          <tbody>
            {items.map((tg, i) => (
              <tr key={tg.name} className="hover:bg-panel3/60">
                <td className="border-b border-r border-line bg-panel px-1 py-[3px] text-right text-dim2 tabular-nums">{i + 1}</td>
                <td className="border-b border-r border-line px-2 py-[3px] text-fg"><span className="block truncate" title={tg.name}>{tg.name}</span></td>
                <td className="whitespace-nowrap border-b border-r border-line px-2 py-[3px] text-dim">{tg.timing}</td>
                <td className="whitespace-nowrap border-b border-r border-line px-2 py-[3px] text-dim">{tg.events}</td>
                <td className="border-b border-line px-2 py-[3px] text-dim"><span className="block truncate" title={tg.body ?? ''}>{tg.body ?? '—'}</span></td>
              </tr>
            ))}
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-dim2">
                  无触发器
                  <button onClick={onAdd} className="ml-2 text-accent hover:underline" title="新建触发器（CREATE TRIGGER）">
                    新建一个
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

/** 表设计器「SQL 预览」子页：展示由元数据合成的 CREATE TABLE + 索引/外键/触发器（行号 + SQL 语法高亮，对齐「用户与权限管理」页卡片语言） */
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
  const lines = displayDdl.split('\n');
  /** 语句数（以分号计，便于感知这份 DDL 包含几段） */
  const stmtCount = (displayDdl.match(/;/g) ?? []).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
      {/* 卡头：bar + 标题 + 统计 pill + 复制（对齐「用户与权限管理」卡头） */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent2" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">SQL 预览</span>
        {!error && !loading && (
          <span className="shrink-0 rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-dim">
            {lines.length} 行 · {stmtCount} 条语句
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.714)] text-dim2">建表 DDL（由内省元数据合成）</span>
        <button
          onClick={() => void copy()}
          className={`shrink-0 text-[length:calc(var(--pref-fs)*0.786)] ${copied ? 'text-ok' : 'text-accent hover:underline'}`}
          title="复制到剪贴板"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* 代码区：行号列（横向滚动时吸附左侧）+ 不换行高亮代码 */}
      <div className="flex min-h-0 flex-1 overflow-auto bg-bg font-mono text-[length:calc(var(--pref-fs)*0.786)] leading-5">
        {!error && !loading && (
          <div className="sticky left-0 z-10 shrink-0 select-none border-r border-line bg-panel px-2 py-3 text-right text-dim2 tabular-nums">
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        )}
        <pre className="min-w-0 flex-1 whitespace-pre p-3 text-fg">
          {error ? <span className="text-prod">加载失败：{error}</span> : loading ? '生成中…' : highlightSql(displayDdl)}
        </pre>
      </div>
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

/**
 * 新建触发器对话框（触发器子页）：触发器名（留空自动生成 tg_{表}_{事件}）、
 * 时机（BEFORE/AFTER）、事件（INSERT/UPDATE/DELETE）、触发主体（SQL 文本域）。
 * MySQL：主体为 FOR EACH ROW 后的单条语句；PG：主体自动包成 plpgsql 触发器函数
 * （BEGIN … RETURN NEW; END），再 CREATE TRIGGER 挂到表上。
 * 提交后由父组件拼 CREATE TRIGGER 执行并刷新触发器列表。
 */
function AddTriggerDialog({ isPg, tableName, onCancel, onSubmit }: {
  isPg: boolean;
  tableName: string;
  onCancel: () => void;
  onSubmit: (name: string, timing: string, event: string, body: string) => void;
}) {
  const [name, setName] = useState('');
  const [timing, setTiming] = useState('BEFORE');
  const [event, setEvent] = useState('INSERT');
  const [body, setBody] = useState('');
  const autoName = () => name.trim() || `tg_${tableName}_${event.toLowerCase()}`;
  const canSubmit = body.trim().length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onCancel}>
      <div className="w-[480px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">新建触发器</div>
        <div className="grid grid-cols-[64px_1fr] items-start gap-x-2 gap-y-2 text-[length:calc(var(--pref-fs)*0.786)] text-dim">
          <span className="pt-1.5">触发器名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`留空自动生成 tg_${tableName}_…`}
            className={ddlInputCls}
          />
          <span className="pt-1.5">时机</span>
          <select value={timing} onChange={(e) => setTiming(e.target.value)} className={`${ddlInputCls} h-7`}>
            <option value="BEFORE">BEFORE（操作前）</option>
            <option value="AFTER">AFTER（操作后）</option>
          </select>
          <span className="pt-1.5">事件</span>
          <select value={event} onChange={(e) => setEvent(e.target.value)} className={`${ddlInputCls} h-7`}>
            <option value="INSERT">INSERT</option>
            <option value="UPDATE">UPDATE</option>
            <option value="DELETE">DELETE</option>
          </select>
          <span className="pt-1.5">定义</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={
              isPg
                ? '触发器函数体（自动包进 BEGIN…END），如：\nNEW.updated_at := now();'
                : 'FOR EACH ROW 后的单条 SQL，如：\nSET NEW.updated_at = NOW()'
            }
            className={`${ddlInputCls} h-auto resize-y py-1.5 font-mono leading-5`}
          />
        </div>
        <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
          将执行：
          {isPg ? (
            <>
              CREATE FUNCTION <span className="font-mono">{autoName()}_fn</span>() RETURNS trigger + CREATE TRIGGER <span className="font-mono">{autoName()}</span> {timing} {event} ON {tableName} FOR EACH ROW
            </>
          ) : (
            <>
              CREATE TRIGGER <span className="font-mono">{autoName()}</span> {timing} {event} ON {tableName} FOR EACH ROW …
            </>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="h-7 rounded border border-line px-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim hover:bg-panel3">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit(autoName(), timing, event, body)}
            className="h-7 rounded bg-accent px-3 text-[length:calc(var(--pref-fs)*0.786)] text-white hover:opacity-90 disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** SQL 查询标签页（CodeMirror 编辑器 + 分页结果集：默认按行数限制档位取回，滚动到底自动追加下一页） */

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
  /** 脚本运行结果（多语句逐条日志；单条语句仍走普通 run 的网格展示） */
  const [scriptResult, setScriptResult] = useState<ScriptResult | null>(null);
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
      setAiAnswer((prev) => prev || `错误：${(e as Error).message}`);
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
      if (!opts?.noHistory) pushHistory(text);
    } catch (e) {
      setError((e as Error).message);
      setColumns(null);
      setRows([]);
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
      const body = rows.map((r) => `| ${columns.map((c) => { const v = r[c.name]; return v === null || v === undefined ? '' : String(v); }).join(' | ')} |`);
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
      setError((e as Error).message);
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
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
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[length:calc(var(--pref-fs)*0.786)]">
          <ConnIcon kind={conn.kind} />
          <span className="font-medium text-fg">{conn.name}</span>
          <span className="rounded-full bg-panel3 px-1.5 py-px text-[9px] font-medium text-accent">{connKindLabel}</span>
          {/* 库切换紧跟连接信息（不再 ml-auto 推到最右），切库时鼠标不用横穿整个窗口 */}
          {dbOptions.length > 0 && (
            <span className="ml-1 flex items-center gap-1.5 border-l border-line pl-2.5">
              <span className="text-dim2">库</span>
              <select
                value={currentDb ?? ''}
                onChange={(e) => void switchDb(e.target.value)}
                className="cursor-pointer rounded-md border border-transparent bg-panel3 px-1.5 py-px text-[length:calc(var(--pref-fs)*0.714)] text-fg outline-none transition-colors hover:border-accent"
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
      <div className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-line bg-panel px-3 text-[length:calc(var(--pref-fs)*0.786)]">
        <button
          onClick={run}
          disabled={loading}
          className="flex h-6 items-center gap-1.5 rounded-md px-3.5 text-[length:calc(var(--pref-fs)*0.786)] font-semibold text-white transition-all hover:brightness-110 active:translate-y-px disabled:opacity-50"
          style={{ background: 'linear-gradient(140deg, rgb(var(--c-accent)), rgb(var(--c-accent2)))', boxShadow: '0 2px 8px rgb(var(--c-accent) / .28)' }}
          title="Ctrl/⌘+Enter：有选中时只执行选中文本，否则执行编辑器全文；@ai 开头交给 AI"
        >
          <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" /></svg>
          {loading ? '执行中…' : '运行'}
        </button>
        <button onClick={() => void runScriptAll()} disabled={loading} className="flex h-6 items-center rounded-md px-2.5 text-dim transition-colors hover:bg-panel3 hover:text-fg disabled:opacity-50" title="Ctrl/⌘+Shift+Enter：全文按语句切分逐条执行，结果区显示逐条日志">
          脚本运行
        </button>
        <button onClick={formatSql} disabled={loading} className="flex h-6 items-center rounded-md px-2.5 text-dim transition-colors hover:bg-panel3 hover:text-fg" title="格式化编辑器 SQL（有选中只格式化选中）">
          格式化
        </button>
        {conn?.kind !== 'oracle' && (
          <button onClick={() => void runExplain()} disabled={loading} className="flex h-6 items-center rounded-md px-2.5 text-dim transition-colors hover:bg-panel3 hover:text-fg disabled:opacity-50" title="EXPLAIN 当前语句（有选中只解释选中），以网格展示执行计划">
            解释计划
          </button>
        )}
        {history.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              const s = e.target.value;
              if (s) setEditorSql(s);
              e.target.value = '';
            }}
            className="h-6 w-[104px] shrink-0 cursor-pointer rounded-md border border-transparent bg-transparent px-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim outline-none transition-colors hover:border-line hover:bg-panel3 hover:text-fg"
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
        <span className="flex-1" />
      </div>
      {/* 筛选卡（对齐表数据页）：where / order by 一体化卡片，回车 = 包装基准 SQL 走真实查询；Esc/✕ 清空恢复全量 */}
      {columns && aiAsked === null && !scriptResult && (
        <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line bg-panel px-2.5">
          <FilterInput
            className="flex-[3]"
            value={resWhere}
            onChange={setResWhere}
            onSubmit={() => void rerunRes(resWhere.trim(), resOrderBy.trim())}
            onClear={() => {
              setResWhere('');
              void rerunRes('', resOrderBy.trim());
            }}
            fields={columns.map((c) => c.name)}
            keywords={['and', 'or', 'not', 'like', 'in', 'is null', 'is not null', 'between']}
            placeholder="条件，如 id = 1 and name like '%a%'"
            title="回车对当前结果追加 WHERE 条件（包装子查询走真实查询）；Esc 或 ✕ 清空恢复全量"
            label="where"
            icon={
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path d="M3 5h18l-7 8v5.5L10 21v-8L3 5Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
          <FilterInput
            className="flex-[2]"
            value={resOrderBy}
            onChange={setResOrderBy}
            onSubmit={() => void rerunRes(resWhere.trim(), resOrderBy.trim())}
            onClear={() => {
              setResOrderBy('');
              void rerunRes(resWhere.trim(), '');
            }}
            fields={columns.map((c) => c.name)}
            keywords={['asc', 'desc']}
            placeholder="如 created_at desc, id asc"
            title="回车对当前结果追加 ORDER BY（包装子查询走真实查询）；Esc 清空"
            label="order by"
            icon={
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                <path d="M7 4v13M4 14l3 3 3-3M17 20V7M14 10l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-panel">
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
            {/* Markdown 渲染（流式期间同样渲染，表格/代码块实时成型） */}
            {aiAnswer ? (
              <Markdown text={aiAnswer} />
            ) : (
              <pre className="whitespace-pre-wrap rounded border border-line bg-panel p-2 font-mono text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
                {aiStreaming ? '思考中…' : ''}
              </pre>
            )}
          </div>
        ) : scriptResult ? (
          /* 脚本运行日志：逐条状态 + 行数 + SELECT 前 5 行样例 */
          <div>
            <div className="flex h-7 items-center gap-2 border-b border-line px-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
              <span>脚本执行完成 · {scriptResult.statements.length} 条语句 · {scriptResult.totalMs}ms</span>
              {scriptResult.stoppedAt !== undefined && <span className="text-prod">· 在第 {scriptResult.stoppedAt} 条语句处停止</span>}
              <span className="ml-auto">（点击「运行」可切回网格视图）</span>
            </div>
            {scriptResult.statements.map((s) => (
              <div key={s.index} className="border-b border-line px-3 py-1.5 text-[length:calc(var(--pref-fs)*0.786)]">
                <div className="flex items-center gap-2">
                  <span className={s.ok ? 'text-ok' : 'text-prod'}>{s.ok ? '✓' : '✕'}</span>
                  <span className="w-8 shrink-0 text-dim2">#{s.index}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-fg" title={s.sql}>{s.sql.replace(/\s+/g, ' ').slice(0, 160)}</span>
                  {s.affectedRows !== undefined && <span className="shrink-0 text-dim2">影响 {s.affectedRows} 行</span>}
                  {s.rowCount !== undefined && <span className="shrink-0 text-dim2">{s.rowCount.toLocaleString()} 行</span>}
                  <span className="shrink-0 text-dim2">{s.elapsedMs}ms</span>
                </div>
                {s.error && <div className="ml-10 mt-1 text-prod">{s.error}</div>}
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
          /* 结果网格：复用表数据页的 EditableGrid（只读：无编辑/选区，仅表头点击排序） */
          <EditableGrid
            columns={columns}
            pkCols={[]}
            displayRows={resDisplayRows}
            newRows={[]}
            edits={EMPTY_EDITS}
            deleted={EMPTY_SET_NUM}
            editing={null}
            selected={selCell?.ri ?? null}
            curCol={selCell?.col ?? null}
            selRows={EMPTY_SET_NUM}
            selCols={EMPTY_SET_STR}
            editable={false}
            sort={resSort}
            onCellDblClick={() => {}}
            onCellChange={() => {}}
            onEditEnd={() => {}}
            onCommitShortcut={() => {}}
            onNewChange={() => {}}
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
          <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">执行 SQL 查看结果（Ctrl/⌘+Enter 运行 · 有选中只跑选中 · Ctrl/⌘+Shift+Enter 脚本运行 · 输入 @ai 提问让 AI 生成或查询）</div>
        )}
      </div>
      {/* 底部状态栏（对齐表数据页：刷新 / 导出 / 已载入行数 + 耗时） */}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
        <button onClick={() => void run()} disabled={loading} className="text-dim2 hover:text-fg disabled:opacity-40" title="重新执行当前语句">
          {loading ? '获取中…' : '刷新'}
        </button>
        <div className="h-3 w-px bg-line" />
        <button
          onClick={() => {
            if (!selCell) return;
            const v = rows[selCell.ri]?.[selCell.col];
            void navigator.clipboard?.writeText(v === null || v === undefined ? '' : String(v));
          }}
          disabled={!selCell}
          className="text-dim2 hover:text-fg disabled:opacity-40"
          title="复制选中单元格值"
        >
          复制
        </button>
        <div className="h-3 w-px bg-line" />
        <span className="relative">
          <button
            onClick={() => setExportOpen((o) => !o)}
            disabled={!columns || rows.length === 0}
            className={`text-dim2 hover:text-fg disabled:opacity-40 ${exportOpen ? 'text-fg' : ''}`}
            title="导出当前结果集（CSV / JSON / INSERT / Markdown）"
          >
            导出数据…
          </button>
          {exportOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[160px] rounded-md border border-line bg-panel p-1 shadow-xl">
              {([
                ['csv', 'CSV（Excel 可开）', '.csv'],
                ['json', 'JSON 数据', '.json'],
                ['insert', 'INSERT 语句', '.sql'],
                ['md', 'Markdown 表格', '.md'],
              ] as const).map(([k, label]) => (
                <button key={k} onClick={() => exportResult(k)} className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-fg hover:bg-panel3">
                  {label}
                </button>
              ))}
            </div>
          )}
        </span>
        <div className="h-3 w-px bg-line" />
        <select
          value={resLimit}
          onChange={(e) => {
            const lim = Number(e.target.value);
            setResLimit(lim);
            if (lastSqlRef.current) void runText(lastSqlRef.current, { lim });
          }}
          className="rounded border border-line bg-bg px-1 text-[length:calc(var(--pref-fs)*0.714)] text-dim outline-none"
          title="结果行数上限（修改后立即重新查询）"
        >
          {LIMITS.map((l) => (
            <option key={l} value={l}>{l}</option>
          ))}
        </select>
        {columns && !isDml ? (
          <>
            <div className="h-3 w-px bg-line" />
            {/* 真分页翻页（DBeaver 同款）：首页 / 上一页 / 页码 / 下一页（末页需已知总行数，不提供） */}
            <button onClick={() => void gotoResPage(0)} disabled={loading || resPage === 0} className="text-dim2 hover:text-fg disabled:opacity-40" title="第一页">⇤</button>
            <button onClick={() => void gotoResPage(resPage - 1)} disabled={loading || resPage === 0} className="text-dim2 hover:text-fg disabled:opacity-40" title="上一页">‹</button>
            <span className="shrink-0 tabular-nums">第 {resPage + 1} 页</span>
            <button onClick={() => void gotoResPage(resPage + 1)} disabled={loading || !hasMore} className="text-dim2 hover:text-fg disabled:opacity-40" title="下一页">›</button>
            <div className="h-3 w-px bg-line" />
            <span title={baseSqlRef.current}>
              <b className="font-semibold tabular-nums text-dim">{rows.length}</b> 行已获取
              {(resWhere.trim() || resOrderBy.trim()) ? '（已按条件筛选/排序）' : ''}
              {elapsedMs > 0 ? ` · ${(elapsedMs / 1000).toFixed(3)}s` : ''}
              {fetchedAt ? ` · ${fetchedAt}` : ''}
            </span>
            {/* 当前单元格坐标（行=筛选排序后的展示序，列=列序），无选中时不显示，对齐表数据页 */}
            {selCell != null && (
              <span className="ml-auto shrink-0 tabular-nums">
                行 {resDisplayRows.findIndex((e) => e.ri === selCell.ri) + 1}, 列 {columns.findIndex((c) => c.name === selCell.col) + 1}
              </span>
            )}
          </>
        ) : isDml ? (
          <>
            <div className="h-3 w-px bg-line" />
            <span>写操作执行成功 · {elapsedMs}ms</span>
          </>
        ) : null}
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

/** 触发浏览器下载（结果导出共用） */
function downloadFile(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 只读结果网格复用 EditableGrid 时的空状态常量（避免每次渲染新建对象） */
const EMPTY_EDITS: Record<string, string> = {};
const EMPTY_SET_NUM = new Set<number>();
const EMPTY_SET_STR = new Set<string>();


/** 视图/函数/存储过程 定义标签页（委托给 RoutineStudio：PL/SQL 高亮 + 参数执行 + 调试） */
function DefTab({ connId, kind, pgDb, schema, name }: { connId: string; kind: 'view' | 'mview' | 'function' | 'procedure'; pgDb?: string; schema: string; name: string }) {
  // 单击树上「函数/存储过程」分类打开的浏览器（name 为空 = 清单模式：左清单 + 右选中定义）
  if (!name && (kind === 'function' || kind === 'procedure')) {
    return <RoutineBrowserTab connId={connId} kind={kind} pgDb={pgDb} schema={schema} />;
  }
  return <RoutineStudio connId={connId} pgDb={pgDb} schema={schema} name={name} kind={kind} />;
}

/** ══════ 函数/存储过程 浏览器：左清单 + 右选中对象的 RoutineStudio（对齐序列浏览器双栏布局） ══════ */
function RoutineBrowserTab({ connId, kind, pgDb, schema }: { connId: string; kind: 'function' | 'procedure'; pgDb?: string; schema: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState('');
  const [kw, setKw] = useState('');
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const dialectLabel = conn?.kind === 'oracle' ? 'Oracle' : conn?.kind === 'mysql' ? 'MySQL' : 'PostgreSQL';
  const label = kind === 'function' ? '函数' : '存储过程';

  /** 拉取本 schema 全部函数/存储过程名 */
  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const ns = await api.listObjects(connId, kind, schema, pgDb);
      setNames(ns);
      setSel((s) => (ns.includes(s) ? s : ns[0] ?? ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, kind, schema, pgDb]);

  const k = kw.trim().toLowerCase();
  const filtered = names.filter((n) => !k || n.toLowerCase().includes(k));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">
      {/* ══ 页头卡：与用户/对象清单页统一 PageHeaderCard ══ */}
      <PageHeaderCard
        icon={
          kind === 'function' ? (
            <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M8 6 3 12l5 6M16 6l5 6-5 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )
        }
        title={label}
        subtitle={
          <>
            <span className="shrink-0 rounded bg-accent2/10 px-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium leading-[18px] text-accent2">{dialectLabel}</span>
            <span className="truncate font-mono">{schema}</span>
            {!loading && !error && <span className="truncate">{filtered.length}{k ? ` / ${names.length}` : ''} 个{label}</span>}
          </>
        }
        search={{ value: kw, onChange: setKw, placeholder: `筛选${label}名…` }}
        actions={
          <button onClick={() => void loadAll()} disabled={loading} className="btn shrink-0" title={`重新读取${label}列表`}>
            <svg className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            刷新
          </button>
        }
      />

      {/* 双栏：左清单 + 右选中定义 */}
      <div className="flex min-h-0 flex-1 gap-2.5 overflow-hidden">
        {/* 左：清单 */}
        <div className="flex w-[260px] shrink-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
          <div className="min-h-0 flex-1 overflow-auto">
            {error ? (
              <ErrorBox message={error} onRetry={() => void loadAll()} />
            ) : loading ? (
              <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载{label}列表…</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
                {names.length === 0 ? `该 schema 下没有${label}` : '无匹配项'}
              </div>
            ) : (
              <table className="w-full table-fixed border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-panel2 text-left text-[length:calc(var(--pref-fs)*0.714)] tracking-wide text-dim">
                    <th className="border-b border-line2 px-3 py-1.5 font-medium">名称</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((n) => {
                    const on = n === sel;
                    return (
                      <tr
                        key={n}
                        onClick={() => setSel(n)}
                        className={`cursor-pointer border-b border-line transition-colors ${on ? 'bg-accent/10 hover:bg-accent/15' : 'hover:bg-panel3'}`}
                      >
                        <td className="truncate px-3 py-1.5 font-mono text-fg" title={n}>
                          {n}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* 右：选中对象的定义编辑器（RoutineStudio 内嵌，选中切换时重挂载） */}
        {sel ? (
          <RoutineStudio key={sel} connId={connId} pgDb={pgDb} schema={schema} name={sel} kind={kind} embedded />
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center rounded-[10px] border border-line bg-panel text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
            请选择左侧{label}
          </div>
        )}
      </div>
    </div>
  );
}

/** ══════ 新建序列弹窗：名称 + 起始/步长/最小/最大/循环，未填项取库默认，按方言拼 CREATE SEQUENCE ══════ */
function CreateSeqDialog({
  schema,
  isPg,
  busy,
  onClose,
  onSubmit,
}: {
  schema: string;
  isPg: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, sql: string) => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('1');
  const [inc, setInc] = useState('1');
  const [minv, setMinv] = useState('');
  const [maxv, setMaxv] = useState('');
  const [cycle, setCycle] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  /** 仅接受非负整数；空串返回 '' */
  const num = (s: string) => (/^\d+$/.test(s.trim()) ? s.trim() : '');

  const buildSql = (): string => {
    const seq = schema ? `${schema}.${name.trim()}` : name.trim();
    const parts = [`CREATE SEQUENCE ${seq}`];
    const st = num(start);
    if (st && st !== '1') parts.push(isPg ? `START ${st}` : `START WITH ${st}`);
    const ic = num(inc);
    if (ic && ic !== '1') parts.push(isPg ? `INCREMENT ${ic}` : `INCREMENT BY ${ic}`);
    const mn = num(minv);
    if (mn) parts.push(`MINVALUE ${mn}`);
    const mx = num(maxv);
    if (mx) parts.push(`MAXVALUE ${mx}`);
    if (cycle) parts.push('CYCLE');
    return parts.join(' ');
  };
  const sql = name.trim() ? buildSql() : '';

  const rows: [string, string, string, (v: string) => void][] = [
    ['起始值', start, '默认 1', setStart],
    ['步长', inc, '默认 1', setInc],
    ['最小值', minv, '库默认', setMinv],
    ['最大值', maxv, '库默认', setMaxv],
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className="w-[400px] overflow-hidden rounded-[10px] border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3.5">
          <div className="text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-fg">新建序列</div>
          <div className="mt-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim">
            <span className="font-mono">{schema}</span> · 未填写的选项取数据库默认值
          </div>
        </div>
        <div className="space-y-2 px-4 pt-3">
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-right text-[12px] text-dim">名称</span>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
                if (e.key === 'Enter' && name.trim() && !busy) onSubmit(name.trim(), sql);
              }}
              placeholder="序列名"
              spellCheck={false}
              className="ipt w-full flex-1 text-[12px]"
            />
          </div>
          {rows.map(([label, val, ph, set]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-right text-[12px] text-dim">{label}</span>
              <input
                value={val}
                onChange={(e) => set(e.target.value)}
                placeholder={ph}
                spellCheck={false}
                className="ipt w-full flex-1 text-[12px]"
              />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0" />
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-dim">
              <input
                type="checkbox"
                checked={cycle}
                onChange={(e) => setCycle(e.target.checked)}
                className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
              />
              循环（取值耗尽后回到最小值）
            </label>
          </div>
          {sql && (
            <div className="rounded-md bg-bg px-2.5 py-1.5 font-mono text-[length:calc(var(--pref-fs)*0.714)] leading-relaxed text-dim" title="将执行的 SQL">
              {sql}
            </div>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2 border-t border-line px-4 py-3">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary disabled:opacity-40" disabled={!name.trim() || busy} onClick={() => onSubmit(name.trim(), sql)}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 序列标签页（序列浏览器：当前值/上下限/步长 + 下一个值） */
function SequenceTab({ connId, pgDb, schema, name }: { connId: string; pgDb?: string; schema: string; name: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [infos, setInfos] = useState<Record<string, DbSequenceInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string>(name);
  const [kw, setKw] = useState('');
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 新建序列弹窗开关 */
  const [createOpen, setCreateOpen] = useState(false);
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const isMysql = conn?.kind === 'mysql';
  const isPg = conn?.kind === 'postgres';
  const dialectLabel = conn?.kind === 'oracle' ? 'Oracle' : conn?.kind === 'mysql' ? 'MySQL' : 'PostgreSQL';

  /** 拉取本 schema 全部序列名 + 逐个详情（序列数量通常很少，并行预取） */
  const loadAll = async () => {
    setLoading(true);
    setError(null);
    setMsg(null);
    try {
      const ns = await api.listObjects(connId, 'sequence', schema, pgDb);
      setNames(ns);
      const got: Record<string, DbSequenceInfo> = {};
      await Promise.all(
        ns.map(async (n) => {
          try {
            got[n] = await api.getSequenceInfo(connId, schema, n, pgDb);
          } catch {
            /* 单个序列读取失败不影响其余展示 */
          }
        }),
      );
      setInfos(got);
      if (!ns.includes(sel) && ns.length) setSel(ns[0]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, schema, pgDb]);

  const k = kw.trim().toLowerCase();
  const filtered = names.filter((n) => !k || n.toLowerCase().includes(k));
  const info = infos[sel] ?? null;

  /** 预测的下一个值（当前值 + 步长；从未调用则用最小值兜底） */
  const predictNext = (): string => {
    if (!info) return '—';
    const base = info.currentValue ?? info.minValue ?? 0;
    const step = info.increment ?? 1;
    return String(base + step);
  };

  /** 取下一个值（PG：nextval；Oracle：.NEXTVAL），并刷新该序列详情 */
  const takeNext = async () => {
    if (!info || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const seq = schema ? `${schema}.${sel}` : sel;
      const sql = isPg ? `SELECT nextval('${seq.replace(/'/g, "''")}') AS v` : `SELECT ${seq}.NEXTVAL AS v FROM dual`;
      const r = await api.runSql(connId, sql, pgDb || undefined);
      const v = r.rows[0]?.v;
      const refreshed = await api.getSequenceInfo(connId, schema, sel, pgDb);
      setInfos((m) => ({ ...m, [sel]: refreshed }));
      setMsg({ text: `下一个值：${v}` });
    } catch (e) {
      setMsg({ text: `获取失败：${(e as Error).message}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  /** 设置当前值（PG：setval；Oracle：ALTER SEQUENCE ... RESTART START WITH） */
  const setCurrent = async () => {
    if (!info || busy) return;
    const input = await promptDialog({
      title: `设置 ${sel} 的当前值：`,
      value: String(info.currentValue ?? info.minValue ?? 0),
      placeholder: '整数',
    });
    if (input == null) return;
    const v = Number(input);
    if (!Number.isFinite(v)) {
      setMsg({ text: '请输入有效数字', err: true });
      return;
    }
    setBusy(true);
    try {
      const seq = schema ? `${schema}.${sel}` : sel;
      const sql = isPg
        ? `SELECT setval('${seq.replace(/'/g, "''")}', ${v})`
        : `ALTER SEQUENCE ${seq} RESTART START WITH ${v}`;
      await api.runSql(connId, sql, pgDb || undefined);
      const refreshed = await api.getSequenceInfo(connId, schema, sel, pgDb);
      setInfos((m) => ({ ...m, [sel]: refreshed }));
      setMsg({ text: `已将当前值设为 ${v}` });
    } catch (e) {
      setMsg({ text: `设置失败：${(e as Error).message}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!info || busy) return;
    const nn = await promptDialog({ title: '重命名序列为：', value: sel, placeholder: '新序列名' });
    if (nn == null || !nn || nn === sel) return;
    setBusy(true);
    try {
      await api.renameObject(connId, 'sequence', schema, sel, nn, pgDb);
      setNames((ns) => ns.map((x) => (x === sel ? nn : x)));
      setSel(nn);
      setMsg({ text: `已重命名为 ${nn}` });
    } catch (e) {
      setMsg({ text: `重命名失败：${(e as Error).message}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  const drop = async () => {
    if (!info || busy) return;
    if (!window.confirm(`确认删除序列 ${schema ? schema + '.' : ''}${sel}？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await api.dropObject(connId, 'sequence', schema, sel, pgDb);
      const ns = names.filter((x) => x !== sel);
      setNames(ns);
      setSel(ns[0] ?? '');
      setMsg({ text: `已删除 ${sel}` });
    } catch (e) {
      setMsg({ text: `删除失败：${(e as Error).message}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  /** 执行 CREATE SEQUENCE（SQL 由弹窗按方言拼好）；失败保留弹窗便于修正 */
  const submitCreate = async (nn: string, sql: string) => {
    setBusy(true);
    try {
      await api.runSql(connId, sql, pgDb || undefined);
      setMsg({ text: `已创建 ${nn}` });
      setCreateOpen(false);
      await loadAll();
      setSel(nn);
    } catch (e) {
      setMsg({ text: `创建失败：${(e as Error).message}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  if (isMysql) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-fg">MySQL 不支持序列对象</div>
        <div className="text-[length:calc(var(--pref-fs)*0.786)] text-dim">MySQL 使用 AUTO_INCREMENT 自增列替代序列，请在表结构中查看自增列。</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">
      {/* ══ 页头卡：与用户/函数浏览器统一 PageHeaderCard ══ */}
      <PageHeaderCard
        icon={
          <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path d="M4 7h9M4 12h13M4 17h9" strokeLinecap="round" />
            <path d="m16.5 5 2.5 2-2.5 2M16.5 15l2.5 2-2.5 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
        title="序列"
        subtitle={
          <>
            <span className="shrink-0 rounded bg-accent2/10 px-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium leading-[18px] text-accent2">{dialectLabel}</span>
            <span className="truncate font-mono">{schema}</span>
            {!loading && !error && <span className="truncate">{filtered.length}{k ? ` / ${names.length}` : ''} 个序列</span>}
          </>
        }
        search={{ value: kw, onChange: setKw, placeholder: '筛选序列名…' }}
        actions={
          <>
            {msg && <span className={`shrink-0 text-[length:calc(var(--pref-fs)*0.786)] ${msg.err ? 'text-prod' : 'text-ok'}`}>{msg.text}</span>}
            <button onClick={() => void loadAll()} disabled={loading} className="btn shrink-0" title="重新读取序列列表">
              <svg className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              刷新
            </button>
            <button onClick={() => setCreateOpen(true)} disabled={busy} className="btn-primary shrink-0" title="新建序列">
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              新建序列
            </button>
          </>
        }
      />

      {/* 双栏：左序列清单 + 右选中详情 */}
      <div className="flex min-h-0 flex-1 gap-2.5 overflow-hidden">
        {/* 左：序列清单 */}
        <div className="flex min-w-0 flex-[1.6] flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
          <div className="min-h-0 flex-1 overflow-auto">
            {error ? (
              <ErrorBox message={error} onRetry={() => void loadAll()} />
            ) : loading ? (
              <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载序列列表…</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
                {names.length === 0 ? '该 schema 下没有序列' : '无匹配序列'}
              </div>
            ) : (
              <table className="w-full table-fixed border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
                <colgroup>
                  <col className="w-[42%]" />
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead className="sticky top-0 z-10">
                  <tr className="bg-panel2 text-left text-[length:calc(var(--pref-fs)*0.714)] tracking-wide text-dim">
                    <th className="border-b border-line2 px-3 py-1.5 font-medium">序列名</th>
                    <th className="border-b border-line2 px-3 py-1.5 text-right font-medium">当前值</th>
                    <th className="border-b border-line2 px-3 py-1.5 text-right font-medium">步长</th>
                    <th className="border-b border-line2 px-3 py-1.5 text-center font-medium">循环</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((n) => {
                    const si = infos[n];
                    const on = n === sel;
                    return (
                      <tr
                        key={n}
                        onClick={() => setSel(n)}
                        className={`cursor-pointer border-b border-line transition-colors ${on ? 'bg-accent/10 hover:bg-accent/15' : 'hover:bg-panel3'}`}
                      >
                        <td className="truncate px-3 py-1.5 font-mono text-fg">{n}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-fg">{si ? (si.currentValue == null ? '—' : si.currentValue) : ''}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-dim">{si ? (si.increment ?? '—') : ''}</td>
                        <td className="px-3 py-1.5 text-center text-dim">{si ? (si.cycle ? '是' : '否') : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* 右：选中序列详情 */}
        <div className="flex min-w-[320px] max-w-[460px] flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
          {!info ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
              {sel ? '读取序列信息失败' : '请选择左侧序列'}
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b border-line px-4 py-3">
                <div className="truncate font-mono text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-fg">{sel}</div>
                <div className="mt-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim">{schema}</div>
                <div className="mt-2.5 flex items-baseline gap-2 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
                  下一个值
                  <b className="font-mono text-[20px] font-semibold leading-none tabular-nums text-fg">{predictNext()}</b>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                <div className="mb-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim">属性</div>
                <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
                  <tbody>
                    {[
                      ['当前值', info.currentValue == null ? '（尚未调用）' : String(info.currentValue)],
                      ['最小值', info.minValue == null ? '—' : String(info.minValue)],
                      ['最大值', info.maxValue == null ? '—' : String(info.maxValue)],
                      ['步长（增量）', info.increment == null ? '—' : String(info.increment)],
                      ['循环', info.cycle ? '是' : '否'],
                    ].map(([k2, v2]) => (
                      <tr key={k2} className="border-b border-line last:border-b-0">
                        <td className="w-[45%] py-1.5 text-dim">{k2}</td>
                        <td className="py-1.5 font-mono tabular-nums text-fg">{v2}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex shrink-0 items-center gap-1 border-t border-line bg-panel2 px-3 py-2">
                <button onClick={() => void takeNext()} disabled={busy} className="flex h-6 shrink-0 items-center rounded px-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim2 transition-colors hover:bg-panel hover:text-fg disabled:opacity-40" title="推进序列并取回下一个值">
                  取下一个值
                </button>
                <button onClick={() => void setCurrent()} disabled={busy} className="flex h-6 shrink-0 items-center rounded px-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim2 transition-colors hover:bg-panel hover:text-fg disabled:opacity-40">
                  设置当前值…
                </button>
                <button onClick={() => void rename()} disabled={busy} className="flex h-6 shrink-0 items-center rounded px-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim2 transition-colors hover:bg-panel hover:text-fg disabled:opacity-40">
                  重命名
                </button>
                <button onClick={() => void drop()} disabled={busy} className="ml-auto flex h-6 shrink-0 items-center rounded px-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim2 transition-colors hover:bg-prod/10 hover:text-prod disabled:opacity-40">
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 新建序列弹窗 */}
      {createOpen && (
        <CreateSeqDialog
          schema={schema}
          isPg={isPg}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onSubmit={(n, sql) => void submitCreate(n, sql)}
        />
      )}
    </div>
  );
}

/** ══════ 用户与权限管理 · 对齐设计稿的组件 ══════ */

/** 头像：首字母 + 按名字哈希取渐变底色；内置账号为虚线灰底 */
const AVATAR_GRADS: [string, string][] = [
  ['#60a5fa', '#3b82f6'], ['#a78bfa', '#7c3aed'], ['#34d399', '#10b981'],
  ['#fbbf24', '#f59e0b'], ['#f87171', '#ef4444'], ['#38bdf8', '#0284c7'],
];
function UserAvatar({ name, builtin, size = 26 }: { name: string; builtin?: boolean; size?: number }) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const [ca, cb] = AVATAR_GRADS[h % AVATAR_GRADS.length];
  const style: React.CSSProperties = builtin
    ? { background: 'rgb(var(--c-panel2))', color: 'rgb(var(--c-dim))', border: '1px dashed rgb(var(--c-line2))' }
    : { background: `linear-gradient(135deg, ${ca}, ${cb})` };
  return (
    <span className="flex shrink-0 items-center justify-center rounded-lg font-semibold text-white" style={{ ...style, width: size, height: size, fontSize: Math.round(size * 0.42) }}>
      {(name[0] ?? '?').toUpperCase()}
    </span>
  );
}

/** 列表布尔格：褒义 ✓（绿圆底）/ 灰破折号 */
function UFlag({ v }: { v?: boolean }) {
  if (v === undefined) return <span className="text-dim2">?</span>;
  if (!v) return <span className="text-dim2">—</span>;
  return (
    <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-ok/15 text-ok">
      <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** 状态胶囊（锁定=warn 锁图标 / 过期=prod 警叹号，文字明示坏状态） */
function StatePill({ tone, children }: { tone: 'warn' | 'prod'; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-[19px] items-center gap-1 rounded-full px-2 text-[length:calc(var(--pref-fs)*0.643)] font-medium ${tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-prod/15 text-prod'}`}>
      <svg className="h-2.5 w-2.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        {tone === 'warn'
          ? <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>
          : <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />}
      </svg>
      {children}
    </span>
  );
}

/** 拨杆开关（账户属性编辑；tone 决定打开态颜色：正常=ok / 锁定=warn / 过期=prod） */
function Switch({ on, onChange, tone = 'ok', disabled }: { on: boolean; onChange: (v: boolean) => void; tone?: 'ok' | 'warn' | 'prod'; disabled?: boolean }) {
  const onBg = tone === 'ok' ? 'rgb(var(--c-ok))' : tone === 'warn' ? 'rgb(var(--c-warn))' : 'rgb(var(--c-prod))';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={on ? '点击关闭' : '点击打开'}
      className="relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: on ? onBg : 'rgb(var(--c-line2))' }}
    >
      <span
        className="absolute left-[2px] top-[2px] h-[13px] w-[13px] rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: on ? 'translateX(13px)' : 'translateX(0)' }}
      />
    </button>
  );
}

/** 概览统计卡（页头下方一排四张） */
function StatCard({ dot, label, value, trend }: { dot: string; label: string; value: number; trend: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-[10px] border border-line bg-panel px-4 py-2.5">
      <span className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim">
        <span className={`h-[7px] w-[7px] rounded-full ${dot}`} />
        {label}
      </span>
      <span className="text-[length:calc(var(--pref-fs)*1.429)] font-semibold leading-6 tabular-nums text-fg">{value}</span>
      <span className="truncate text-[length:calc(var(--pref-fs)*0.643)] text-dim2" title={trend}>{trend}</span>
    </div>
  );
}

/** 用户与权限管理标签页（PG 角色 / MySQL 用户 / Oracle 用户：列表 + 权限查看 + 新建/删除） */
function UsersTab({ connId }: { connId: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const dialect = conn?.kind ?? 'postgres';
  const isMysql = dialect === 'mysql';
  const isOra = dialect === 'oracle';
  const isPg = dialect === 'postgres';
  const [users, setUsers] = useState<DbUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DbUser | null>(null);
  const [privs, setPrivs] = useState<DbUserPrivilege[]>([]);
  const [privLoading, setPrivLoading] = useState(false);
  const [privError, setPrivError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [kw, setKw] = useState('');

  /** 账户搜索（用户名 / 主机，均不区分大小写） */
  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase();
    if (!k) return users;
    return users.filter((u) => u.name.toLowerCase().includes(k) || (u.host ?? '').toLowerCase().includes(k));
  }, [users, kw]);

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
    if (u.builtin) {
      window.alert(`「${u.name}」是数据库内置保留账号，由服务器管理，不能删除。`);
      return;
    }
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

  const builtinCount = users.filter((u) => u.builtin).length;
  const superCount = users.filter((u) => u.superuser).length;
  const loginCount = users.filter((u) => u.canLogin).length;
  const abnormCount = users.filter((u) => u.locked || u.expired).length;
  const superNames = users.filter((u) => u.superuser).map((u) => u.name);
  const dialectLabel = isOra ? 'Oracle' : isMysql ? 'MySQL' : 'PostgreSQL';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">
      {/* ══ 页头卡：图标 + 标题概览 + 搜索 / 刷新 / 新建（统一 PageHeaderCard） ══ */}
      <PageHeaderCard
        icon={
          <svg className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M17 8V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-2" />
            <path d="M21 12H9m0 0 3-3m-3 3 3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
        title="用户与权限管理"
        subtitle={
          <>
            <span className="shrink-0 rounded bg-accent2/10 px-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium leading-[18px] text-accent2">{dialectLabel}</span>
            {!loading && !error && (
              <span className="truncate">
                {users.length} 个账户 · {superCount} 个超级用户 · {builtinCount} 个内置保留账号
              </span>
            )}
          </>
        }
        search={{ value: kw, onChange: setKw, placeholder: '搜索用户名 / 主机…' }}
        actions={
          <>
            <button onClick={() => void load()} disabled={loading} className="btn shrink-0" title="重新读取账户列表">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              刷新
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary shrink-0">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              新建用户
            </button>
          </>
        }
      />

      {/* ══ 概览统计 ══ */}
      {!loading && !error && users.length > 0 && (
        <div className="grid shrink-0 grid-cols-4 gap-2.5">
          <StatCard dot="bg-accent" label="全部账户" value={users.length} trend={builtinCount > 0 ? `含 ${builtinCount} 个内置账号` : '全部为业务账号'} />
          <StatCard dot="bg-ok" label="可登录" value={loginCount} trend={users.length - loginCount > 0 ? `${users.length - loginCount} 个禁止登录` : '全部处于活跃状态'} />
          <StatCard dot="bg-ai" label="超级用户" value={superCount} trend={superNames.length ? superNames.slice(0, 3).join('、') + (superNames.length > 3 ? ' …' : '') : '无'} />
          <StatCard dot="bg-warn" label="锁定 / 过期" value={abnormCount} trend={abnormCount > 0 ? '存在需处理的账号' : '无异常账号'} />
        </div>
      )}

      {/* ══ 主体两栏 ══ */}
      <div className="flex min-h-0 flex-1 gap-2.5">
        {/* 左：账户列表卡 */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5">
            <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent2" />
            <span className="text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">账户列表</span>
            <span className="rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-dim">
              {shown.length} / {users.length}
            </span>
            <span className="min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.714)] text-dim2">点击行查看并编辑权限</span>
            {superCount > 0 && (
              <span className="shrink-0 rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 text-dim">superuser {superCount}</span>
            )}
          </div>
          {error ? (
            <ErrorBox message={error} onRetry={() => void load()} />
          ) : loading ? (
            <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">加载用户…</div>
          ) : users.length === 0 ? (
            <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">（无用户）</div>
          ) : shown.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
              无匹配「{kw}」的账户
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              {/* 固定布局 + 百分比列宽用内联 style：Tailwind 的 table-fixed/w-[12%] 在长期复用的 dev 服务里可能不生成（JIT 缓存停更），内联样式保证生效 */}
              <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: isMysql ? '24%' : '30%' }} />
                  {isMysql && <col style={{ width: '12%' }} />}
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '24%' }} />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-panel2 text-dim2">
                  <tr className="border-b border-line2">
                    <th className="px-3.5 py-2 text-left font-normal">用户名</th>
                    {isMysql && <th className="px-3.5 py-2 text-left font-normal">主机</th>}
                    <th className="px-2 py-2 text-center font-normal">可登录</th>
                    <th className="px-2 py-2 text-center font-normal">超级用户</th>
                    <th className="px-2 py-2 text-center font-normal">锁定</th>
                    <th className="px-2 py-2 text-center font-normal">口令过期</th>
                    <th className="px-3.5 py-2 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((u) => {
                    const on = selected?.name === u.name && selected?.host === u.host;
                    return (
                      <tr
                        key={`${u.name}@${u.host ?? ''}`}
                        onClick={() => void viewPrivs(u)}
                        className={`cursor-pointer border-b border-line transition-colors hover:bg-panel2/60 ${on ? 'bg-accent/8' : ''}`}
                        style={on ? { boxShadow: 'inset 2px 0 0 rgb(var(--c-accent2))' } : undefined}
                      >
                        <td className="px-3.5 py-2">
                          <span className="flex items-center gap-2.5">
                            <UserAvatar name={u.name} builtin={u.builtin} />
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate font-mono font-medium text-fg">{u.name}</span>
                                {u.builtin && (
                                  <span className="shrink-0 rounded border border-line2/70 bg-panel2 px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-dim2" title="数据库内置保留账号，由服务器管理，不可编辑或删除">
                                    内置
                                  </span>
                                )}
                                {u.superuser && (
                                  <span className="shrink-0 rounded bg-ai/15 px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 font-medium text-ai">超管</span>
                                )}
                              </span>
                              {!isMysql && u.host && <span className="block truncate font-mono text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-dim2">@{u.host}</span>}
                            </span>
                          </span>
                        </td>
                        {isMysql && <td className="px-3.5 py-2 font-mono text-dim">{u.host}</td>}
                        <td className="px-2 py-2 text-center"><UFlag v={u.canLogin} /></td>
                        <td className="px-2 py-2 text-center">
                          {u.superuser
                            ? <span className="rounded bg-ai/15 px-1.5 text-[length:calc(var(--pref-fs)*0.643)] font-medium leading-4 text-ai">特权</span>
                            : <span className="text-dim2">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center">{u.locked ? <StatePill tone="warn">已锁定</StatePill> : <span className="text-dim2">—</span>}</td>
                        <td className="px-2 py-2 text-center">{u.expired ? <StatePill tone="prod">已过期</StatePill> : <span className="text-dim2">—</span>}</td>
                        <td className="px-3.5 py-2">
                          {/* tabIndex={-1}：行内操作按钮不参与 Tab 键序 */}
                          <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                            <button
                              tabIndex={-1}
                              onClick={(e) => { e.stopPropagation(); void viewPrivs(u); }}
                              title={`查看 ${u.name} 的权限`}
                              className="flex h-[22px] items-center gap-1 rounded-md border border-line px-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim transition-colors hover:bg-panel2 hover:text-fg"
                            >
                              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" strokeLinejoin="round" />
                              </svg>
                              权限
                            </button>
                            <button
                              tabIndex={-1}
                              onClick={(e) => { e.stopPropagation(); void del(u); }}
                              disabled={u.builtin}
                              title={u.builtin ? '内置保留账号不可删除' : `删除 ${u.name}`}
                              className="flex h-[22px] items-center gap-1 rounded-md border border-line px-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim transition-colors hover:border-prod/40 hover:bg-prod/10 hover:text-prod disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                                <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 右：权限面板卡 */}
        {selected && (
          <aside className="flex w-[38%] min-w-[340px] max-w-[500px] shrink-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-line px-4 py-3">
              <UserAvatar name={selected.name} builtin={selected.builtin} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">{selected.name}</span>
                  {selected.builtin && (
                    <span className="shrink-0 rounded border border-line2/70 bg-panel2 px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-dim2">内置</span>
                  )}
                  {selected.superuser && (
                    <span className="shrink-0 rounded bg-ai/15 px-1 text-[length:calc(var(--pref-fs)*0.643)] font-medium leading-4 text-ai">超级用户</span>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-[length:calc(var(--pref-fs)*0.714)] text-dim">
                  {selected.host ? `${selected.name}@${selected.host}` : selected.name} · {dialectLabel}{isPg ? ' 角色' : ' 用户'}{selected.canLogin ? ' · 可登录' : ''}
                </div>
              </div>
              <button
                onClick={() => void viewPrivs(selected)}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-line text-dim2 transition-colors hover:bg-panel2 hover:text-fg"
                title="刷新权限"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={() => setSelected(null)}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-line text-dim2 transition-colors hover:bg-panel2 hover:text-fg"
                title="关闭权限面板"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {privError ? (
              <div className="p-3.5 text-[length:calc(var(--pref-fs)*0.714)] text-prod">
                {privError}
                <button onClick={() => void viewPrivs(selected)} className="ml-2 text-accent hover:underline">重试</button>
              </div>
            ) : privLoading ? (
              <div className="p-3.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">加载权限…</div>
            ) : (
              <PrivEditor
                connId={connId}
                kind={dialect}
                user={selected}
                privs={privs}
                users={users}
                onApplied={() => { void viewPrivs(selected); void load(); }}
              />
            )}
          </aside>
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
 * 权限编辑器（右栏卡内容 + 底部执行条，对齐设计稿）：
 * - PG：角色属性拨杆（ALTER ROLE）+ 成员角色增删（GRANT/REVOKE role）；
 * - MySQL：账户锁定/口令过期拨杆（ALTER USER ACCOUNT LOCK / PASSWORD EXPIRE）
 *   + 全局权限（ON *.*）勾选差量 + WITH GRANT OPTION；
 * - Oracle：系统权限/预定义角色勾选差量（GRANT/REVOKE ... TO/FROM user）。
 * 未提交改动数展示在底部执行条；「回滚」还原快照，「提交改动」差量执行。
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
  // —— MySQL 账户属性（锁定/过期拨杆，快照取自账户列表） ——
  const [myAttrs, setMyAttrs] = useState<Record<string, boolean>>({});
  const myAttrs0 = useRef<Record<string, boolean>>({});
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
    const ma: Record<string, boolean> = { locked: !!user.locked, expired: !!user.expired };
    setMyAttrs(ma);
    myAttrs0.current = { ...ma };
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
  }, [user.name, user.host, user.locked, user.expired, privs]);

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
      // MySQL：账户属性差量（锁定/过期 → ALTER USER）
      if (isMysql) {
        const attrs: NonNullable<DbUserPrivEdit['attrs']> = {};
        for (const k of ['locked', 'expired'] as const) {
          if (myAttrs[k] !== myAttrs0.current[k]) (attrs as Record<string, boolean>)[k] = myAttrs[k];
        }
        if (Object.keys(attrs).length) edit.attrs = attrs;
      }
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
      if (!edit.attrs && !edit.grantPrivs && !edit.revokePrivs) {
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

  // 未提交改动数（底部执行条徽标）
  const dirty = isPg
    ? Object.keys(pgAttrs).filter((k) => pgAttrs[k] !== pgAttrs0.current[k]).length + pgGrant.length + pgRevoke.length
    : (isMysql ? (['locked', 'expired'] as const).filter((k) => myAttrs[k] !== myAttrs0.current[k]).length : 0)
      + Object.keys(checks).filter((k) => checks[k] !== checks0.current[k]).length
      + (isMysql && grantOption !== grantOption0.current ? 1 : 0);

  const reset = () => {
    if (isPg) {
      setPgAttrs({ ...pgAttrs0.current });
      setPgGrant([]);
      setPgRevoke([]);
    } else {
      setChecks({ ...checks0.current });
      setGrantOption(grantOption0.current);
      setMyAttrs({ ...myAttrs0.current });
    }
    setMsg(null);
  };

  const pgSwitches: [string, string, string][] = [
    ['login', '可登录（LOGIN）', '允许此角色连接数据库'],
    ['superuser', '超级用户（SUPERUSER）', '绕过所有权限检查，慎用'],
    ['createDb', '建库（CREATEDB）', '允许创建数据库'],
    ['createRole', '建角色（CREATEROLE）', '允许创建与管理其他角色'],
    ['replication', '流复制（REPLICATION）', '允许流复制连接'],
    ['inherit', '继承（INHERIT）', '自动继承所属角色的权限'],
  ];

  const cb = 'h-3 w-3 accent-accent';
  const lab = 'flex items-center gap-1 text-[length:calc(var(--pref-fs)*0.714)] text-fg';
  const secTitle = 'mb-2 flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-semibold text-dim';
  const swRow = 'flex items-center gap-2.5 rounded-lg border border-line bg-panel2 px-3 py-2';
  const swLbl = 'text-[length:calc(var(--pref-fs)*0.786)] text-fg';
  const swDesc = 'mt-0.5 text-[length:calc(var(--pref-fs)*0.643)] text-dim2';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3.5">
        {/* —— 账户属性（拨杆） —— */}
        <div className={secTitle}>
          <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4Z" strokeLinejoin="round" />
          </svg>
          账户属性
        </div>
        {isPg && (
          <div className="mb-4 flex flex-col gap-1.5">
            {pgSwitches.map(([k, lbl, desc]) => (
              <div key={k} className={swRow}>
                <div className="min-w-0 flex-1">
                  <div className={swLbl}>{lbl}</div>
                  <div className={swDesc}>{desc}</div>
                </div>
                <Switch on={!!pgAttrs[k]} onChange={(v) => setPgAttrs((s) => ({ ...s, [k]: v }))} />
              </div>
            ))}
          </div>
        )}
        {isMysql && (
          <div className="mb-4 flex flex-col gap-1.5">
            <div className={swRow}>
              <div className="min-w-0 flex-1">
                <div className={swLbl}>锁定账号（ACCOUNT LOCK）</div>
                <div className={swDesc}>禁止登录但保留角色与授权</div>
              </div>
              <Switch tone="warn" on={!!myAttrs.locked} onChange={(v) => setMyAttrs((s) => ({ ...s, locked: v }))} />
            </div>
            <div className={swRow}>
              <div className="min-w-0 flex-1">
                <div className={swLbl}>口令过期（PASSWORD EXPIRE）</div>
                <div className={swDesc}>下次登录强制修改口令</div>
              </div>
              <Switch tone="prod" on={!!myAttrs.expired} onChange={(v) => setMyAttrs((s) => ({ ...s, expired: v }))} />
            </div>
            <div className={swRow}>
              <div className="min-w-0 flex-1">
                <div className={swLbl}>WITH GRANT OPTION（可转授）</div>
                <div className={swDesc}>允许此账号把权限转授他人</div>
              </div>
              <Switch on={grantOption} onChange={setGrantOption} />
            </div>
          </div>
        )}
        {isOra && (
          <div className="mb-4 rounded-lg border border-line bg-panel2 px-3 py-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
            Oracle 用户属性（表空间 / 配额）暂不支持在此编辑，可到 SQL 编辑器执行 ALTER USER。
          </div>
        )}

        {/* —— 权限勾选（MySQL 全局权限 / Oracle 系统权限与角色） —— */}
        {(isMysql || isOra) && (
          <>
            <div className={secTitle}>
              <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M12 3v18M5 7l7-4 7 4M5 7v5c0 3 3 6 7 7 4-1 7-4 7-7V7" strokeLinejoin="round" />
              </svg>
              {isMysql ? '全局权限（ON *.*）' : '系统权限与角色'}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {isMysql && MYSQL_GLOBAL_PRIVS.map((p) => (
                <label key={p} className={lab}>
                  <input type="checkbox" className={cb} checked={!!checks[p]} onChange={(e) => setChecks((s) => ({ ...s, [p]: e.target.checked }))} />
                  {p}
                </label>
              ))}
              {isOra && ORA_SYS_PRIVS.map((p) => (
                <label key={p} className={lab}>
                  <input type="checkbox" className={cb} checked={!!checks[p]} onChange={(e) => setChecks((s) => ({ ...s, [p]: e.target.checked }))} />
                  {p}
                </label>
              ))}
            </div>
            {isOra && (
              <>
                <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">预定义角色</div>
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
          </>
        )}

        {/* —— PG 角色成员 —— */}
        {isPg && (
          <>
            <div className="mt-4 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">角色成员（× 移除）</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {pgMembers.length === 0 && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">（无）</span>}
              {pgMembers.map((r) => (
                <span key={r} className="flex items-center gap-1 rounded bg-panel2 px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-fg">
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
                className="rounded border border-line px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim hover:bg-panel2 disabled:opacity-40"
              >授予</button>
            </div>
          </>
        )}

        {/* —— 当前授权明细 —— */}
        <div className={secTitle + ' mt-4'}>
          <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M12 3v18M5 7l7-4 7 4M5 7v5c0 3 3 6 7 7 4-1 7-4 7-7V7" strokeLinejoin="round" />
          </svg>
          当前授权明细
          <span className="ml-auto rounded-full border border-line2/70 bg-panel2 px-2 font-normal leading-4 text-[length:calc(var(--pref-fs)*0.714)] text-dim">{privs.length} 项</span>
        </div>
        {privs.length === 0 ? (
          <div className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2">（无显式授权）</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {privs.map((p, i) => (
              <div key={i} className="rounded-lg border border-line bg-panel2 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 break-all font-mono text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">{p.privilege}</span>
                  {p.grantable && (
                    <span className="shrink-0 rounded bg-ok/15 px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-ok">可转授</span>
                  )}
                  {p.target && <span className="ml-auto shrink-0 truncate font-mono text-[length:calc(var(--pref-fs)*0.714)] text-dim">{p.target}</span>}
                </div>
                {p.raw && p.raw !== p.privilege && (
                  <div className="mt-1.5 overflow-x-auto whitespace-nowrap rounded border border-line bg-bg px-2 py-1 font-mono text-[length:calc(var(--pref-fs)*0.643)] text-dim">{p.raw}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {msg && <div className={`mt-2 text-[length:calc(var(--pref-fs)*0.714)] ${msg.ok ? 'text-ok' : 'text-prod'}`}>{msg.text}</div>}
      </div>

      {/* —— 底部执行条 —— */}
      <div className="flex shrink-0 items-center gap-2.5 border-t border-line bg-panel2/70 px-4 py-2.5">
        <span className={`flex min-w-0 flex-1 items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.714)] ${dirty > 0 ? 'text-warn' : 'text-dim2'}`}>
          {dirty > 0 ? (
            <>
              <svg className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              </svg>
              {dirty} 处改动未提交
            </>
          ) : '无未提交改动'}
        </span>
        <button onClick={reset} disabled={busy || dirty === 0} className="btn shrink-0">回滚</button>
        <button onClick={() => void apply()} disabled={busy || dirty === 0} className="btn-primary shrink-0">{busy ? '提交中…' : '提交改动'}</button>
      </div>
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

/** 顶部工具条文字按钮（图标 + 文字；danger=删除行，accent=提交等主动作）。icon 传 svg path 片段 */
function TBtn({ label, onClick, disabled, danger, accent, icon }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; accent?: boolean; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors ${
        danger
          ? 'text-fg2 hover:bg-prod/10 hover:text-prod'
          : accent
            ? 'text-accent2 hover:bg-accent/10'
            : 'text-fg2 hover:bg-panel3 hover:text-fg'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
      {label}
    </button>
  );
}
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
