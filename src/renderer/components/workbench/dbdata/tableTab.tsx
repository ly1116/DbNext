import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Icon } from "@renderer/components/common/icons";
import { ContextMenu, type MenuItem } from "@renderer/components/common/ContextMenu";
import { createPortal } from "react-dom";
import { api } from "@renderer/api";
import { useConnections } from "@renderer/store/connectionStore";
import { ErrorBox } from "@renderer/components/common/States";
import { shortTypeName } from "@renderer/utils/dbTypes";
import { errMsg } from "@renderer/utils/errMsg";
import type { DbColumn, DbColumnAlterSpec, DbForeignKey, DbIndex, DbTrigger, QueryColumn, QueryResult } from "@shared/types";
import { downloadFile } from './shared';
import { TBtn } from './usersTab';
import { Button } from '@renderer/components/ui/button';

export const LIMITS = [50, 200, 1000, 5000] as const;

/** 当前时间格式化（YYYY-MM-DD HH:mm:ss，状态栏「获取时间」展示用） */
export const fmtNow = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** DDL 弹窗输入框统一 class（新增索引 / 外键 / 触发器对话框复用，风格与查询页输入框一致） */
export const ddlInputCls = 'w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-[length:calc(var(--pref-fs)*0.786)] text-foreground';

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
  const out = w
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

/** 高级复制/粘贴（Excel 风格）TSV 辅助：含 \t / 换行 / " 的单元格用双引号包裹（Excel/WPS 可正确解析） */
const tsvCell = (v: string) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** 解析剪贴板 TSV（支持双引号转义："" → "，引号包裹内可有 \t / 换行） */
const tsvParse = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
};
export function FilterInput({
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
      className={`relative group flex h-8 min-w-0 items-center gap-1.5 rounded-lg border bg-background pl-2.5 pr-1.5 transition-all ${
        active
          ? 'border-primary/50 shadow-[0_0_0_1px_hsl(var(--primary)/0.12)]'
          : 'border-border hover:border-border'
      } focus-within:border-primary focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/0.15)] ${className ?? 'flex-1'}`}
    >
      <span className={`shrink-0 transition-colors ${active ? 'text-primary' : 'text-muted-foreground group-focus-within:text-primary'}`}>{icon}</span>
      <span
        className={`shrink-0 select-none font-mono text-[length:calc(var(--pref-fs)*0.714)] leading-4 transition-colors ${
          active ? 'font-medium text-primary' : 'text-muted-foreground group-focus-within:text-foreground'
        }`}
      >
        {label}
      </span>
      <span className="h-4 w-px shrink-0 bg-border" />
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
        className="h-full min-w-0 flex-1 border-0 bg-transparent font-mono text-[length:calc(var(--pref-fs)*0.714)] text-foreground outline-none placeholder:text-muted-foreground/55"
      />
      {active && (
        <button
          onClick={() => {
            setSug(null);
            onClear();
          }}
          title="清空并恢复全量"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Icon name="close-2" className="h-3 w-3"  />
        </button>
      )}
      {sug && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-44 min-w-40 overflow-auto rounded-md border border-border bg-muted py-0.5 shadow-lg">
          {sug.items.map((it, i) => (
            <div
              key={it}
              onMouseDown={(e) => {
                e.preventDefault();
                apply(it);
              }}
              className={`cursor-pointer px-2 py-0.5 font-mono text-[length:calc(var(--pref-fs)*0.714)] ${i === sug.idx ? 'bg-secondary text-primary' : 'text-foreground'}`}
            >
              {it}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TableTab({ connId, db, pgDb, table }: { connId: string; db?: string; pgDb?: string; table: string }) {
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
  /** 新增行单元格右键菜单：{ ni = 新增行序号, col = 列名 } */
  const [newCellMenu, setNewCellMenu] = useState<{ x: number; y: number; ni: number; col: string } | null>(null);
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
  /** 上拉加载进行中（滚动到底自动追加下一页；ref 同步守卫防滚动事件连发重复请求） */
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

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
      setError(errMsg(e));
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
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  /**
   * 上拉加载（无限滚动）：滚动接近底部时按「已载入行数」为 offset 取下一页并追加。
   * 追加不改变既有行索引，编辑/删除缓存不会错位；与底部翻页按钮并存（翻页仍整页替换）。
   */
  const loadMore = async (): Promise<void> => {
    if (loadingMoreRef.current || loading || detail || !result || !hasMore) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const { where, orderBy } = filterRef.current;
      const res = await api.tableData(connId, db, table, limit, pgDb, result.rows.length, {
        where: quoteWhereValues(where, colMeta) || undefined,
        orderBy: orderBy.trim() || undefined,
      });
      const appended = res.rows.length;
      setResult((prev) =>
        prev ? { ...prev, rows: [...prev.rows, ...res.rows], rowCount: prev.rowCount + res.rowCount, elapsedMs: res.elapsedMs } : prev,
      );
      setHasMore(res.rowCount >= limit);
      if (appended > 0) setTbPage(Math.max(0, Math.ceil((result.rows.length + appended) / limit) - 1));
      setFetchedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  /** 网格滚动：距底部不足 160px 时触发上拉加载 */
  const onGridScroll = () => {
    const el = gridWrapRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 160) return;
    void loadMore();
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
      setDesignErr(errMsg(e));
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
                return cellCopyText(v, c.dataType);
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
      setCommitMsg(`提交失败：${errMsg(e)}`);
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
    const rawDt = columns.find((c) => c.name === m.col)?.dataType;
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
              return cellCopyText(v, c.dataType);
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
    /** 复制行到新建行（Navicat「复制为新增行」）：带当前编辑值整行复制追加到新增区；主键留空（自增列由库生成，非自增主键需手填新值，否则插入必撞重复键） */
    const dupRowIdx = (inRect ? [...selRows] : [m.ri]).filter((ri) => baseRows[ri]).sort((a, b) => a - b);
    const duplicateRowsAsNew = () => {
      if (!editable || !dupRowIdx.length) return;
      const rows = dupRowIdx.map((ri) => {
        const r: Record<string, string> = {};
        for (const c of columns) {
          if (pkCols.includes(c.name)) continue;
          const v = rowVal(ri, c);
          r[c.name] = cellCopyText(v, c.dataType);
        }
        return r;
      });
      setNewRows((prev) => [...prev, ...rows]);
      // 追加后滚到网格底部，让复制出的新增行立即可见
      requestAnimationFrame(() => {
        const wrap = gridWrapRef.current;
        if (wrap) wrap.scrollTop = wrap.scrollHeight;
      });
    };
    const dupLabel = `复制行到新建行${dupRowIdx.length > 1 ? `（${dupRowIdx.length} 行）` : ''}`;
    /** 高级复制/粘贴（Excel 风格）：首行列名 + Tab 分隔（tsvCell/tsvParse 为模块级辅助） */
    const advRows = (inRect ? [...selRows] : [m.ri]).filter((ri) => baseRows[ri]).sort((a, b) => a - b);
    const advCols = columns.filter((c) => (inRect ? selCols.has(c.name) : c.name === m.col));
    const advCopy = () => {
      const lines = [advCols.map((c) => tsvCell(c.name)).join('\t')];
      for (const ri of advRows) {
        lines.push(advCols.map((c) => {
          const v = rowVal(ri, c);
          return v === null || v === undefined ? '' : tsvCell(cellCopyText(v, c.dataType));
        }).join('\t'));
      }
      copyText(lines.join('\n'));
    };
    const advPaste = () => {
      void navigator.clipboard?.readText().then((clip) => {
        if (clip == null || !clip.trim()) return;
        const grid = tsvParse(clip.replace(/\r/g, ''));
        while (grid.length && grid[grid.length - 1].length === 1 && grid[grid.length - 1][0] === '') grid.pop();
        if (!grid.length) return;
        const r0 = inRect ? Math.min(...[...selRows]) : m.ri;
        const c0Order = inRect ? Math.min(...[...selCols].map(colOrder)) : colOrder(m.col);
        const targetCols = columns.slice(c0Order);
        if (!targetCols.length) return;
        // 首行为列名行（高级复制来源）：整行与目标列序一致（允许尾部缺省）时跳过
        const first = grid[0].map((s) => s.trim().toLowerCase());
        const headerMatch =
          first.some((s) => s) &&
          first.every((s, j) => !s || s === (targetCols[j]?.name ?? '').toLowerCase());
        const body = headerMatch ? grid.slice(1) : grid;
        if (!body.length) return;
        const width = Math.min(...body.map((r) => r.length), targetCols.length);
        const maxRi = baseRows.length - 1;
        const patch: Record<string, string> = {};
        const extra: Record<string, string>[] = [];
        body.forEach((vals, i) => {
          const ri = r0 + i;
          for (let j = 0; j < width; j++) {
            const cn = targetCols[j]?.name;
            if (!cn) break;
            const v = vals[j] ?? '';
            if (ri <= maxRi) patch[`${ri}::${cn}`] = v;
            else {
              const k = ri - maxRi - 1;
              if (!extra[k]) extra[k] = {};
              extra[k][cn] = v;
            }
          }
        });
        if (Object.keys(patch).length) setEdits((mm) => ({ ...mm, ...patch }));
        const extraRows = extra.filter(Boolean);
        if (extraRows.length) setNewRows((prev) => [...prev, ...extraRows]);
      });
    };
    const advCopyLabel = `高级复制（含列名${advRows.length > 1 ? ` ${advRows.length} 行` : ''}）`;
    const advPasteLabel = '高级粘贴';
    return [
      {
        label: `置为 NULL${cnt > 1 ? `（${cnt} 格）` : ''}`,
        disabled: !editable || (cnt === 1 && m.isNull),
        onClick: () => applyAll(''),
      },
      { label: '', separator: true },
      {
        label: cnt > 1 ? '复制块' : '复制值',
        onClick: () => (cnt > 1 ? copyBlock() : copyText(rawVal === null || rawVal === undefined ? '' : cellCopyText(rawVal, rawDt))),
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
      { label: '', separator: true },
      {
        label: dupLabel,
        disabled: !editable,
        onClick: duplicateRowsAsNew,
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
      {
        label: advCopyLabel,
        onClick: advCopy,
      },
      {
        label: advPasteLabel,
        disabled: !editable,
        onClick: advPaste,
      },
      { label: '', separator: true },
      { label: '编辑此字段', disabled: !editable || cnt > 1, onClick: () => setEditing({ ri: m.ri, col: m.col }) },
    ];
  };

  /** 新增行单元格右键菜单：粘贴 / 高级粘贴（支持从高级复制或 Excel 复制的内容直接铺到新增行）/ 清空 / 删除此行 */
  const buildNewCellMenu = (): MenuItem[] => {
    const m = newCellMenu!;
    const c0Order = Math.max(0, colOrder(m.col));
    const targetCols = columns.slice(c0Order);
    /** 高级粘贴：从该新增行/列起整块铺开；自动识别并跳过列名行；不够的行自动追加新新增行 */
    const pasteBlock = () => {
      void navigator.clipboard?.readText().then((clip) => {
        if (clip == null || !clip.trim()) return;
        const grid = tsvParse(clip.replace(/\r/g, ''));
        while (grid.length && grid[grid.length - 1].length === 1 && grid[grid.length - 1][0] === '') grid.pop();
        if (!grid.length) return;
        const first = grid[0].map((s) => s.trim().toLowerCase());
        const headerMatch =
          first.some((s) => s) &&
          first.every((s, j) => !s || s === (targetCols[j]?.name ?? '').toLowerCase());
        const body = headerMatch ? grid.slice(1) : grid;
        if (!body.length) return;
        const width = Math.min(...body.map((r) => r.length), targetCols.length);
        setNewRows((prev) => {
          const next = [...prev];
          body.forEach((vals, i) => {
            const idx = m.ni + i;
            const obj: Record<string, string> = {};
            for (let j = 0; j < width; j++) {
              const cn = targetCols[j]?.name;
              if (!cn) break;
              obj[cn] = vals[j] ?? '';
            }
            if (idx < next.length) next[idx] = { ...next[idx], ...obj };
            else {
              while (next.length < idx) next.push({});
              next.push(obj);
            }
          });
          return next;
        });
      });
    };
    return [
      {
        label: '粘贴到单元格',
        disabled: !editable,
        onClick: () => {
          void navigator.clipboard?.readText().then((clip) => {
            if (clip == null) return;
            const v = clip.replace(/\r/g, '').split('\n')[0]?.split('\t')[0] ?? '';
            setNewRows((prev) => prev.map((row, idx) => (idx === m.ni ? { ...row, [m.col]: v } : row)));
          });
        },
      },
      {
        label: '高级粘贴（含列名自动识别）',
        disabled: !editable,
        onClick: pasteBlock,
      },
      { label: '', separator: true },
      {
        label: '清空此行',
        disabled: !editable,
        onClick: () => setNewRows((prev) => prev.map((row, idx) => (idx === m.ni ? {} : row))),
      },
      {
        label: '删除此行',
        disabled: !editable,
        onClick: () => setNewRows((prev) => prev.filter((_, idx) => idx !== m.ni)),
      },
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
      const body = viewRows.map(({ row }) => `| ${columns.map((c) => { const v = row[c.name]; return cellCopyText(v, c.dataType); }).join(' | ')} |`);
      downloadFile(`${table}.md`, 'text/markdown', [row1, sep, ...body].join('\n'));
    }
  };

  /** 点击表头：asc → desc → 取消 */
  const toggleSort = (col: string) =>
    setSort((s) => (s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null));

  /**
   * 结构网格「确认新增」→ 执行本次变动的 DDL 语句（弹窗预览的 SQL 与实际执行完全一致）。
   * 逐条执行，任一失败即抛出（由弹窗展示并保留待执行清单）；全部成功后刷新结构与数据。
   */
  const execStructureDdl = async (sqls: string[]) => {
    setDdlMsg(null);
    for (const s of sqls) await api.runSql(connId, s, pgDb || undefined);
    await reload();
    setDdlMsg(`已执行 ${sqls.length} 条 DDL`);
  };

  /** 删除字段 / 修改字段：结构页均为预操作（ColumnsView 暂存 → 确认弹窗预览 SQL → 才真正落库），此处不再直接执行。 */

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
      window.alert(`创建索引失败：${errMsg(e)}`);
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
      window.alert(`创建外键失败：${errMsg(e)}`);
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
      window.alert(`创建触发器失败：${errMsg(e)}`);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部「表名 + 子页签」条（设计稿同款：文字页签，激活项主题色文字 + 底部 2px 下划线） */}
      <div className="flex h-[38px] shrink-0 items-center gap-1 border-b border-border bg-background px-3.5">
        {/* 表身份：图标 + 库.表 */}
        <div
          className="flex min-w-0 items-center gap-1.5"
          title={pkCols.length ? `主键 ${pkCols.join(', ')}` : '无主键（只读）'}
        >
          <Icon name="table" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
          <span className="truncate text-[13px] font-semibold text-foreground">
            {db && <span className="font-normal text-muted-foreground">{db}.</span>}
            {table}
          </span>
          {pkCols.length === 0 && (
            <span className="shrink-0 rounded border border-border/70 px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-muted-foreground">只读</span>
          )}
        </div>

        {commitMsg && (
          <span className="ml-1.5 min-w-0 truncate text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground" title={commitMsg}>
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
                subTab === t.k ? 'font-medium text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
              {subTab === t.k && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-t-[2px] bg-primary" />}
            </button>
          ))}
        </div>

        {/* 未提交改动徽标（设计稿放在表名条最右） */}
        {editable && dirtyCount > 0 && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] text-warning" title={`${dirtyCount} 处未提交改动，工具栏「提交」写入数据库`}>
            <Icon name="warning-2" className="h-3 w-3"  />
            {dirtyCount} 处未提交
          </span>
        )}
      </div>

      {subTab === 'data' ? (
        <>
          {/* 顶部工具条：排序 chip + where / order by 输入 + 结果内筛选 + 右侧操作按钮 */}
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            {sort && (
              <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-[11.5px] text-foreground">
                排序<b className="font-semibold text-primary">{sort.col} {sort.dir === 'asc' ? '↑' : '↓'}</b>
                <span className="cursor-pointer text-muted-foreground hover:text-destructive" onClick={() => setSort(null)} title="清除排序">×</span>
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
                  <Icon name="filter" className="h-3.5 w-3.5" strokeWidth={1.8} />
                }
              />
            ) : (
              <span
                onClick={() => { setShowWhere(true); requestAnimationFrame(() => whereInputRef.current?.focus()); }}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-2 text-[11.5px] text-muted-foreground hover:border-primary hover:text-primary"
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
                  <Icon name="sort" className="h-3.5 w-3.5" strokeWidth={1.8} />
                }
              />
            ) : (
              <span
                onClick={() => { setShowOrder(true); requestAnimationFrame(() => orderByInputRef.current?.focus()); }}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-2 text-[11.5px] text-muted-foreground hover:border-primary hover:text-primary"
                title="展开 ORDER BY 输入（回车执行查询；Esc 清空）"
              >＋ 排序</span>
            )}
            <span className="h-4 w-px shrink-0 bg-border" />
            <label className="flex h-6 w-[180px] shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-muted-foreground focus-within:border-primary">
              <Icon name="search-3" className="h-3 w-3 shrink-0"  />
              <input
                value={qf}
                onChange={(e) => setQf(e.target.value)}
                placeholder="在结果中筛选…"
                className="w-full border-none bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <TBtn label="插入行" onClick={() => setNewRows((r) => [...r, {}])} icon={<><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M12 9v6M9 12h6" /></>} />
              <TBtn label="删除行" danger disabled={selected == null} onClick={() => selected != null && setDeleted((s) => new Set(s).add(selected))} icon={<><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M9 12h6" /></>} />
              <span className="h-4 w-px bg-border" />
              <span className="relative">
                <TBtn label="导出" onClick={() => setExportOpen((o) => !o)} disabled={!result} icon={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>} />
                {exportOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 min-w-[156px] rounded-md border border-border bg-background p-1 shadow-xl">
                    {([
                      ['csv', 'CSV（Excel 可开）'],
                      ['json', 'JSON 数据'],
                      ['insert', 'INSERT 语句'],
                      ['md', 'Markdown 表格'],
                    ] as const).map(([k, label]) => (
                      <button key={k} onClick={() => exportData(k)} className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-secondary">
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
            onScroll={onGridScroll}
            onMouseDown={(e) => {
              // 点击表格区域（非输入框）时把焦点交给容器，保证 Ctrl+A / Ctrl+C 等键盘快捷键能稳定触发
              const t = e.target as HTMLElement;
              if (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') gridWrapRef.current?.focus();
            }}
          onKeyDown={(e) => {
            // Tab：在「结果表格」与「记录视图」间切换（detail 下也必须能切回去；编辑单元格输入框时交给编辑器原生处理）。
            // 注意：必须在下面的 `if (editing || detail) return` 之前处理，否则打开记录视图后 Tab 会被 early-return 吞掉、再也回不去表格。
            // 切换后把焦点交回本容器：detail 切换会使 EditableGrid / RecordDetailView 互相卸载挂载，焦点随之丢到 body，
            // 若不及时重新聚焦，下一次 Tab 收不到本处理器。
            if (e.key === 'Tab' && selected != null) {
              const t = e.target as HTMLElement;
              if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
              e.preventDefault();
              setDetail((d) => !d);
              gridWrapRef.current?.focus();
              return;
            }
            // 单元格正在编辑时，由编辑器原生处理（Ctrl+A/C 等），不拦截
            if (editing || detail) return;
            const mod = e.ctrlKey || e.metaKey;
            // Ctrl/⌘+A：结果网格全选（所有行 + 所有列）
            if (mod && (e.key === 'a' || e.key === 'A')) {
              e.preventDefault();
              setSelRows(new Set(viewRows.map((r) => r.ri)));
              setSelCols(new Set(columns.map((c) => c.name)));
              return;
            }
            // Ctrl/⌘+C：复制当前选区（无选区则复制整个结果）为 TSV，便于粘到 Excel
            if (mod && (e.key === 'c' || e.key === 'C')) {
              const cols = columns.filter((c) => selCols.size === 0 || selCols.has(c.name));
              if (cols.length === 0 || viewRows.length === 0) return;
              const lines: string[] = [cols.map((c) => c.name).join('\t')];
              for (const { ri, row } of viewRows) {
                if (selRows.size > 0 && !selRows.has(ri)) continue;
                lines.push(cols.map((c) => {
                  const v = edits[`${ri}::${c.name}`] ?? row[c.name];
                  return cellCopyText(v, c.dataType);
                }).join('\t'));
              }
              e.preventDefault();
              copyText(lines.join('\n'));
              return;
            }
          }}
          className="min-h-0 flex-1 overflow-auto bg-background outline-none"
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
              onNewCellContextMenu={(i, col, x, y) => setNewCellMenu({ x, y, ni: i, col })}
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
            <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载中…</div>
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
          {/* 新增行单元格右键菜单（粘贴 / 高级粘贴 / 清空 / 删除此行） */}
          {newCellMenu && (
            <ContextMenu
              x={newCellMenu.x}
              y={newCellMenu.y}
              items={buildNewCellMenu()}
              onClose={() => setNewCellMenu(null)}
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
            <ColumnsView meta={colMeta} loading={loading} ddlMsg={ddlMsg} dialect={conn?.kind ?? ''} db={db} table={table} onExecDdl={execStructureDdl} onPreviewAlter={(oldName, spec) => api.alterColumnPreview(connId, db, table, oldName, spec, pgDb)} />
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

      {/* 底部状态条：已载入行数 + 翻页 + 每页 + 双击编辑提示 + 行列坐标 */}
      <div className="flex h-8 shrink-0 items-center gap-2.5 border-t border-border px-3 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
        {/* 翻页导航（设计稿同款：首页 / 上一页 / 下一页） */}
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="sm" className="h-6 w-6 px-0" onClick={() => void gotoTbPage(0)} disabled={loading || tbPage === 0} title="第一页">
            <Icon name="chevronLeft" className="h-3 w-3"  />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 w-6 px-0" onClick={() => void gotoTbPage(tbPage - 1)} disabled={loading || tbPage === 0} title="上一页">
            <Icon name="chevronLeft-2" className="h-3 w-3"  />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 w-6 px-0" onClick={() => void gotoTbPage(tbPage + 1)} disabled={loading || !hasMore} title="下一页">
            <Icon name="chevronLeft-3" className="h-3 w-3"  />
          </Button>
        </div>
        <span className="flex items-center gap-1 text-muted-foreground">每页
          <select
            value={limit}
            onChange={(e) => {
              const lim = Number(e.target.value);
              setLimit(lim);
              void reload(lim);
            }}
            className="h-5 rounded border border-border bg-background px-1 text-[11px] text-foreground outline-none"
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
              已载入 <b className="font-semibold tabular-nums text-foreground">{viewRows.length}</b> 行
              {loadingMore ? <span className="ml-1 text-muted-foreground">· 正在加载更多…</span> : null}
              {hasMore && !loadingMore ? <span className="ml-1 text-muted-foreground">· 下拉到底自动加载</span> : null}
              {(whereCl.trim() || orderByCl.trim() || qf.trim()) ? '（已筛选）' : ''}
              {`, ${(result.elapsedMs / 1000).toFixed(3)}s`}
              {fetchedAt ? ` · ${fetchedAt}` : ''}
            </span>
            <div className="ml-auto flex items-center gap-3">
              {selected != null && curCol ? (
                <span className="shrink-0 tabular-nums">行 {viewRows.findIndex((e) => e.ri === selected) + 1}, 列 {colOrder(curCol) + 1}</span>
              ) : (
                <span className="text-success">双击单元格可直接编辑</span>
              )}
              <span className="h-3.5 w-px bg-border" />
              <Button
                variant="ghost" size="sm" className="h-6 px-1.5"
                onClick={() => {
                  if (selected == null || !curCol) return;
                  const key = `${selected}::${curCol}`;
                  const raw = edits[key] !== undefined ? edits[key] : result?.rows[selected]?.[curCol];
                  const rawDt = columns.find((c) => c.name === curCol)?.dataType;
                  copyText(raw === null || raw === undefined ? '' : cellCopyText(raw, rawDt));
                }}
                disabled={!(subTab === 'data' && selected != null && curCol)}
                title="复制选中单元格值"
              >
                复制
              </Button>
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
function ColKeyIcon() {
  return (
    <Icon name="primaryKey" className="h-3 w-3 shrink-0"  />
  );
}
function ColNumIcon() {
  return (
    <Icon name="dtKey" className="h-3 w-3 shrink-0"  />
  );
}
function ColTextIcon() {
  return (
    <Icon name="dtText" className="h-3 w-3 shrink-0"  />
  );
}
function ColDateIcon() {
  return (
    <Icon name="dtDate" className="h-3 w-3 shrink-0" strokeWidth={1.4} />
  );
}
function ColGenericIcon() {
  return (
    <Icon name="dtField" className="h-3 w-3 shrink-0" strokeWidth={1.4} />
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
    return <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">该行已不在当前筛选/排序结果中（按 Tab 返回表格）。</div>;
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
    const colDt = columns.find((c) => c.name === col)?.dataType;
    return [
      {
        label: '置为 NULL',
        disabled: !editable || cellMenu!.isNull,
        onClick: () => onCellChange(ri, col, ''),
      },
      { label: '', separator: true },
      {
        label: '复制值',
        onClick: () => copyText(rawVal === null || rawVal === undefined ? '' : cellCopyText(rawVal, colDt)),
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
        <span className="rounded bg-primary/20 px-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-primary">记录视图 · 第 {ri + 1} 行</span>
        {deleted && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-destructive">已标记删除</span>}
        {!editable && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">只读（无主键）</span>}
        <button onClick={onBack} className="ml-auto rounded border border-border px-1.5 py-px text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground hover:bg-secondary" title="返回表格（也可按 Tab）">
          返回表格 (Tab)
        </button>
      </div>
      <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted">
            <th className="w-40 border-b-2 border-r border-border px-2 py-1 text-left font-medium text-foreground">字段</th>
            <th className="border-b-2 border-border px-2 py-1 text-left font-medium text-foreground">值</th>
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
                  className="whitespace-nowrap border-b border-r border-border bg-background px-2 py-1 align-top"
                  title={comments?.[c.name] ? `${c.name} · ${comments[c.name]}` : `${c.name}${c.dataType ? ` · ${c.dataType}` : ''}`}
                >
                  <span className="flex items-center gap-1">
                    <ColTypeIcon dataType={c.dataType} isPk={pkCols.includes(c.name)} />
                    <span className="font-medium text-foreground">{c.name}</span>
                    {pkCols.includes(c.name) && <span className="text-[9px] text-warning">PK</span>}
                    {c.dataType && <span className="text-[9px] text-muted-foreground">{c.dataType}</span>}
                  </span>
                </td>
                <td
                  className="relative border-b border-border px-2 py-1 text-left"
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
                        onCommit={(v) => { if (editChanged(ent.row[c.name], v, c.dataType)) onCellChange(ri, c.name, v); onEditEnd(); }}
                        onCancel={onEditEnd}
                      />
                    ) : (
                      <input
                        autoFocus
                        defaultValue={edits[key] ?? editInit(ent.row[c.name], c.dataType)}
                        onBlur={(e) => {
                          if (editChanged(ent.row[c.name], e.target.value, c.dataType)) onCellChange(ri, c.name, e.target.value);
                          onEditEnd();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            if (editChanged(ent.row[c.name], (e.target as HTMLInputElement).value, c.dataType)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                            onEditEnd();
                          }
                          if (e.key === 'Escape') onEditEnd();
                          /* Ctrl+S：先写入当前输入值，再延迟触发提交（不让 window 监听重复触发） */
                          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                            e.preventDefault();
                            e.stopPropagation();
                            if (editChanged(ent.row[c.name], (e.target as HTMLInputElement).value, c.dataType)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                            onEditEnd();
                            onCommitShortcut();
                          }
                        }}
                        className="w-full bg-background px-1 py-0.5 text-left text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none"
                      />
                    )
                  ) : isNull ? (
                    <span className="italic text-muted-foreground">(Null)</span>
                  ) : (
                    <span className={`block whitespace-pre-wrap break-all text-foreground ${edits[key] !== undefined ? 'bg-warning/25' : ''}`}>{fmt(raw, c.dataType)}</span>
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

export function EditableGrid({
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
  onNewCellContextMenu,
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
  /** 新增行单元格右键菜单（i = 新增行序号） */
  onNewCellContextMenu?: (i: number, col: string, x: number, y: number) => void;
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
        <tr className="bg-muted">
          <th
            className="w-11 cursor-pointer select-none border-b border-r border-border bg-muted px-1 py-[7px] text-right text-muted-foreground hover:bg-secondary"
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
                className={`cursor-pointer select-none whitespace-nowrap border-b border-r border-border px-2.5 py-[7px] text-[11px] font-semibold ${isColSel ? 'bg-primary/10' : 'bg-muted hover:bg-secondary'} ${isSorted ? 'text-primary shadow-[inset_0_-2px_0_hsl(var(--primary))]' : 'text-foreground'}`}
              >
                <span className="flex items-center gap-1">
                  {c.name}
                  {pkCols.includes(c.name) && (
                    <Icon name="key" className="h-2.5 w-2.5 shrink-0 text-success"  />
                  )}
                  {c.dataType && <span className="max-w-[88px] truncate text-[9.5px] font-normal leading-none tracking-wide text-muted-foreground">{c.dataType}</span>}
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
              className={`group ${isDeleted ? 'opacity-40 line-through' : ''} ${isDirty && !isSel ? 'bg-warning/20' : 'hover:bg-secondary/60'}`}
            >
              <td
                className={`cursor-pointer border-b border-r border-border bg-muted px-1 py-[6px] group-hover:bg-secondary text-right ${isAnchor ? 'font-semibold text-primary' : isSel ? 'text-foreground' : 'text-muted-foreground'}`}
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
                const cellBg = isCurCell || isCellSel ? 'bg-primary/10' : '';
                return (
                  <td
                    key={c.name}
                    className={`relative max-w-[280px] cursor-cell border-b border-border border-r border-border/55 px-2.5 py-[6px] ${cellBg} text-left text-foreground ${isCurCell && !isEditing ? 'shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]' : ''}`}
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
                    {/* 原内容始终渲染以撑住列宽；编辑器用绝对定位悬浮覆盖，不影响表格布局。
                        编辑态下原内容设为 invisible（保留占位宽度、不绘制），避免玻璃主题下 bg-background 透明导致原文字透过编辑器叠加成「重影」。 */}
                    <span className={`${isEditing ? 'invisible' : ''} ${val === null || val === undefined ? 'italic text-muted-foreground' : 'block truncate'}`}>{val === null || val === undefined ? 'NULL' : fmt(val, c.dataType)}</span>
                    {isEditing && (
                      <div data-dt-cell-editor className="absolute inset-0 z-20 flex items-stretch">
                        {isDateTimeType(c.dataType) ? (
                          /* 日期/时间类列：手输 + 日历时间选择弹窗（date 类型只有年月日） */
                          <DateTimeCellEditor
                            initialValue={edits[key] ?? editInit(row[c.name], c.dataType)}
                            dataType={c.dataType}
                            autoOpen
                            onCommit={(v) => { if (editChanged(row[c.name], v, c.dataType)) onCellChange(ri, c.name, v); onEditEnd(); }}
                            onCancel={onEditEnd}
                          />
                        ) : (
                          <input
                            autoFocus
                            defaultValue={edits[key] ?? editInit(row[c.name], c.dataType)}
                            onBlur={(e) => {
                              if (editChanged(row[c.name], e.target.value, c.dataType)) onCellChange(ri, c.name, e.target.value);
                              onEditEnd();
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                if (editChanged(row[c.name], (e.target as HTMLInputElement).value, c.dataType)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                                onEditEnd();
                              }
                              if (e.key === 'Escape') onEditEnd();
                              /* Ctrl+S：先写入当前输入值，再延迟触发提交（不让 window 监听重复触发） */
                              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                                e.preventDefault();
                                e.stopPropagation();
                                if (editChanged(row[c.name], (e.target as HTMLInputElement).value, c.dataType)) onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                                onEditEnd();
                                onCommitShortcut();
                              }
                            }}
                            className={`h-full w-full bg-background px-1 text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none text-left`}
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
          <tr key={`n${i}`} className="bg-success/10">
            <td
              className="border-b border-r border-border bg-muted px-1 py-[6px] text-right text-success"
              title="新增行（右键：粘贴/删除）"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onNewCellContextMenu?.(i, columns[0]?.name ?? '', e.clientX, e.clientY);
              }}
            >
              +{i + 1}
            </td>
            {columns.map((c) => (
              <td
                key={c.name}
                className={`border-b border-border border-r border-border/55 px-2.5 py-[6px]`}
                onContextMenu={(e) => {
                  // 输入框内原生右键（系统剪贴板菜单）保留；其余区域弹自定义菜单
                  if ((e.target as HTMLElement).tagName === 'INPUT' && window.getSelection()?.toString()) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onNewCellContextMenu?.(i, c.name, e.clientX, e.clientY);
                }}
              >
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
                    className="w-full min-w-0 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none placeholder:text-muted-foreground"
                  />
                )}
              </td>
            ))}
          </tr>
        ))}

        {displayRows.length === 0 && newRows.length === 0 && (
          <tr>
            <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-muted-foreground">
              无数据
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** 内联编辑字段（结构网格） */
type StructEditField = 'name' | 'type' | 'len' | 'default' | 'comment';

/** 通用内联输入框（Enter 提交 / Esc 取消 / 失焦提交）——绝对定位铺满单元格（td 需 relative），不参与行高计算、不会把行撑开 */
function InlineEditInput({ initial, editRef, onCommit, onCancel }: { initial: string; editRef: RefObject<HTMLInputElement>; onCommit: (v: string) => void; onCancel: () => void }) {
  return (
    <input
      ref={editRef}
      defaultValue={initial}
      /* size=2 压掉 input 固有宽度：auto 列布局下 input 的默认 size(≈20字符) 会把整列撑宽 */
      size={2}
      className="absolute inset-0 h-full w-full bg-background px-1 text-left text-foreground outline-none"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit((e.target as HTMLInputElement).value);
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={(e) => onCommit(e.target.value)}
    />
  );
}

/** 默认值预设下拉锚点矩形 */
type DefRect = { left: number; top: number; width: number };

/** 结构网格单行（React.memo：数百列时避免无关行随编辑/筛选/暂存状态重渲染，消除卡顿；配合上层 useCallback 稳定回调） */
const StructRow = memo(function StructRow({
  col,
  isPk,
  staged,
  dropped,
  editing,
  defRect,
  dialect,
  editRef,
  onEdit,
  onCommit,
  onCommitNullable,
  onCopy,
  onDropCol,
  onDefMenu,
  onCloseDefMenu,
  onCancelEdit,
}: {
  col: DbColumn;
  isPk: boolean;
  /** 该字段的预操作修改（null = 无；行内即时预览新值，执行前不影响数据库） */
  staged: DbColumnAlterSpec | null;
  /** 该字段是否已预操作删除（行内划线标红，再点删除按钮可撤销） */
  dropped: boolean;
  /** 该行正在编辑的字段（null = 未编辑） */
  editing: StructEditField | null;
  /** 默认值预设下拉锚点矩形（null = 未打开；仅本行打开时非空） */
  defRect: DefRect | null;
  dialect: string;
  editRef: RefObject<HTMLInputElement>;
  onEdit: (col: DbColumn, field: StructEditField, hint: string) => { onDoubleClick: () => void; title: string };
  onCommit: (field: StructEditField, value: string, col: DbColumn) => void;
  onCommitNullable: (col: DbColumn, nullable: boolean) => void;
  onCopy: (col: DbColumn) => void;
  onDropCol: (name: string) => void;
  onDefMenu: (col: DbColumn, el: HTMLButtonElement) => void;
  onCloseDefMenu: () => void;
  onCancelEdit: () => void;
}) {
  // 预操作预览值：有暂存修改时行内直接展示新值（编辑定位仍用原字段名）
  const name = staged?.name ?? col.name;
  const fullType = staged?.fullType ?? col.fullType ?? col.dataType;
  const nullable = staged?.nullable ?? col.nullable;
  const defaultValue = staged && 'defaultValue' in staged ? (staged.defaultValue ?? '') : (col.defaultValue ?? '');
  const comment = staged && 'comment' in staged ? (staged.comment ?? '') : (col.comment ?? '');
  const { base, len } = splitType(fullType);
  return (
    <tr className={dropped ? 'bg-destructive/5 line-through decoration-destructive/50' : staged ? 'bg-primary/10' : 'hover:bg-secondary/60'}>
      <td className="border-b border-r border-border bg-background px-1 py-[3px] text-right text-muted-foreground tabular-nums">{col.ordinal ?? ''}</td>
      {/* 操作：复制（以该列属性预填末行草稿）/ 删除字段（预操作，可撤销） */}
      <td className="border-b border-r border-border px-1 py-[3px] text-center">
        <div className="flex items-center justify-center gap-0.5">
          <button
            tabIndex={-1}
            onClick={() => onCopy(col)}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-primary"
            title={`复制 ${col.name} 属性为新字段（暂存到底部）`}
          >
            <Icon name="copy" className="h-3 w-3" />
          </button>
          <button
            tabIndex={-1}
            onClick={() => onDropCol(col.name)}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
            title={dropped ? `撤销删除 ${col.name}（预操作）` : `删除字段 ${col.name}（预操作，确认后执行 DROP COLUMN）`}
          >
            <Icon name={dropped ? 'refresh' : 'trash'} className="h-3 w-3" />
          </button>
        </div>
      </td>
      <td className="relative cursor-text border-b border-r border-border px-2 py-[3px] text-foreground" {...onEdit(col, 'name', '修改字段名（RENAME）')}>
        {editing === 'name' ? (
          <InlineEditInput initial={name} editRef={editRef} onCommit={(v) => onCommit('name', v, col)} onCancel={onCancelEdit} />
        ) : (
          <span className="flex items-center gap-1.5">
            {isPk && <ColKeyIcon />}
            <span className={`truncate ${staged?.name ? 'font-medium text-primary' : ''}`} title={name}>{name}</span>
          </span>
        )}
      </td>
      <td className="relative cursor-text border-b border-r border-border px-2 py-[3px] font-mono text-primary" {...onEdit(col, 'type', '修改数据类型（含长度，ALTER TYPE / MODIFY）')}>
        {editing === 'type' ? (
          <InlineCombo
            initial={fullType}
            options={commonTypesFor(dialect)}
            onCommit={(v) => void onCommit('type', v, col)}
            onCancel={onCancelEdit}
          />
        ) : (
          <span className="block truncate" title={`${fullType}（双击编辑）`}>{base}</span>
        )}
      </td>
      <td className="relative cursor-text border-b border-r border-border px-2 py-[3px] text-muted-foreground" {...onEdit(col, 'len', '修改长度/精度')}>
        {editing === 'len' ? (
          <InlineEditInput initial={len} editRef={editRef} onCommit={(v) => onCommit('len', v, col)} onCancel={onCancelEdit} />
        ) : (
          <span className="block truncate tabular-nums">{len}</span>
        )}
      </td>
      <td className="border-b border-r border-border px-2 py-[3px] text-center">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-accent"
          checked={nullable}
          disabled={isPk}
          onChange={(e) => void onCommitNullable(col, e.target.checked)}
          title={isPk ? '主键列固定非空' : '勾选 = 可为空（预操作，Ctrl+S 确认后生效）'}
        />
      </td>
      <td className="border-b border-r border-border px-2 py-[3px] text-center">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-accent"
          checked={isPk}
          disabled
          title={isPk ? '主键列' : '已有字段的主键约束请通过 DDL / 索引管理'}
        />
      </td>
      <td className="relative cursor-text border-b border-r border-border px-1 py-[3px] text-muted-foreground" {...onEdit(col, 'default', '修改默认值（清空 = 移除默认值）')}>
        {editing === 'default' ? (
          <InlineCombo
            initial={defaultValue}
            options={DEF_PRESETS}
            emptyLabel="''（无默认）"
            onCommit={(v) => void onCommit('default', v, col)}
            onCancel={onCancelEdit}
          />
        ) : (
          <div className="flex items-center gap-0.5">
            <span className="min-w-0 flex-1 truncate font-mono text-primary" title={defaultValue}>{defaultValue}</span>
            <button
              tabIndex={-1}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); if (defRect) onCloseDefMenu(); else onDefMenu(col, e.currentTarget); }}
              className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="选择常用默认值"
            >
              <Icon name="chevronDown" className="h-3 w-3" strokeWidth={2.2} />
            </button>
          </div>
        )}
        {defRect && (
          <OptionMenu
            rect={defRect}
            options={DEF_PRESETS}
            emptyLabel="''（无默认）"
            onPick={(v) => { onCloseDefMenu(); void onCommit('default', v, col); }}
            onClose={onCloseDefMenu}
          />
        )}
      </td>
      <td className="relative cursor-text border-b border-border px-2 py-[3px] text-muted-foreground" {...onEdit(col, 'comment', '修改注释（清空 = 清除注释）')}>
        {editing === 'comment' ? <InlineEditInput initial={comment} editRef={editRef} onCommit={(v) => onCommit('comment', v, col)} onCancel={onCancelEdit} /> : <span className="block truncate" title={comment}>{comment}</span>}
      </td>
    </tr>
  );
});

/** 属性子页：列结构网格（DBeaver 式行内编辑：#/操作/字段名/类型/长度/可为空/主键/默认值/注释）。
 *  **一切操作都是预操作**：新增字段 / 修改字段（名称/类型/长度/默认值/注释）/ 勾选可为空 / 删除字段
 *  全部先暂存（行内即时预览效果，不影响数据库），「确认」/Ctrl+S 弹出本次全部变动的 SQL →
 *  复制 / 复制并执行 / 执行 后才真正落库。 */
function ColumnsView({ meta, loading, ddlMsg, dialect, db, table, onExecDdl, onPreviewAlter }: {
  meta: DbColumn[];
  loading: boolean;
  ddlMsg: string | null;
  /** 连接方言（mysql / postgres / oracle），决定内联编辑与 DDL 生成的行为 */
  dialect: string;
  /** 所属库（PG 的 schema / MySQL 的 database；用于生成限定表名） */
  db: string | undefined;
  table: string;
  /** 确认弹窗「执行/复制并执行」→ 逐条执行本次变动的 SQL；resolve = 全部成功（父组件已刷新结构） */
  onExecDdl: (sqls: string[]) => Promise<void>;
  /** 预览某个已有字段的修改 SQL（主进程 dryRun 生成，与真实执行语句完全一致，不执行） */
  onPreviewAlter: (oldName: string, spec: DbColumnAlterSpec) => Promise<string[]>;
}) {
  /** 内联编辑状态：目标列 + 编辑字段 + 当前输入值（null = 未在编辑） */
  const [edit, setEdit] = useState<{ name: string; field: 'name' | 'type' | 'len' | 'default' | 'comment'; value: string } | null>(null);
  /** 默认值预设下拉：目标列名 + 锚点矩形（点单元格右侧 ▾ 弹出） */
  const [defMenu, setDefMenu] = useState<{ name: string; rect: { left: number; top: number; width: number } } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (edit) inputRef.current?.focus();
  }, [edit]);

  /** 暂存行（新增字段，可多行）：点底部「+」追加，确认弹窗执行成功后清空 */
  const [pendings, setPendings] = useState<(DraftCol & { id: number })[]>([]);
  const nextPid = useRef(1);
  /** 已有字段的预操作修改（key = 原字段名，多个编辑合并；执行成功后清空） */
  const [alters, setAlters] = useState<Record<string, DbColumnAlterSpec>>({});
  /** 预操作删除的字段名（执行成功后清空；再次点击可撤销） */
  const [drops, setDrops] = useState<string[]>([]);
  /** 确认弹窗：SQL 预览（确认时快照）/ 执行中 / 执行错误 / 已复制提示 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmSqls, setConfirmSqls] = useState<string[]>([]);
  const [execBusy, setExecBusy] = useState(false);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** 暂存行校验错误（确认时校验，展示在表格末尾） */
  const [pendingErr, setPendingErr] = useState<string | null>(null);
  /** 字段筛选（匹配 名称/类型/注释，不区分大小写）：列多时快速定位，同时减少渲染行数 */
  const [colFilter, setColFilter] = useState('');
  const filteredMeta = useMemo(() => {
    const k = colFilter.trim().toLowerCase();
    if (!k) return meta;
    return meta.filter((c) => c.name.toLowerCase().includes(k) || (c.comment ?? '').toLowerCase().includes(k) || (c.fullType ?? c.dataType).toLowerCase().includes(k));
  }, [meta, colFilter]);

  if (loading && meta.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载列结构…</div>
      </div>
    );

  /**
   * 暂存（预操作）一个已有字段的修改：多个编辑按原字段名合并。
   * MySQL 语义要求完整列定义，故始终携带 fullType/nullable/autoIncrement 兜底。
   * 若合并后所有字段都与原值一致（用户改回了原值），则撤销该字段的整条预操作。
   */
  const stageAlter = useCallback((colName: string, patch: DbColumnAlterSpec, col: DbColumn) => {
    setAlters((m) => {
      const prev = m[colName] ?? {};
      const base: DbColumnAlterSpec =
        dialect === 'mysql'
          ? { ...prev, fullType: col.fullType ?? col.dataType, nullable: col.nullable, ...(col.extra === 'auto_increment' ? { autoIncrement: true } : {}) }
          : { ...prev };
      const merged: DbColumnAlterSpec = { ...base, ...patch };
      const origType = col.fullType ?? col.dataType;
      const same =
        (merged.name ?? col.name) === col.name &&
        (merged.fullType ?? origType) === origType &&
        (merged.nullable ?? col.nullable) === col.nullable &&
        (merged.defaultValue ?? col.defaultValue ?? '') === (col.defaultValue ?? '') &&
        (merged.comment ?? col.comment ?? '') === (col.comment ?? '');
      const next = { ...m };
      if (same) delete next[colName];
      else next[colName] = merged;
      return next;
    });
  }, [dialect]);

  /** 双击提交编辑 → 暂存（仅暂存变化的字段，不改数据库；行内即时预览新值） */
  const commit = useCallback((field: 'name' | 'type' | 'len' | 'default' | 'comment', value: string, col: DbColumn) => {
    setEdit(null);
    const patch: DbColumnAlterSpec = {};
    if (field === 'name') {
      const nv = value.trim();
      if (nv && nv !== col.name) patch.name = nv;
    } else if (field === 'type') {
      const tv = value.trim();
      if (tv && tv !== (col.fullType ?? col.dataType)) patch.fullType = tv;
    } else if (field === 'len') {
      const { base, len } = splitType(col.fullType ?? col.dataType);
      const nv = value.trim();
      if (nv === len) return;
      patch.fullType = nv ? `${base}(${nv})` : base;
    } else if (field === 'default') {
      if (value !== (col.defaultValue ?? '')) patch.defaultValue = value;
    } else if (field === 'comment') {
      if (value !== (col.comment ?? '')) patch.comment = value;
    }
    if (Object.keys(patch).length === 0) return;
    stageAlter(col.name, patch, col);
  }, [stageAlter]);

  /** 勾选空性 → 暂存（主键列固定非空不可勾；勾回原值 = 撤销该条预操作） */
  const commitNullable = useCallback((col: DbColumn, nullable: boolean) => {
    stageAlter(col.name, { nullable }, col);
  }, [stageAlter]);

  /** 暂存 / 撤销删除字段（预操作，执行前不影响数据库；同时撤销该列的其他预操作修改） */
  const stageDrop = useCallback((name: string) => {
    setDrops((d) => (d.includes(name) ? d.filter((x) => x !== name) : [...d, name]));
    setAlters((m) => {
      if (!(name in m)) return m;
      const n = { ...m };
      delete n[name];
      return n;
    });
  }, []);

  /** 双击进入内联编辑（useCallback 保持引用稳定，配合 StructRow 的 memo 避免全表重渲染） */
  const startEdit = useCallback((col: DbColumn, field: 'name' | 'type' | 'len' | 'default' | 'comment', hint: string) => ({
    onDoubleClick: () => setEdit({ name: col.name, field, value: '' }),
    title: `${hint}（双击编辑，Enter 提交 / Esc 取消）`,
  }), []);

  /** 打开默认值预设下拉（记录锚点矩形） */
  const openDefMenu = useCallback((col: DbColumn, el: HTMLButtonElement) => {
    const r = el.getBoundingClientRect();
    setDefMenu({ name: col.name, rect: { left: r.left, top: r.bottom + 2, width: Math.max(r.width, 150) } });
  }, []);

  /** 单元格通用双击起点（样式类合并进各自的 className，避免覆盖） */
  /** 点底部「+」：追加一行暂存字段 */
  const addPending = () => {
    setPendingErr(null);
    setPendings((p) => [...p, { id: nextPid.current++, name: '', base: 'varchar', len: '255', nullable: true, pk: false, def: '', comment: '' }]);
  };
  const updatePending = (id: number, patch: Partial<DraftCol>) =>
    setPendings((p) => p.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const removePending = (id: number) => setPendings((p) => p.filter((d) => d.id !== id));

  /** 复制字段：以该列属性追加一行暂存字段（列名加 _copy 后缀） */
  /** 复制已有字段属性为新暂存行 */
  const copyToPending = useCallback((col: DbColumn) => {
    const { base, len } = splitType(col.fullType ?? col.dataType);
    setPendingErr(null);
    setPendings((p) => [
      ...p,
      { id: nextPid.current++, name: `${col.name}_copy`, base, len, nullable: col.nullable, pk: false, def: col.defaultValue ?? '', comment: col.comment ?? '' },
    ]);
  }, []);

  /** 取消编辑 / 关闭默认值下拉（useCallback 稳定引用，供 memo 行使用） */
  const cancelEdit = useCallback(() => setEdit(null), []);
  const closeDefMenu = useCallback(() => setDefMenu(null), []);

  /** 生成限定表名（MySQL 反引号，其余双引号；与主进程 quoteIdent 语义一致） */
  const qualifiedTable = () => {
    const q = (n: string) => (dialect === 'mysql' ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`);
    return db ? `${q(db)}.${q(table)}` : q(table);
  };

  /** 生成新增暂存行的 DDL：每个暂存行一条 ADD COLUMN（MySQL 注释内联 / PG·Oracle 单独 COMMENT ON），勾选主键再补 ADD PRIMARY KEY */
  const buildAddDdl = (): string[] => {
    const tbl = qualifiedTable();
    const isMysql = dialect === 'mysql';
    const q = (n: string) => (isMysql ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`);
    const sqls: string[] = [];
    for (const d of pendings) {
      const name = d.name.trim();
      const base = d.base.trim();
      const len = d.len.trim();
      const parts = [`${q(name)} ${len ? `${base}(${len})` : base}`];
      if (!d.nullable) parts.push('NOT NULL');
      if (d.def.trim()) parts.push(`DEFAULT ${d.def.trim()}`);
      if (isMysql && d.comment.trim()) parts.push(`COMMENT '${d.comment.trim().replace(/'/g, "''")}'`);
      sqls.push(`ALTER TABLE ${tbl} ADD COLUMN ${parts.join(' ')}`);
      if (!isMysql && d.comment.trim()) sqls.push(`COMMENT ON COLUMN ${tbl}.${q(name)} IS '${d.comment.trim().replace(/'/g, "''")}'`);
      if (d.pk) sqls.push(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${q(name)})`);
    }
    return sqls;
  };

  /** 生成删除字段的 DDL（删除同样是预操作，确认后才执行） */
  const buildDropDdl = (name: string): string => {
    const isMysql = dialect === 'mysql';
    const qn = isMysql ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;
    return `ALTER TABLE ${qualifiedTable()} DROP COLUMN ${qn}`;
  };

  /** 本次预操作总数（新增行 + 已有字段修改 + 删除） */
  const changeCount = pendings.length + Object.keys(alters).length + drops.length;

  /** 确认（按钮 / Ctrl+S）：先校验暂存行，再由主进程生成全部预览 SQL（快照），弹出确认弹窗 */
  const tryConfirm = async () => {
    if (execBusy || changeCount === 0) return;
    for (const d of pendings) {
      const name = d.name.trim();
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        setPendingErr(`字段「${name || '(未填写)'}」列名仅允许字母、数字、下划线，且以字母或下划线开头`);
        return;
      }
      if (!d.base.trim()) {
        setPendingErr(`字段「${name}」请填写数据类型`);
        return;
      }
    }
    const names = pendings.map((d) => d.name.trim().toLowerCase());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) {
      setPendingErr(`新增字段名重复：${dup}`);
      return;
    }
    const clash = meta.find((c) => !drops.includes(c.name) && names.includes(c.name.toLowerCase()));
    if (clash) {
      setPendingErr(`字段「${clash.name}」已存在于表中`);
      return;
    }
    // 组装 SQL：修改已有字段（主进程 dryRun 生成，与执行语句一致）→ 新增字段 → 删除字段
    const sqls: string[] = [];
    try {
      for (const [oldName, spec] of Object.entries(alters)) {
        sqls.push(...(await onPreviewAlter(oldName, spec)));
      }
    } catch (e) {
      setPendingErr(errMsg(e));
      return;
    }
    sqls.push(...buildAddDdl());
    for (const n of drops) sqls.push(buildDropDdl(n));
    setPendingErr(null);
    setExecErr(null);
    setCopied(false);
    setConfirmSqls(sqls);
    setConfirmOpen(true);
  };

  /** Ctrl+S（Cmd+S）= 确认：存在预操作时拦截浏览器保存 */
  useEffect(() => {
    if (changeCount === 0) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!confirmOpen) void tryConfirm();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  /** 弹窗执行（executeOnly=false 时先复制 SQL）；成功后清空全部预操作并关闭弹窗 */
  const executeDdl = async (alsoCopy: boolean) => {
    const sqls = confirmSqls;
    if (sqls.length === 0) return;
    if (alsoCopy) {
      try {
        await navigator.clipboard.writeText(sqls.join(';\n') + ';');
        setCopied(true);
      } catch {
        /* 剪贴板失败不阻塞执行 */
      }
    }
    setExecBusy(true);
    setExecErr(null);
    try {
      await onExecDdl(sqls);
      setPendings([]);
      setAlters({});
      setDrops([]);
      setConfirmOpen(false);
    } catch (e) {
      setExecErr(errMsg(e));
    } finally {
      setExecBusy(false);
    }
  };

  /** 草稿行编辑态输入框样式（常驻可编辑观感：浅描边，聚焦高亮） */
  const draftInputCls = 'w-full min-w-0 rounded-sm border border-border bg-background px-1 py-0.5 text-foreground outline-none focus:border-primary';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      {/* 卡头：bar + 标题 + 列数 pill + 编辑提示 + 新增（追加末行草稿） */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">结构</span>
        <span className="shrink-0 rounded-full border border-border/70 bg-muted px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-muted-foreground">
          {colFilter.trim() ? `${filteredMeta.length}/${meta.length} 列` : `${meta.length} 列`}
        </span>
        {/* 字段筛选：匹配 名称/类型/注释（列多时定位 + 减少渲染行数） */}
        <div className="relative shrink-0">
          <Icon name="search" className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={colFilter}
            onChange={(e) => setColFilter(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setColFilter(''); }}
            placeholder="筛选字段"
            spellCheck={false}
            className="h-6 w-32 rounded border border-border bg-background pl-6 pr-5 text-[length:calc(var(--pref-fs)*0.714)] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
            title="按 字段名 / 类型 / 注释 过滤（不区分大小写，Esc 清空）"
          />
          {colFilter && (
            <button
              onClick={() => setColFilter('')}
              className="absolute right-0.5 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="清空筛选"
            >
              <Icon name="close-2" className="h-2.5 w-2.5" strokeWidth={2.4} />
            </button>
          )}
        </div>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{ddlMsg}</span>}
        <span className="min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">双击 字段名/类型/长度/默认值/注释 编辑 · 勾选可为空 · 删除字段 —— 均为预操作，Ctrl+S 确认后才执行</span>
        {changeCount > 0 && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => void tryConfirm()}
            title={`确认本次 ${changeCount} 项变更（Ctrl+S），预览 SQL 后执行才真正变更到数据库`}
          >
            <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.4} />
            确认变更（{changeCount}）
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 固定布局 + 百分比列宽用内联 style：复用 dev 服务的 JIT 缓存可能停更，内联保证生效 */}
        <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '4%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '7%' }} />
            <col style={{ width: '6%' }} />
            <col style={{ width: '5.5%' }} />
            <col style={{ width: '13%' }} />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted">
              <th className="w-9 border-b-2 border-r border-border bg-background px-1 py-1 text-right text-muted-foreground">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-center font-medium text-foreground">操作</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">字段名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">类型</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">长度</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-center font-medium text-foreground">可为空</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-center font-medium text-foreground">主键</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">默认值</th>
              <th className="whitespace-nowrap border-b-2 border-border bg-muted px-2 py-1 text-left font-medium text-foreground">注释</th>
            </tr>
          </thead>
          <tbody>
            {filteredMeta.map((c) => (
              <StructRow
                key={c.name}
                col={c}
                isPk={c.key === 'PRI'}
                staged={alters[c.name] ?? null}
                dropped={drops.includes(c.name)}
                editing={edit?.name === c.name ? edit.field : null}
                defRect={defMenu?.name === c.name ? defMenu.rect : null}
                dialect={dialect}
                editRef={inputRef}
                onEdit={startEdit}
                onCommit={commit}
                onCommitNullable={commitNullable}
                onCopy={copyToPending}
                onDropCol={stageDrop}
                onDefMenu={openDefMenu}
                onCloseDefMenu={closeDefMenu}
                onCancelEdit={cancelEdit}
              />
            ))}
            {filteredMeta.length === 0 && pendings.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  {colFilter.trim() ? `无匹配字段（筛选：${colFilter.trim()}）` : '无字段'}
                </td>
              </tr>
            )}
            {/* 暂存行（新增字段，可多行）：填写完点卡头「确认新增」或 Ctrl+S 预览 SQL 后才落库 */}
            {pendings.map((d, idx) => (
              <tr key={d.id} className="bg-primary/10">
                <td className="border-b border-r border-border bg-background px-1 py-[3px] text-right text-primary tabular-nums">{meta.length + idx + 1}</td>
                <td className="border-b border-r border-border px-1 py-[3px] text-center">
                  <button
                    tabIndex={-1}
                    onClick={() => removePending(d.id)}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
                    title="移除该行（不执行任何 SQL）"
                  >
                    <Icon name="close-2" className="h-3 w-3" strokeWidth={2.2} />
                  </button>
                </td>
                <td className="border-b border-r border-border px-1 py-[3px]">
                  <input
                    autoFocus
                    value={d.name}
                    onChange={(e) => updatePending(d.id, { name: e.target.value })}
                    placeholder="column_name"
                    spellCheck={false}
                    className={draftInputCls}
                  />
                </td>
                <td className="border-b border-r border-border px-1 py-[3px]">
                  <DraftCombo
                    value={d.base}
                    options={commonTypesFor(dialect)}
                    onChange={(v) => updatePending(d.id, { base: v })}
                    onPick={(v) => { const s = splitType(v); updatePending(d.id, { base: s.base, len: s.len }); }}
                  />
                </td>
                <td className="border-b border-r border-border px-1 py-[3px]">
                  <input
                    value={d.len}
                    onChange={(e) => updatePending(d.id, { len: e.target.value })}
                    placeholder="-"
                    spellCheck={false}
                    className={`${draftInputCls} tabular-nums`}
                  />
                </td>
                <td className="border-b border-r border-border px-2 py-[3px] text-center">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={d.nullable && !d.pk}
                    disabled={d.pk}
                    onChange={(e) => updatePending(d.id, { nullable: e.target.checked })}
                    title="勾选 = 可为空（主键列固定非空）"
                  />
                </td>
                <td className="border-b border-r border-border px-2 py-[3px] text-center">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-accent"
                    checked={d.pk}
                    onChange={(e) => updatePending(d.id, { pk: e.target.checked })}
                    title="勾选 = 设为主键（确认时生成 ADD PRIMARY KEY）"
                  />
                </td>
                <td className="border-b border-r border-border px-1 py-[3px]">
                  <DraftCombo
                    value={d.def}
                    options={DEF_PRESETS}
                    emptyLabel="''（无默认）"
                    onChange={(v) => updatePending(d.id, { def: v })}
                    onPick={(v) => updatePending(d.id, { def: v })}
                  />
                </td>
                <td className="border-b border-border px-1 py-[3px]">
                  <input
                    value={d.comment}
                    onChange={(e) => updatePending(d.id, { comment: e.target.value })}
                    placeholder="字段备注（可选）"
                    className={draftInputCls}
                  />
                </td>
              </tr>
            ))}
            {/* 底部「+」行：+ 号位于序号列下方，点击追加一行新字段（预操作） */}
            <tr className="cursor-pointer hover:bg-secondary" onClick={addPending} title="点击新增一行字段（预操作，确认后执行 SQL 落库）">
              <td className="border-b border-border px-1 py-[3px] text-center text-primary">
                <Icon name="plus" className="inline h-3.5 w-3.5" strokeWidth={2.4} />
              </td>
              <td colSpan={8} className="border-b border-border px-2 py-[3px] text-muted-foreground">
                点击添加新字段
              </td>
            </tr>
            {pendingErr && (
              <tr>
                <td colSpan={9} className="px-3 py-1.5 text-destructive" title={pendingErr}>
                  {pendingErr}
                </td>
              </tr>
            )}
            {meta.length === 0 && !loading && pendings.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  无列信息，点击下方「+」添加字段
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 确认弹窗：预览本次全部变动（修改/新增/删除）的 SQL → 复制 / 复制并执行 / 执行（执行成功才真正变更数据库） */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={() => !execBusy && setConfirmOpen(false)}>
          <div className="flex max-h-[80vh] w-[640px] flex-col rounded-lg border border-border bg-muted p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-foreground">本次变更（{changeCount} 项）</span>
              <span className="text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
                {[
                  Object.keys(alters).length > 0 ? `修改 ${Object.keys(alters).length}` : '',
                  pendings.length > 0 ? `新增 ${pendings.length}` : '',
                  drops.length > 0 ? `删除 ${drops.length}` : '',
                ].filter(Boolean).join(' · ')}
              </span>
              <span className="text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">确认无误后执行才会变更到数据库</span>
            </div>
            <pre className="min-h-0 flex-1 overflow-auto rounded border border-border bg-background p-2.5 font-mono text-[12px] leading-relaxed text-foreground" spellCheck={false}>
              {confirmSqls.join(';\n') + ';'}
            </pre>
            {copied && <div className="mt-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-success">SQL 已复制到剪贴板</div>}
            {execErr && <div className="mt-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-destructive" title={execErr}>执行失败：{execErr}</div>}
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="outline" size="sm" className="h-7"
                disabled={execBusy}
                onClick={() => {
                  void navigator.clipboard.writeText(confirmSqls.join(';\n') + ';').then(() => setCopied(true)).catch(() => undefined);
                }}
                title="复制 SQL 到剪贴板（不执行）"
              >
                复制
              </Button>
              <Button
                variant="outline" size="sm" className="h-7 border-primary text-primary hover:bg-secondary"
                disabled={execBusy}
                onClick={() => void executeDdl(true)}
                title="复制 SQL 并执行"
              >
                复制并执行
              </Button>
              <Button
                size="sm" className="h-7"
                disabled={execBusy}
                onClick={() => void executeDdl(false)}
                title="执行 SQL，变更到数据库"
              >
                {execBusy ? '执行中…' : '执行'}
              </Button>
              <Button
                variant="outline" size="sm" className="h-7"
                disabled={execBusy}
                onClick={() => setConfirmOpen(false)}
              >
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
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

/** 类型拆分：varchar(255) → { base: 'varchar', len: '255' }；numeric(19,0) → len '19,0'；无括号 → len '' */
function splitType(full: string): { base: string; len: string } {
  const m = /^(.+?)\s*\(([^()]*)\)\s*$/.exec((full ?? '').trim());
  if (!m) return { base: (full ?? '').trim(), len: '' };
  return { base: m[1].trim(), len: m[2].trim() };
}

/** 默认值预设（结构网格「默认值」列下拉；'' = 无默认值） */
const DEF_PRESETS = ['', 'NULL', '0', '1', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'now()', 'gen_random_uuid()'];

/** 结构网格末行草稿（新增字段） */
interface DraftCol {
  name: string;
  base: string;
  len: string;
  nullable: boolean;
  pk: boolean;
  def: string;
  comment: string;
}

/** 单元格预设下拉（portal 到 body，避免被表格滚动容器裁剪；点选即回调，点击其他区域关闭） */
function OptionMenu({ rect, options, onPick, onClose, emptyLabel }: {
  rect: { left: number; top: number; width: number };
  options: string[];
  onPick: (v: string) => void;
  onClose: () => void;
  /** 空串选项的展示文案（默认值列：''（无默认）） */
  emptyLabel?: string;
}) {
  useEffect(() => {
    const h = () => onClose();
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed z-[60] max-h-64 min-w-[160px] overflow-auto rounded-md border border-border bg-muted py-1 font-mono text-[13px] text-foreground shadow-lg"
      style={{ left: rect.left, top: rect.top, width: rect.width }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {options.map((t, i) => (
        <div
          key={`${t}-${i}`}
          onMouseDown={(e) => { e.preventDefault(); onPick(t); }}
          className="cursor-pointer px-2.5 py-1 hover:bg-secondary hover:text-primary"
        >
          {t === '' ? emptyLabel ?? "''" : t}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** 内联组合编辑（双击单元格出现）：输入框 + ▾ 全量预设下拉（portal）；输入或点选后提交，Esc 取消，失焦提交 */
function InlineCombo({ initial, options, onCommit, onCancel, emptyLabel }: {
  initial: string;
  options: string[];
  onCommit: (v: string) => void;
  onCancel: () => void;
  emptyLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const list = initial && !options.includes(initial) ? [initial, ...options] : options;

  const syncRect = () => {
    const r = ref.current?.closest('div')?.getBoundingClientRect();
    if (r) setRect({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 160) });
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commitValue = (v: string) => onCommit(v.trim());
  return (
    <>
      {/* 绝对定位铺满单元格（td 需 relative）：不参与行高计算，编辑态不会把行撑开 */}
      <div className="absolute inset-0 flex items-center gap-0.5 bg-background outline-none">
        <input
          ref={ref}
          defaultValue={initial}
          /* size=2 压掉 input 固有宽度，避免编辑态把单元格撑宽 */
          size={2}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent px-1 text-left font-mono text-foreground outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) {
              e.preventDefault();
              syncRect();
              setOpen(true);
            } else if (e.key === 'Enter') {
              commitValue((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
          onBlur={(e) => commitValue(e.target.value)}
          title="输入或从下拉选择（↓ 打开预设 / Enter 提交 / Esc 取消）"
        />
        <button
          tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); syncRect(); setOpen((o) => !o); }}
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
          title="预设列表"
        >
          <Icon name="chevronDown" className="h-3 w-3" strokeWidth={2.2} />
        </button>
      </div>
      {open && rect && (
        <OptionMenu
          rect={rect}
          options={list}
          emptyLabel={emptyLabel}
          onPick={(v) => { setOpen(false); commitValue(v); }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** 草稿行组合输入：受控输入 + ▾ 预设下拉（点选经 onPick 写回草稿，不直接提交） */
function DraftCombo({ value, onChange, onPick, options, emptyLabel }: {
  value: string;
  onChange: (v: string) => void;
  onPick: (v: string) => void;
  options: string[];
  emptyLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const sync = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setRect({ left: r.left, top: r.bottom + 2, width: Math.max(r.width, 150) });
  };
  return (
    <>
      <div ref={wrapRef} className="flex min-w-0 items-center gap-0.5">
        <input
          value={value}
          size={2}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 flex-1 bg-transparent px-0.5 py-0.5 text-left font-mono text-primary outline-none"
        />
        <button
          tabIndex={-1}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); sync(); setOpen((o) => !o); }}
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="常用值"
        >
          <Icon name="chevronDown" className="h-3 w-3" strokeWidth={2.2} />
        </button>
      </div>
      {open && rect && (
        <OptionMenu
          rect={rect}
          options={options}
          emptyLabel={emptyLabel}
          onPick={(v) => { setOpen(false); onPick(v); }}
          onClose={() => setOpen(false)}
        />
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
    return `/* DDL 生成失败：${errMsg(e)} */`;
  }
}

/** 表设计器「索引」子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
function IndexListView({ items, loading, error, ddlMsg, onReload, onAdd }: { items: DbIndex[]; loading: boolean; error: string | null; ddlMsg?: string | null; onReload: () => void; onAdd: () => void }) {
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <ErrorBox message={`加载索引失败：${error}`} onRetry={onReload} />
      </div>
    );
  if (loading && items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载索引…</div>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      {/* 卡头：bar + 标题 + 索引数 pill + 操作结果提示 + 新增（对齐「用户与权限管理」卡头） */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">索引</span>
        <span className="shrink-0 rounded-full border border-border/70 bg-muted px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-muted-foreground">
          {items.length} 个
        </span>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{ddlMsg}</span>}
        <Button size="sm" className="ml-auto shrink-0" onClick={onAdd} title="新增索引（CREATE INDEX）">
          <Icon name="plus-2" className="h-3.5 w-3.5" strokeWidth={2.5} />
          新增索引
        </Button>
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
            <tr className="bg-muted">
              <th className="w-9 border-b-2 border-r border-border bg-background px-1 py-1 text-right text-muted-foreground">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">索引名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">列</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-center font-medium text-foreground">唯一</th>
              <th className="whitespace-nowrap border-b-2 border-border bg-muted px-2 py-1 text-left font-medium text-foreground">方法</th>
            </tr>
          </thead>
          <tbody>
            {items.map((ix, i) => (
              <tr key={ix.name} className="hover:bg-secondary/60">
                <td className="border-b border-r border-border bg-background px-1 py-[3px] text-right text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="border-b border-r border-border px-2 py-[3px] text-foreground"><span className="block truncate" title={ix.name}>{ix.name}</span></td>
                <td className="border-b border-r border-border px-2 py-[3px] text-muted-foreground"><span className="block truncate" title={ix.columns.join(', ')}>{ix.columns.join(', ')}</span></td>
                <td className="border-b border-r border-border px-2 py-[3px] text-center">
                  {ix.unique ? <span className="rounded-md border border-border bg-secondary px-1 text-[length:calc(var(--pref-fs)*0.714)] leading-4 text-secondary-foreground">唯一</span> : ''}
                </td>
                <td className="whitespace-nowrap border-b border-border px-2 py-[3px] text-muted-foreground">{ix.method ?? ''}</td>
              </tr>
            ))}
            {items.length === 0 && !loading && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">无索引</td></tr>}
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
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <ErrorBox message={`加载外键失败：${error}`} onRetry={onReload} />
      </div>
    );
  if (loading && items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载外键…</div>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      {/* 卡头：bar + 标题 + 外键数 pill + 操作结果提示 + 新增（对齐「用户与权限管理」卡头） */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">外键</span>
        <span className="shrink-0 rounded-full border border-border/70 bg-muted px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-muted-foreground">
          {items.length} 个
        </span>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{ddlMsg}</span>}
        <Button size="sm" className="ml-auto shrink-0" onClick={onAdd} title="新增外键（ALTER TABLE ADD CONSTRAINT … FOREIGN KEY）">
          <Icon name="plus-2" className="h-3.5 w-3.5" strokeWidth={2.5} />
          新增外键
        </Button>
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
            <tr className="bg-muted">
              <th className="w-9 border-b-2 border-r border-border bg-background px-1 py-1 text-right text-muted-foreground">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">约束名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">本表列</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">引用表</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">引用列</th>
              <th className="whitespace-nowrap border-b-2 border-border bg-muted px-2 py-1 text-left font-medium text-foreground">删除/更新</th>
            </tr>
          </thead>
          <tbody>
            {items.map((fk, i) => (
              <tr key={fk.name} className="hover:bg-secondary/60">
                <td className="border-b border-r border-border bg-background px-1 py-[3px] text-right text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="border-b border-r border-border px-2 py-[3px] text-foreground"><span className="block truncate" title={fk.name}>{fk.name}</span></td>
                <td className="border-b border-r border-border px-2 py-[3px] text-muted-foreground"><span className="block truncate" title={fk.columns.join(', ')}>{fk.columns.join(', ')}</span></td>
                <td className="border-b border-r border-border px-2 py-[3px] text-foreground">{fk.refTable}</td>
                <td className="border-b border-r border-border px-2 py-[3px] text-muted-foreground"><span className="block truncate" title={fk.refColumns.join(', ')}>{fk.refColumns.join(', ')}</span></td>
                <td className="whitespace-nowrap border-b border-border px-2 py-[3px] text-muted-foreground">{[fk.onDelete, fk.onUpdate].filter(Boolean).join(' / ')}</td>
              </tr>
            ))}
            {items.length === 0 && !loading && <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">无外键</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 表设计器「触发器」子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
export function TriggerListView({ items, loading, error, ddlMsg, onReload, onAdd }: { items: DbTrigger[]; loading: boolean; error: string | null; ddlMsg?: string | null; onReload: () => void; onAdd: () => void }) {
  if (error)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <ErrorBox message={`加载触发器失败：${error}`} onRetry={onReload} />
      </div>
    );
  if (loading && items.length === 0)
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载触发器…</div>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      {/* 卡头：bar + 标题 + 触发器数 pill + 操作结果提示 + 新增（对齐「用户与权限管理」卡头） */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">触发器</span>
        <span className="shrink-0 rounded-full border border-border/70 bg-muted px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-muted-foreground">
          {items.length} 个
        </span>
        {ddlMsg && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{ddlMsg}</span>}
        <Button size="sm" className="ml-auto shrink-0" onClick={onAdd} title="新增触发器（CREATE TRIGGER）">
          <Icon name="plus-2" className="h-3.5 w-3.5" strokeWidth={2.5} />
          新增触发器
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* 固定布局 + 百分比列宽用内联 style：复用 dev 服务的 JIT 缓存可能停更，内联保证生效 */}
        <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '22%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '15%' }} />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted">
              <th className="w-9 border-b-2 border-r border-border bg-background px-1 py-1 text-right text-muted-foreground">#</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">触发器名</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">表</th>
              <th className="whitespace-nowrap border-b-2 border-r border-border bg-muted px-2 py-1 text-left font-medium text-foreground">时机</th>
              <th className="whitespace-nowrap border-b-2 border-border bg-muted px-2 py-1 text-left font-medium text-foreground">事件</th>
            </tr>
          </thead>
          <tbody>
            {items.map((tg, i) => (
              <tr key={tg.name} className="hover:bg-secondary/60">
                <td className="border-b border-r border-border bg-background px-1 py-[3px] text-right text-muted-foreground tabular-nums">{i + 1}</td>
                <td className="border-b border-r border-border px-2 py-[3px] text-foreground"><span className="block truncate" title={tg.name}>{tg.name}</span></td>
                <td className="border-b border-r border-border px-2 py-[3px] text-muted-foreground"><span className="block truncate" title={tg.table}>{tg.table}</span></td>
                <td className="border-b border-r border-border px-2 py-[3px] text-foreground">{tg.timing}</td>
                <td className="border-b border-border px-2 py-[3px] text-muted-foreground">{tg.events}</td>
              </tr>
            ))}
            {items.length === 0 && !loading && <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">无触发器</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 表设计器「触发器」子页（对齐「用户与权限管理」页的卡片 + 表格语言） */
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
    if (com) out.push(<span key={key} className="italic text-muted-foreground">{tok}</span>);
    else if (str) out.push(<span key={key} className="text-str">{tok}</span>);
    else if (num) out.push(<span key={key} className="text-num">{tok}</span>);
    else if (word) {
      const low = tok.toLowerCase();
      if (SQL_KEYWORDS.has(low)) out.push(<span key={key} className="font-medium text-purple">{tok}</span>);
      else if (SQL_TYPES.has(low)) out.push(<span key={key} className="text-blue">{tok}</span>);
      else out.push(<span key={key}>{tok}</span>);
    } else out.push(<span key={key} className={ws ? undefined : 'text-muted-foreground'}>{tok}</span>);
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      {/* 卡头：bar + 标题 + 统计 pill + 复制（对齐「用户与权限管理」卡头） */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" />
        <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">SQL 预览</span>
        {!error && !loading && (
          <span className="shrink-0 rounded-full border border-border/70 bg-muted px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-muted-foreground">
            {lines.length} 行 · {stmtCount} 条语句
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">建表 DDL（由内省元数据合成）</span>
        <button
          onClick={() => void copy()}
          className={`shrink-0 text-[length:calc(var(--pref-fs)*0.786)] ${copied ? 'text-success' : 'text-primary hover:underline'}`}
          title="复制到剪贴板"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* 代码区：行号列（横向滚动时吸附左侧）+ 不换行高亮代码 */}
      <div className="flex min-h-0 flex-1 overflow-auto bg-background font-mono text-[length:calc(var(--pref-fs)*0.786)] leading-5">
        {!error && !loading && (
          <div className="sticky left-0 z-10 shrink-0 select-none border-r border-border bg-background px-2 py-3 text-right text-muted-foreground tabular-nums">
            {lines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
        )}
        <pre className="min-w-0 flex-1 whitespace-pre p-3 text-foreground">
          {error ? <span className="text-destructive">加载失败：{error}</span> : loading ? '生成中…' : highlightSql(displayDdl)}
        </pre>
      </div>
    </div>
  );
}

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
      <div className="w-[400px] rounded-lg border border-border bg-muted p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">新增索引</div>
        <div className="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-2 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
          <span>索引名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`留空自动生成 idx_${tableName}_…`}
            className={ddlInputCls}
          />
          <span>列</span>
          <div className="max-h-32 overflow-auto rounded border border-border bg-background p-1.5">
            {columns.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-foreground">
                <input type="checkbox" checked={cols.includes(c)} onChange={() => toggleCol(c)} />
                {c}
              </label>
            ))}
            {columns.length === 0 && <span className="text-muted-foreground">（无列元数据，请先打开「列」子页加载结构）</span>}
          </div>
          <span>唯一</span>
          <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-foreground">
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
        <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
          将执行：CREATE {unique ? 'UNIQUE ' : ''}INDEX <span className="font-mono">{autoName()}</span> ON … ({cols.join(', ')}){isPg && method ? ` USING ${method}` : ''}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-7" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm" className="h-7"
            disabled={!canSubmit}
            onClick={() => onSubmit(autoName(), cols, unique, method)}
          >
            确定
          </Button>
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
      <div className="w-[440px] rounded-lg border border-border bg-muted p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">新增外键</div>
        <div className="grid grid-cols-[76px_1fr] items-center gap-x-2 gap-y-2 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
          <span>约束名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`留空自动生成 fk_${tableName}_…`}
            className={ddlInputCls}
          />
          <span>本表列</span>
          <div className="max-h-28 overflow-auto rounded border border-border bg-background p-1.5">
            {columns.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-foreground">
                <input type="checkbox" checked={cols.includes(c)} onChange={() => toggleCol(c)} />
                {c}
              </label>
            ))}
            {columns.length === 0 && <span className="text-muted-foreground">（无列元数据，请先打开「列」子页加载结构）</span>}
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
          <div className="min-h-[28px] rounded border border-border bg-background p-1.5">
            {refColsLoading ? (
              <span className="text-muted-foreground">加载引用表列…</span>
            ) : refColOptions ? (
              <div className="max-h-28 overflow-auto">
                {refColOptions.map((c) => (
                  <label key={c} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.786)] text-foreground">
                    <input type="checkbox" checked={refCols.includes(c)} onChange={() => toggleRefCol(c)} />
                    {c}
                  </label>
                ))}
                {refColOptions.length === 0 && <span className="text-muted-foreground">（引用表无列元数据）</span>}
              </div>
            ) : (
              <input
                value={refColsManual}
                onChange={(e) => setRefColsManual(e.target.value)}
                placeholder="手输引用列，逗号分隔，如 id"
                className="h-6 w-full border-0 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none placeholder:text-muted-foreground"
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
        <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
          将执行：ALTER TABLE … ADD CONSTRAINT <span className="font-mono">{autoName()}</span> FOREIGN KEY ({cols.join(', ')}) REFERENCES {refTable.trim() || '…'} ({effectiveRefCols.join(', ')})
          {onDelete && ` ON DELETE ${onDelete}`}{onUpdate && ` ON UPDATE ${onUpdate}`}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="h-7" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm" className="h-7"
            disabled={!canSubmit}
            onClick={() => onSubmit(autoName(), cols, refTable.trim(), effectiveRefCols, onDelete, onUpdate)}
          >
            确定
          </Button>
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
      <div className="w-[480px] rounded-lg border border-border bg-muted p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">新建触发器</div>
        <div className="grid grid-cols-[64px_1fr] items-start gap-x-2 gap-y-2 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
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
        <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
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
          <Button variant="outline" size="sm" className="h-7" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="sm" className="h-7"
            disabled={!canSubmit}
            onClick={() => onSubmit(autoName(), timing, event, body)}
          >
            确定
          </Button>
        </div>
      </div>
    </div>
  );
}

/** SQL 查询标签页（CodeMirror 编辑器 + 分页结果集：默认按行数限制档位取回，滚动到底自动追加下一页） */

/** SQL 查询标签页（CodeMirror 编辑器 + 分页结果网格 + 顶部连接信息栏） */
/** 查询结果区页签（数据表 / 结果 / 消息，Navicat 式下划线高亮） */
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

/** 复制/粘贴用单元格文本：null/undefined→空串（保留 TSV/Excel 中 NULL 的空位语义），
 * Date→本地时区 YYYY-MM-DD HH:MM:SS（与 fmt 显示完全一致），对象→JSON，其余→原值字符串。
 * 与 fmt 的区别只在于 null 返回空串而非 "NULL" 字面量，避免复制进表格/SQL 时把空值变成文本 "NULL"。 */
export function cellCopyText(v: unknown, dataType?: string): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : fmtDate(v, dataType);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 内联编辑器初始值：NULL 单元格以空串开局（空串提交即 NULL），避免把显示用的 "NULL" 字面量填进输入框当成文本写回 */
function editInit(v: unknown, dataType?: string): string {
  return v === null || v === undefined ? '' : fmt(v, dataType);
}

/** 编辑提交的 NULL 感知守卫：判断用户是否真的改了值。
 *  - 原值为 NULL 且输入仍为空串 → 无改动（点开又点走不污染编辑态）；
 *  - 其余情况：将原值按与编辑框一致的格式化（fmt，含 dataType）与新输入比较，
 *    仅当真正不同才视为改动，避免双击进入编辑又无修改退出被误判为「变动」。 */
function editChanged(orig: unknown, nv: string, dataType?: string): boolean {
  if (nv === '' && (orig === null || orig === undefined)) return false;
  const origStr = orig === null || orig === undefined ? '' : fmt(orig, dataType);
  return origStr !== nv;
}

/**
 * 把用户输入值转为 SQL 字面量（基础版，单用户工具内部使用）。
 * - 空串 → NULL（清空单元格即置空，符合 DBeaver 习惯）；
 * - 数值类型 → 裸数字；否则加单引号并转义。
 * - 整数不再走 Number() 往返：19 位雪花 ID 会被舍成 15 位精度（末尾变 0），直接原样输出。
 */
function sqlVal(dataType: string, raw: unknown): string {
  // 日期/时间：先格式化为本地时区 YYYY-MM-DD HH:MM:SS（纯 date 仅日期），再按字符串字面量加引号，
  // 避免 Date 对象被 String() 转成 "Wed Nov 18 2020..." 污染生成的 SQL
  if (raw instanceof Date) {
    const s = Number.isNaN(raw.getTime()) ? '' : fmtDate(raw, dataType);
    return s ? `'${s.replace(/'/g, "''")}'` : 'NULL';
  }
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
        className="h-full w-full min-w-0 bg-background px-1 text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none"
      />
      {open && pos && createPortal(
        <div
          ref={popupRef}
          data-dt-cell-editor
          className="fixed z-50 w-[240px] rounded-md border border-border bg-popover p-2 text-foreground shadow-lg"
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
                <button className="rounded px-1 text-muted-foreground hover:bg-secondary hover:text-foreground" title="上一年" onClick={() => setVy((v) => v - 1)}>«</button>
                <button className="rounded px-1 text-muted-foreground hover:bg-secondary hover:text-foreground" title="上月" onClick={() => { vm === 0 ? (setVy((v) => v - 1), setVm(11)) : setVm((m) => m - 1); }}>‹</button>
                <span className="text-[length:calc(var(--pref-fs)*0.857)] font-medium tabular-nums">{vy}-{p2(vm + 1)}</span>
                <button className="rounded px-1 text-muted-foreground hover:bg-secondary hover:text-foreground" title="下月" onClick={() => { vm === 11 ? (setVy((v) => v + 1), setVm(0)) : setVm((m) => m + 1); }}>›</button>
                <button className="rounded px-1 text-muted-foreground hover:bg-secondary hover:text-foreground" title="下一年" onClick={() => setVy((v) => v + 1)}>»</button>
              </div>
              <div className="grid grid-cols-7 gap-px text-center text-[length:calc(var(--pref-fs)*0.714)]">
                {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
                  <span key={w} className="py-0.5 text-muted-foreground">{w}</span>
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
                      className={`rounded py-0.5 tabular-nums hover:bg-primary hover:text-white ${
                        isSelDay(d) ? 'bg-primary text-white' : isToday(d) ? 'text-primary' : 'text-foreground'
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
              <span className="text-muted-foreground">:</span>
              <TimeNum value={mm} max={59} onChange={(v) => setTime(hh, v, ss)} />
              <span className="text-muted-foreground">:</span>
              <TimeNum value={ss} max={59} onChange={(v) => setTime(hh, mm, v)} />
            </div>
          )}
          <div className="mt-1 flex items-center gap-1 border-t border-border pt-1 text-[length:calc(var(--pref-fs)*0.786)]">
            <button
              className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
              title="置为 NULL"
              onClick={() => { setOpen(false); commit(''); }}
            >
              NULL
            </button>
            <div className="flex-1" />
            <button className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={setNow}>
              现在
            </button>
            <button
              className="rounded bg-primary px-2 py-0.5 text-white hover:bg-primary"
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
      className="w-9 rounded border border-border bg-background px-1 text-center text-[length:calc(var(--pref-fs)*0.786)] tabular-nums text-foreground outline-none focus:border-primary"
    />
  );
}
