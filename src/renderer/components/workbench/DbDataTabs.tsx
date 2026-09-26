import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { useAppStore, type DbTab } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import { useScriptStore } from '@renderer/store/scriptStore';
import type { DbColumn, DbColumnSpec, DbForeignKey, DbIndex, DbObjectDef, DbObjectMeta, DbSequenceInfo, DbTrigger, DbUser, DbUserPrivEdit, DbUserPrivilege, DbUserSpec, QueryColumn, QueryResult } from '@shared/types';
import { ErrorBox } from '@renderer/components/common/States';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { CreateTableDialog } from '@renderer/components/common/CreateTableDialog';
import { SqlEditor } from '@renderer/components/workbench/SqlEditor';
import { ConnIcon } from '@renderer/components/workbench/DbTree';
import { RedisScreen } from '@renderer/screens/Redis/RedisScreen';

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

  return (
    <div className={`relative min-w-0 ${className ?? 'flex-1'}`}>
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
        title={title}
        className="h-5 w-full rounded-sm border border-line bg-bg px-1.5 font-mono text-[10px] text-fg outline-none placeholder:text-dim2/60 focus:border-accent"
      />
      {sug && (
        <div className="absolute left-0 top-full z-30 mt-0.5 max-h-44 min-w-40 overflow-auto rounded border border-line bg-panel2 py-0.5 shadow-lg">
          {sug.items.map((it, i) => (
            <div
              key={it}
              onMouseDown={(e) => {
                e.preventDefault();
                apply(it);
              }}
              className={`cursor-pointer px-2 py-0.5 font-mono text-[10px] ${i === sug.idx ? 'bg-panel3 text-accent' : 'text-fg'}`}
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
  /** 当前单元格所在列（Navicat 风格整列高亮） */
  const [curCol, setCurCol] = useState<string | null>(null);
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

  /** 脏数据计数（编辑 + 新增 + 删除） */
  const dirtyCount = Object.keys(edits).length + newRows.length + deleted.size;

  const reload = async (lim = limit) => {
    setLoading(true);
    setError(null);
    try {
      const { where, orderBy } = filterRef.current;
      const fl = {
        where: quoteWhereValues(where, colMeta) || undefined,
        orderBy: orderBy.trim() || undefined,
      };
      const [res, cols] = await Promise.all([api.tableData(connId, db, table, lim, pgDb, 0, fl), api.listColumns(connId, db ?? '', table, pgDb)]);
      setResult(res);
      setColMeta(cols);
      setFetchedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
      setPkCols(cols.filter((c) => c.key === 'PRI').map((c) => c.name));
      setHasMore(res.rowCount >= lim);
      setLoadingMore(false);
    } catch (e) {
      setError((e as Error).message);
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

  /** 懒加载设计元数据（索引/外键/触发器），按子页按需请求，避免重复调用 */
  const loadDesign = async (which: 'indexes' | 'foreign' | 'triggers') => {
    if (designLoaded.has(which)) return;
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

  /** Ctrl+F / Cmd+F（数据子页）：聚焦筛选栏 where 输入框 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && subTab === 'data') {
        const el = whereInputRef.current;
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [subTab]);

  /** 回滚所有未提交改动 */
  const rollback = () => {
    setEdits({});
    setNewRows([]);
    setDeleted(new Set());
    setSelected(null);
    setCurCol(null);
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
        await api.runSql(connId, sql);
      }
      rollback();
      await reload();
      setCommitMsg(`已提交 ${stmts.length} 条语句`);
    } catch (e) {
      setCommitMsg(`提交失败：${(e as Error).message}`);
    } finally {
      setCommitting(false);
    }
  };

  const setEdit = (ri: number, col: string, val: string) =>
    setEdits((m) => ({ ...m, [`${ri}::${col}`]: val }));

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

  /** 导出当前结果集为 CSV（带 BOM，Excel 直接打开不乱码） */
  const exportCsv = () => {
    const esc = (v: unknown, dt?: string) => {
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
            <IBtn title="提交改动（生成并执行 UPDATE/INSERT/DELETE）" onClick={() => void commit()} disabled={committing || dirtyCount === 0} accent icon={
              <><path d="M5 13l4 4L19 7" /></>
            } />
            <IBtn title="回滚未提交改动" onClick={rollback} disabled={dirtyCount === 0} icon={
              <><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 6 6v1" /></>
            } />
          </>
        )}
        <span className="ml-2 truncate text-[11px] text-dim2" title={pkCols.length ? `主键 ${pkCols.join(', ')}` : '无主键（只读）'}>
          {db ? `${db}.` : ''}{table}
          {pkCols.length > 0 ? '' : ' · 只读'}
        </span>
        {commitMsg && <span className="ml-2 truncate text-[10px] text-dim">{commitMsg}</span>}
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
              className={`rounded px-2 text-[10px] leading-4 ${subTab === t.k ? 'bg-panel3 text-fg' : 'text-dim2 hover:text-fg'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {subTab === 'data' ? (
        <>
          {/* 筛选栏（Navicat 风格）：左边 where 条件、右边 order by，回车执行真实查询；Esc 清空恢复全量；输入时提示字段名 */}
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2">
            <span className="shrink-0 font-mono text-[10px] text-dim2">where</span>
            <FilterInput
              className="w-1/3"
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
              title="回车执行查询；Esc 清空。支持任意 SQL WHERE 表达式（and / or / in / like / > < = 等）；输入字段名时自动提示"
            />
            <span className="ml-1 shrink-0 font-mono text-[10px] text-dim2">order by</span>
            <FilterInput
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
            /* 记录视图：选中行竖排展示（Tab 再次按下还原表格） */
            <RecordDetailView
              columns={columns}
              pkCols={pkCols}
              rows={displayRows}
              ri={selected}
              edits={edits}
              deleted={deleted.has(selected)}
              onBack={() => setDetail(false)}
            />
          ) : result ? (
            <EditableGrid
              columns={columns}
              pkCols={pkCols}
              displayRows={displayRows}
              newRows={newRows}
              edits={edits}
              deleted={deleted}
              editing={editing}
              selected={selected}
              curCol={curCol}
              editable={editable}
              sort={sort}
              onCellDblClick={(ri, col) => setEditing({ ri, col })}
              onCellChange={(ri, col, val) => setEdit(ri, col, val)}
              onEditEnd={() => setEditing(null)}
              onNewChange={(i, col, val) =>
                setNewRows((r) => r.map((row, idx) => (idx === i ? { ...row, [col]: val } : row)))
              }
              onSelectRow={(ri, col) => { setSelected(ri); setCurCol(col); gridWrapRef.current?.focus(); }}
              onSort={toggleSort}
              isPg={isPg}
            />
          ) : (
            <div className="p-3 text-[11px] text-dim2">加载中…</div>
          )}
        </div>
        </>
      ) : subTab === 'columns' ? (
        /* 列结构子页（DBeaver 属性页风格） */
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <ErrorBox message={error} onRetry={() => void reload()} />
          ) : (
            <ColumnsView meta={colMeta} loading={loading} ddlMsg={ddlMsg} onAdd={() => setAddColOpen(true)} onDrop={(n) => void submitDropColumn(n)} />
          )}
        </div>
      ) : subTab === 'indexes' ? (
        <IndexListView
          items={indexes}
          loading={designLoading}
          error={designErr}
          onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'indexes'))); void loadDesign('indexes'); }}
        />
      ) : subTab === 'foreign' ? (
        <ForeignKeyListView
          items={fks}
          loading={designLoading}
          error={designErr}
          onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'foreign'))); void loadDesign('foreign'); }}
        />
      ) : subTab === 'triggers' ? (
        <TriggerListView
          items={trigs}
          loading={designLoading}
          error={designErr}
          onReload={() => { setDesignLoaded(new Set([...designLoaded].filter((x) => x !== 'triggers'))); void loadDesign('triggers'); }}
        />
      ) : (
        <DdlView ddl={buildTableDdl(conn?.kind ?? 'postgres', db, table, colMeta, indexes, fks, trigs)} loading={designLoading} error={designErr} />
      )}

      {/* 底部状态栏（DBeaver 风格：行数/耗时/时间 + 导出 + 行数限制） */}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-2 text-[10px] text-dim2">
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
          className="rounded border border-line bg-bg px-1 text-[10px] text-dim outline-none"
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
    </div>
  );
}

/**
 * 对象清单标签页（DBeaver 风格）：单击树上「表/视图/物化视图」分类时打开。
 * 列出模式内全部对象及注释，Ctrl+F 聚焦搜索框，双击行直接打开表数据。
 */
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
        <span className="text-[11px] font-medium text-fg">
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
            className="w-full bg-transparent text-[11px] text-fg outline-none placeholder:text-dim2"
          />
          {kw && (
            <button onClick={() => setKw('')} className="text-[10px] text-dim2 hover:text-fg" title="清空搜索">
              ✕
            </button>
          )}
        </div>
        <button onClick={() => void load()} disabled={loading} className="text-[10px] text-dim2 hover:text-fg disabled:opacity-40" title="刷新">
          {loading ? '加载中…' : '刷新'}
        </button>
        <span className="ml-auto text-[10px] text-dim2">
          {items ? `${filtered.length}${k ? ` / ${items.length}` : ''} 个对象` : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-panel2 text-left text-dim2">
                <th className="w-12 border-b border-line px-2 py-1 text-right font-medium">#</th>
                <th className="border-b border-line px-2 py-1 font-medium">名称</th>
                <th className="border-b border-line px-2 py-1 font-medium">注释</th>
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
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-dim2">
                    {items && k ? '无匹配对象' : items ? '（空）' : '加载中…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部状态栏 */}
      <div className="flex h-6 shrink-0 items-center border-t border-line bg-panel px-2 text-[10px] text-dim2">
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
/** 记录视图（选中行按 Tab 切换）：该行竖排为 字段名 / 值 两列，Navicat「记录」页风格 */
function RecordDetailView({ columns, pkCols, rows, ri, edits, deleted, onBack }: {
  columns: QueryColumn[];
  pkCols: string[];
  /** 筛选排序后的展示行（含原始行索引） */
  rows: { ri: number; row: Record<string, unknown> }[];
  /** 选中的原始行索引 */
  ri: number;
  /** 未提交编辑（应用后展示） */
  edits: Record<string, string>;
  /** 该行是否被标记删除 */
  deleted: boolean;
  onBack: () => void;
}) {
  const ent = rows.find(({ ri: r }) => r === ri);
  if (!ent) {
    return <div className="p-3 text-[11px] text-dim2">该行已不在当前筛选/排序结果中（按 Tab 返回表格）。</div>;
  }
  const isNumCol = (dataType?: string) => /int|decimal|numeric|float|double|real|number|bit|serial|money/i.test(dataType ?? '');
  return (
    <div className="p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded bg-accent/20 px-1.5 text-[10px] text-accent">记录视图 · 第 {ri + 1} 行</span>
        {deleted && <span className="text-[10px] text-prod">已标记删除</span>}
        <button onClick={onBack} className="ml-auto rounded border border-line px-1.5 py-px text-[10px] text-dim hover:bg-panel3" title="返回表格（也可按 Tab）">
          返回表格 (Tab)
        </button>
      </div>
      <table className="w-full border-collapse text-[11px]">
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
            return (
              <tr key={c.name} className="hover:bg-[rgb(255_255_255_/_0.03)]">
                <td className="whitespace-nowrap border-b border-r border-line bg-panel px-2 py-1 align-top" title={`${c.name}${c.dataType ? ` · ${c.dataType}` : ''}`}>
                  <span className="flex items-center gap-1">
                    <ColTypeIcon dataType={c.dataType} isPk={pkCols.includes(c.name)} />
                    <span className="font-medium text-fg">{c.name}</span>
                    {pkCols.includes(c.name) && <span className="text-[9px] text-[#e8b339]">PK</span>}
                    {c.dataType && <span className="text-[9px] text-dim2">{c.dataType}</span>}
                  </span>
                </td>
                <td className={`border-b border-line px-2 py-1 ${isNumCol(c.dataType) && !isNull ? 'text-right tabular-nums' : ''}`}>
                  {isNull ? (
                    <span className="italic text-dim2">(Null)</span>
                  ) : (
                    <span className={`block whitespace-pre-wrap break-all text-fg ${edits[key] !== undefined ? 'bg-[#3a2f12]/60' : ''}`}>{fmt(raw, c.dataType)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EditableGrid({
  columns,
  pkCols,
  displayRows,
  newRows,
  edits,
  deleted,
  editing,
  selected,
  curCol,
  editable,
  sort,
  onCellDblClick,
  onCellChange,
  onEditEnd,
  onNewChange,
  onSelectRow,
  onSort,
}: {
  columns: QueryColumn[];
  pkCols: string[];
  /** 筛选排序后的展示行（ri=原始行索引） */
  displayRows: { ri: number; row: Record<string, unknown> }[];
  newRows: Record<string, string>[];
  edits: Record<string, string>;
  deleted: Set<number>;
  editing: { ri: number; col: string } | null;
  selected: number | null;
  /** 当前单元格所在列（整列高亮） */
  curCol: string | null;
  editable: boolean;
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  onCellDblClick: (ri: number, col: string) => void;
  onCellChange: (ri: number, col: string, val: string) => void;
  onEditEnd: () => void;
  onNewChange: (i: number, col: string, val: string) => void;
  onSelectRow: (ri: number, col: string) => void;
  onSort: (col: string) => void;
  isPg: boolean;
}) {
  /** 数值列右对齐（Navicat 习惯） */
  const isNumCol = (dataType?: string) => /int|decimal|numeric|float|double|real|number|bit|serial|money/i.test(dataType ?? '');
  // 当前单元格整列高亮 / 选中行的底色（暗色主题下用主题蓝透明叠加，等价 Navicat 的浅蓝高亮）
  const colTint = 'bg-[rgb(14_99_156_/_0.16)]';
  const colTintHead = 'bg-[rgb(14_99_156_/_0.30)]';
  const rowSelBg = 'bg-[rgb(14_99_156_/_0.30)]';
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead className="sticky top-0 z-10">
        {/* 表头：图标 + 列名，点击排序（asc → desc → 取消） */}
        <tr className="bg-panel2">
          <th className="w-9 border-b-2 border-r border-line bg-panel px-1 py-1 text-right text-dim2">#</th>
          {columns.map((c) => {
            const isSorted = sort?.col === c.name;
            const isCur = curCol === c.name;
            return (
              <th
                key={c.name}
                onClick={() => onSort(c.name)}
                title={`${c.name}${c.dataType ? ` · ${c.dataType}` : ''}${c.nullable === false ? ' · NOT NULL' : ''}（点击排序）`}
                className={`cursor-pointer select-none whitespace-nowrap border-b-2 border-r border-line px-2 py-1 text-left font-medium ${isCur ? colTintHead : 'bg-panel2 hover:bg-panel3'} ${isSorted ? 'text-accent' : 'text-fg'}`}
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
          const isSel = selected === ri;
          const isDirty = [...Object.keys(edits)].some((k) => k.startsWith(`${ri}::`));
          return (
            <tr
              key={`b${ri}`}
              className={`${isDeleted ? 'opacity-40 line-through' : ''} ${isDirty && !isSel ? 'bg-[#3a2f12]' : 'hover:bg-[rgb(255_255_255_/_0.03)]'}`}
              onClick={() => onSelectRow(ri, columns[0]?.name ?? '')}
            >
              <td
                className={`cursor-pointer border-b border-r border-line bg-panel px-1 py-[3px] text-right ${isSel ? 'font-semibold text-accent' : 'text-dim2'}`}
                onClick={(e) => { e.stopPropagation(); onSelectRow(ri, curCol ?? columns[0]?.name ?? ''); }}
                title="点击选中该行（标记删除请用工具栏「删除选中行」按钮；选中后按 Tab 切换记录视图）"
              >
                {order + 1}
              </td>
              {columns.map((c) => {
                const key = `${ri}::${c.name}`;
                const isEditing = editing?.ri === ri && editing?.col === c.name;
                const isCurCell = isSel && curCol === c.name;
                const val = edits[key] !== undefined ? edits[key] : row[c.name];
                const cellBg = isSel ? rowSelBg : curCol === c.name ? colTint : '';
                const num = isNumCol(c.dataType);
                return (
                  <td
                    key={c.name}
                    className={`max-w-[280px] border-b border-r border-line px-2 py-[3px] ${cellBg} ${num ? 'text-right tabular-nums' : 'text-fg'} ${isCurCell && !isEditing ? 'outline outline-1 -outline-offset-1 outline-[rgb(90_170_240)]' : ''}`}
                    onClick={(e) => { e.stopPropagation(); onSelectRow(ri, c.name); }}
                    onDoubleClick={() => editable && onCellDblClick(ri, c.name)}
                    title={editable ? '双击编辑' : undefined}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        defaultValue={edits[key] ?? fmt(row[c.name], c.dataType)}
                        onBlur={(e) => {
                          onCellChange(ri, c.name, e.target.value);
                          onEditEnd();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            onCellChange(ri, c.name, (e.target as HTMLInputElement).value);
                            onEditEnd();
                          }
                          if (e.key === 'Escape') onEditEnd();
                        }}
                        className="w-full bg-bg px-1 text-[11px] text-fg outline outline-1 outline-accent"
                      />
                    ) : (
                      <span className={val === null || val === undefined ? 'italic text-dim2' : 'block truncate'}>{val === null || val === undefined ? '(Null)' : fmt(val, c.dataType)}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}

        {/* 新增行 */}
        {newRows.map((nr, i) => (
          <tr key={`n${i}`} className="bg-[#123524]">
            <td className="border-b border-r border-line bg-panel px-1 py-[3px] text-right text-ok" title="新增行">
              +{i + 1}
            </td>
            {columns.map((c) => (
              <td key={c.name} className={`border-b border-r border-line px-2 py-[3px] ${isNumCol(c.dataType) ? 'text-right' : ''}`}>
                <input
                  value={nr[c.name] ?? ''}
                  onChange={(e) => onNewChange(i, c.name, e.target.value)}
                  placeholder={pkCols.includes(c.name) ? '自增可留空' : ''}
                  className="w-full bg-transparent text-[11px] text-fg outline-none placeholder:text-dim2"
                />
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

/** 属性子页：列结构一览（DBeaver 属性页风格）+ 结构编辑（新增/删除字段） */
function ColumnsView({ meta, loading, ddlMsg, onAdd, onDrop }: {
  meta: DbColumn[];
  loading: boolean;
  ddlMsg: string | null;
  onAdd: () => void;
  onDrop: (name: string) => void;
}) {
  if (loading && meta.length === 0) return <div className="p-3 text-[11px] text-dim2">加载列结构…</div>;
  return (
    <div>
      {/* 结构编辑工具条：新增字段 + 操作结果提示 */}
      <div className="flex items-center gap-2 border-b border-line bg-panel px-2 py-1">
        <button
          onClick={onAdd}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-panel3"
          title="新增字段（ALTER TABLE ADD COLUMN）"
        >
          ＋ 新增字段
        </button>
        {ddlMsg && <span className="text-[10px] text-dim2">{ddlMsg}</span>}
      </div>
      <table className="w-full border-collapse text-[11px]">
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
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">
                {c.key === 'PRI' && <span className="mr-1 text-warn" title="主键">🔑</span>}
                {c.name}
              </td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">{c.fullType ?? c.dataType}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-accent">
                {c.extra === 'auto_increment' ? 'auto_increment' : c.extra === 'identity' ? 'identity' : ''}
              </td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-dim">{c.collation ?? ''}</td>
              <td className="border-b border-r border-line px-2 py-1 text-center text-dim2">{c.nullable ? '' : '√'}</td>
              <td className="max-w-[220px] truncate border-b border-r border-line px-2 py-1 text-dim" title={c.defaultValue ?? ''}>
                {c.defaultValue ?? ''}
              </td>
              <td className="max-w-[320px] truncate border-b border-r border-line px-2 py-1 text-dim" title={c.comment ?? ''}>
                {c.comment ?? ''}
              </td>
              <td className="border-b border-line px-2 py-1 text-center">
                <button
                  onClick={() => onDrop(c.name)}
                  className="text-[10px] text-prod hover:underline"
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

/** 由内省元数据合成 CREATE TABLE DDL（方言感知：PG/Oracle 双引号、MySQL 反引号） */
function buildTableDdl(dialect: string, schema: string | undefined, table: string, cols: DbColumn[], indexes: DbIndex[], fks: DbForeignKey[], trigs: DbTrigger[]): string {
  try {
    const q = (n: string) => (dialect === 'mysql' ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`);
    const tbl = schema ? `${q(schema)}.${q(table)}` : q(table);
    const isPg = dialect === 'postgres';
    const isMysql = dialect === 'mysql';
    const colLines = (cols ?? []).map((c) => {
      const name = c?.name ?? 'unknown_column';
      const type = c?.fullType ?? c?.dataType ?? 'unknown_type';
      let line = `  ${q(name)} ${type}`;
      if (isPg && c?.extra === 'identity') line += ' GENERATED BY DEFAULT AS IDENTITY';
      if (!c?.nullable) line += ' NOT NULL';
      if (c?.defaultValue != null && c?.defaultValue !== '') line += ` DEFAULT ${c.defaultValue}`;
      if (isMysql && c?.extra === 'auto_increment') line += ' AUTO_INCREMENT';
      return line;
    });
    const pk = (cols ?? []).filter((c) => c?.key === 'PRI').map((c) => q(c.name));
    if (pk.length) colLines.push(`  PRIMARY KEY (${pk.join(', ')})`);
    let ddl = `CREATE TABLE ${tbl} (\n${colLines.join(',\n')}\n);`;
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
function IndexListView({ items, loading, error, onReload }: { items: DbIndex[]; loading: boolean; error: string | null; onReload: () => void }) {
  if (error) return <div className="p-3 text-[11px] text-prod">加载索引失败：{error} <button onClick={onReload} className="ml-2 text-accent hover:underline">重试</button></div>;
  if (loading && items.length === 0) return <div className="p-3 text-[11px] text-dim2">加载索引…</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[11px]">
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
  );
}

/** 表设计器「外键」子页 */
function ForeignKeyListView({ items, loading, error, onReload }: { items: DbForeignKey[]; loading: boolean; error: string | null; onReload: () => void }) {
  if (error) return <div className="p-3 text-[11px] text-prod">加载外键失败：{error} <button onClick={onReload} className="ml-2 text-accent hover:underline">重试</button></div>;
  if (loading && items.length === 0) return <div className="p-3 text-[11px] text-dim2">加载外键…</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[11px]">
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
  );
}

/** 表设计器「触发器」子页 */
function TriggerListView({ items, loading, error, onReload }: { items: DbTrigger[]; loading: boolean; error: string | null; onReload: () => void }) {
  if (error) return <div className="p-3 text-[11px] text-prod">加载触发器失败：{error} <button onClick={onReload} className="ml-2 text-accent hover:underline">重试</button></div>;
  if (loading && items.length === 0) return <div className="p-3 text-[11px] text-dim2">加载触发器…</div>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-[11px]">
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

/** 表设计器「SQL 预览」子页：展示由元数据合成的 CREATE TABLE + 索引/外键/触发器 */
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
        <span className="text-[10px] text-dim2">建表 DDL 预览（由内省元数据合成）</span>
        <button onClick={() => void copy()} className="ml-auto text-[10px] text-accent hover:underline" title="复制到剪贴板">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-bg p-3 font-mono text-[11px] leading-5 text-fg border-t border-line">
        {error ? <span className="text-prod">加载失败：{error}</span> : loading ? '生成中…' : displayDdl}
      </pre>
    </div>
  );
}

const ddlInputCls = 'h-7 w-full rounded border border-line bg-bg px-2 text-[11px] text-fg outline-none placeholder:text-dim2 focus:border-accent/60';

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
        <div className="mb-3 text-[12px] font-semibold text-fg">新增字段</div>
        <div className="grid grid-cols-[64px_1fr] items-center gap-x-2 gap-y-2 text-[11px] text-dim">
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
              <label className="flex items-center gap-1.5 text-[11px] text-fg">
                <input type="checkbox" checked={autoIncrement} onChange={(e) => setAutoIncrement(e.target.checked)} />
                AUTO_INCREMENT（需为主键或唯一索引）
              </label>
            </>
          )}
          <span>非空</span>
          <label className="flex items-center gap-1.5 text-[11px] text-fg">
            <input type="checkbox" checked={!nullable} onChange={(e) => setNullable(!e.target.checked)} />
            NOT NULL
          </label>
          <span>默认值</span>
          <input value={def} onChange={(e) => setDef(e.target.value)} placeholder="留空表示无；可写 0 / 'x' / CURRENT_TIMESTAMP" className={ddlInputCls} />
          <span>注释</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="字段备注（可选）" className={ddlInputCls} />
        </div>
        {!nameOk && name.trim() !== '' && <div className="mt-2 text-[10px] text-prod">列名仅允许字母、数字、下划线，且以字母或下划线开头</div>}
        {isPg && !typeOk && <div className="mt-2 text-[10px] text-prod">PG 标识列仅支持 smallint / integer / bigint 类型</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="h-7 rounded border border-line px-3 text-[11px] text-dim hover:bg-panel3">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit(buildSpec())}
            className="h-7 rounded bg-accent px-3 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
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
  const lastSqlKey = `dbnest.qsql.conn.${connId}`;
  const tabSqlKey = `dbnest.qsql.tab.${tabId}`;
  const histKey = `dbnest.qhist.${connId}`;
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

  /** 切换当前库 / 模式：MySQL/PG 按库路由连接池（无需会话 USE）；Oracle=ALTER SESSION。切换后重载提示 + 重跑当前 SQL */
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
      void run();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async () => {
    if (busyRef.current) return;
    const text = (sqlRef.current || '').trim();
    if (!text) return;
    busyRef.current = true;
    setLoading(true);
    setError(null);
    lastSqlRef.current = text;
    offsetRef.current = 0;
    try {
      const r = await api.runSqlPaged(connId, text, 0, QUERY_PAGE_SIZE, conn?.kind === 'oracle' ? undefined : activeDbRef.current);
      setColumns(r.result.columns);
      setRows(r.result.rows);
      setTotal(r.total);
      setHasMore(r.hasMore);
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
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-3 text-[11px]">
          <ConnIcon kind={conn.kind} />
          <span className="font-medium text-fg">{conn.name}</span>
          <span className="rounded bg-panel3 px-1.5 py-px text-[9px] text-dim2">{connKindLabel}</span>
          <span className="text-dim2">{conn.host}:{conn.port}</span>
          {conn.username && <span className="text-dim2">· {conn.username}</span>}
          {dbOptions.length > 0 && (
            <span className="ml-auto flex items-center gap-1">
              <span className="text-dim2">库</span>
              <select
                value={currentDb ?? ''}
                onChange={(e) => void switchDb(e.target.value)}
                className="rounded border border-line bg-bg px-1.5 py-px text-[10px] text-fg outline-none hover:border-accent"
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
      <div className="shrink-0 overflow-hidden border-b border-line" style={{ height: editorH }}>
        <SqlEditor initialValue={initSql} schema={schema} onRun={run} onSave={() => setSaveDlg(true)} injectRef={injectRef} onChange={(v) => { sqlRef.current = v; persistSql(v); }} />
      </div>
      {/* 可拖拽分隔条：上下拖动调整编辑器高度 */}
      <div
        onMouseDown={onSplitMouseDown}
        className="group h-1 shrink-0 cursor-row-resize bg-line transition-colors hover:bg-accent"
        title="拖动调整编辑器高度"
      />
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3 text-[11px]">
        <button onClick={run} disabled={loading} className="rounded bg-accent px-2.5 py-0.5 font-medium text-white hover:bg-accent2 disabled:opacity-50">
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
            className="max-w-[240px] rounded border border-line bg-bg px-1.5 py-0.5 text-[10px] text-dim outline-none hover:border-accent"
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
        {error ? (
          <ErrorBox message={error} onRetry={run} />
        ) : columns ? (
          <PagedGrid columns={columns} rows={rows} />
        ) : (
          <div className="p-3 text-[11px] text-dim2">执行 SQL 查看结果（Ctrl/⌘+Enter 运行，Ctrl/⌘+S 保存脚本）</div>
        )}
      </div>
      {/* Ctrl+S 保存脚本弹框 */}
      {saveDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={() => setSaveDlg(false)}>
          <div className="w-72 rounded border border-line bg-panel2 p-3 shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-2 text-[12px] font-medium text-fg">保存脚本</div>
            <input
              autoFocus
              value={scriptName}
              onChange={(e) => setScriptName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSaveScript();
                if (e.key === 'Escape') setSaveDlg(false);
              }}
              placeholder="输入脚本名称"
              className="w-full rounded border border-line bg-bg px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
            />
            <div className="mt-2 text-[10px] text-dim2">同名脚本将覆盖内容 · 保存到左侧连接树「脚本」节点</div>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setSaveDlg(false)} className="rounded border border-line px-2 py-0.5 text-[11px] text-dim hover:bg-panel3">
                取消
              </button>
              <button
                onClick={submitSaveScript}
                disabled={!scriptName.trim()}
                className="rounded bg-accent px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-accent2 disabled:opacity-50"
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
    <table className="w-full border-collapse text-[11px]">
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
    <table className="w-full border-collapse text-[11px]">
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
function DefTab({ connId, kind, pgDb, schema, name }: { connId: string; kind: 'view' | 'mview' | 'function'; pgDb?: string; schema: string; name: string }) {
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
      await api.runSql(connId, text);
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
      setPreview(await api.runSql(connId, `SELECT * FROM ${from} LIMIT 200`));
    } catch (e) {
      setPreviewErr((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <span className="text-[11px] font-medium text-fg">
          {kind === 'function' ? '函数' : kind === 'mview' ? '物化视图' : '视图'} · {schema}.{name}
        </span>
        <button onClick={() => void save()} disabled={saving} className="rounded bg-accent px-2 py-0.5 text-[10px] text-white hover:opacity-90 disabled:opacity-40">
          {saving ? '保存中…' : '保存到数据库'}
        </button>
        <button onClick={() => void api.clipboardWrite(text).catch(() => undefined)} className="rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3">
          复制
        </button>
        {isView && (
          <button onClick={() => void previewData()} className="rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3">
            预览数据
          </button>
        )}
        <button onClick={() => void load()} className="ml-auto rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3">
          刷新
        </button>
      </div>
      {msg && <div className={`shrink-0 px-2 py-1 text-[10px] ${msg.startsWith('保存失败') ? 'text-prod' : 'text-ok'}`}>{msg}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : loading ? (
          <div className="p-3 text-[11px] text-dim2">加载定义…</div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-bg p-3 font-mono text-[11px] leading-5 text-fg outline-none"
          />
        )}
      </div>
      {isView && (preview || previewErr) && (
        <div className="h-[40%] min-h-[120px] shrink-0 overflow-auto border-t border-line">
          {previewErr ? (
            <div className="p-2 text-[10px] text-prod">预览失败：{previewErr}</div>
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
      const r = await api.runSql(connId, sql);
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
        <span className="text-[11px] font-medium text-fg">序列 · {schema}.{name}</span>
        <button onClick={() => void nextval()} className="rounded bg-accent px-2 py-0.5 text-[10px] text-white hover:opacity-90">
          下一个值
        </button>
        <button onClick={() => void load()} className="ml-auto rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3">
          刷新
        </button>
      </div>
      {msg && <div className={`shrink-0 px-2 py-1 text-[10px] ${msg.startsWith('获取失败') ? 'text-prod' : 'text-ok'}`}>{msg}</div>}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : loading ? (
          <div className="text-[11px] text-dim2">加载序列信息…</div>
        ) : (
          <table className="w-full border-collapse text-[11px]">
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
        <span className="text-[11px] font-medium text-fg">用户与权限管理</span>
        <span className="rounded bg-panel3 px-1.5 py-0.5 text-[10px] text-dim2">{isOra ? 'Oracle' : isMysql ? 'MySQL' : 'PostgreSQL'}</span>
        <button onClick={() => setShowCreate(true)} className="rounded bg-accent px-2 py-0.5 text-[10px] text-white hover:opacity-90">
          新建用户
        </button>
        <button onClick={() => void load()} className="ml-auto rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3">
          刷新
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 用户列表 */}
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <ErrorBox message={error} onRetry={() => void load()} />
          ) : loading ? (
            <div className="p-3 text-[11px] text-dim2">加载用户…</div>
          ) : users.length === 0 ? (
            <div className="p-3 text-[11px] text-dim2">（无用户）</div>
          ) : (
            <table className="w-full border-collapse text-[11px]">
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
                      <button onClick={() => void viewPrivs(u)} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-dim hover:bg-panel3">权限</button>
                      <button onClick={() => void del(u)} className="ml-1 rounded border border-line px-1.5 py-0.5 text-[10px] text-prod hover:bg-panel3">删除</button>
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
              <span className="truncate text-[10px] text-dim2">权限 · {selected.host ? `${selected.name}@${selected.host}` : selected.name}</span>
              <button onClick={() => void viewPrivs(selected)} className="ml-auto rounded border border-line px-1.5 py-0.5 text-[10px] text-dim hover:bg-panel3">
                刷新
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {privError ? (
                <div className="text-[10px] text-prod">{privError}</div>
              ) : privLoading ? (
                <div className="text-[10px] text-dim2">加载权限…</div>
              ) : (
                <>
                  <PrivEditor connId={connId} kind={dialect} user={selected} privs={privs} users={users} onApplied={() => { void viewPrivs(selected); void load(); }} />
                  <div className="mb-1 mt-3 text-[10px] font-medium text-dim2">当前授权明细</div>
                  {privs.length === 0 ? (
                    <div className="text-[10px] text-dim2">（无显式授权）</div>
                  ) : (
                    <ul className="space-y-1">
                      {privs.map((p, i) => (
                        <li key={i} className="rounded border border-line bg-panel2 px-2 py-1 text-[10px]">
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
  const lab = 'flex items-center gap-1 text-[10px] text-fg';
  return (
    <div className="rounded border border-line bg-panel2 p-2">
      <div className="mb-1.5 text-[10px] font-medium text-dim2">权限编辑（调整后点「应用」生效）</div>
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
          <div className="mt-2 text-[10px] text-dim2">角色成员（× 移除）</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {pgMembers.length === 0 && <span className="text-[10px] text-dim2">（无）</span>}
            {pgMembers.map((r) => (
              <span key={r} className="flex items-center gap-1 rounded bg-panel3 px-1.5 py-0.5 text-[10px] text-fg">
                {r}
                <button title="移除该角色" className="text-prod hover:opacity-80" onClick={() => removeMember(r)}>×</button>
              </span>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <select value={pgRoleSel} onChange={(e) => setPgRoleSel(e.target.value)} className="h-5 rounded-sm border border-line bg-bg px-1 text-[10px] text-fg outline-none focus:border-accent">
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
              className="rounded border border-line px-1.5 py-0.5 text-[10px] text-dim hover:bg-panel3 disabled:opacity-40"
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
          <div className="text-[10px] text-dim2">系统权限</div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {ORA_SYS_PRIVS.map((p) => (
              <label key={p} className={lab}>
                <input type="checkbox" className={cb} checked={!!checks[p]} onChange={(e) => setChecks((s) => ({ ...s, [p]: e.target.checked }))} />
                {p}
              </label>
            ))}
          </div>
          <div className="mt-2 text-[10px] text-dim2">角色</div>
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
      {msg && <div className={`mt-1.5 text-[10px] ${msg.ok ? 'text-ok' : 'text-prod'}`}>{msg.text}</div>}
      <button onClick={() => void apply()} disabled={busy} className="mt-2 w-full rounded bg-accent px-2 py-1 text-[10px] text-white hover:opacity-90 disabled:opacity-40">
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

  const fieldCls = 'w-full rounded-sm border border-line bg-bg px-1.5 py-1 text-[11px] text-fg outline-none focus:border-accent';
  const labelCls = 'text-[11px] text-dim';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div className="w-[360px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[12px] font-semibold text-fg">
          新建用户
          <span className="ml-1 rounded bg-panel3 px-1.5 py-0.5 text-[10px] font-normal text-dim2">{isOra ? 'Oracle' : isMysql ? 'MySQL' : 'PostgreSQL'}</span>
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
          <label className="flex items-center gap-1.5 text-[11px] text-fg">
            <input type="checkbox" checked={superuser} onChange={(e) => setSuperuser(e.target.checked)} />
            {isPg ? 'SUPERUSER' : isOra ? '授予 DBA' : 'GRANT ALL PRIVILEGES'}
          </label>
          {isPg && (
            <>
              <span className={labelCls}>可登录</span>
              <label className="flex items-center gap-1.5 text-[11px] text-fg">
                <input type="checkbox" checked={canLogin} onChange={(e) => setCanLogin(e.target.checked)} /> LOGIN
              </label>
              <span className={labelCls}>建库权限</span>
              <label className="flex items-center gap-1.5 text-[11px] text-fg">
                <input type="checkbox" checked={createDb} onChange={(e) => setCreateDb(e.target.checked)} /> CREATEDB
              </label>
            </>
          )}
        </div>
        {err && <div className="mt-2 text-[10px] text-prod">{err}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-line px-3 py-1 text-[11px] text-dim hover:bg-panel3">取消</button>
          <button onClick={() => void submit()} disabled={submitting} className="rounded bg-accent px-3 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40">
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
