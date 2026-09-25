import { useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { useAppStore } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import type { DbColumn, DbColumnSpec, QueryColumn, QueryResult } from '@shared/types';
import { ErrorBox } from '@renderer/components/common/States';

/**
 * 工作台中间区「数据库标签页」内容区。
 *
 * 标签栏由 WorkbenchScreen 渲染（终端标签 + 数据库标签并列）；
 * 本组件仅负责渲染当前激活的表数据 / SQL 查询标签内容。
 *
 * - 表数据标签：DBeaver 风格数据网格——顶部图标工具栏（刷新/提交/回滚/增删行/导出）、
 *   表头点击排序、列筛选行、底部状态栏（行数/耗时/导出/行数限制）；
 *   主键驱动 UPDATE/DELETE，新增行构造 INSERT；
 * - SQL 查询标签：编辑器 + 只读结果集。
 *
 * @since 0.2.0
 */
export function DbDataTabs() {
  const activeDbTab = useAppStore((s) => s.activeDbTab);
  const dbTabs = useAppStore((s) => s.dbTabs);
  const active = dbTabs.find((t) => t.id === activeDbTab) ?? null;

  if (!active) return null;
  return active.type === 'table' ? (
    <TableTab connId={active.connId} db={active.db} pgDb={active.pgDb} table={active.table} />
  ) : (
    <QueryTab connId={active.connId} />
  );
}

/** 行数限制档位（DBeaver 同款：结果集行数上限） */
const LIMITS = [50, 200, 1000, 5000] as const;

/** 表数据标签页（DBeaver 风格）。PG：db=schema、pgDb=库名（跨库） */
function TableTab({ connId, db, pgDb, table }: { connId: string; db?: string; pgDb?: string; table: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const isPg = conn?.kind === 'postgres';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  /** 列属性元数据（属性子页展示：类型/默认值/注释/自增等） */
  const [colMeta, setColMeta] = useState<DbColumn[]>([]);
  /** 子页切换（DBeaver 表编辑器同款）：属性=列结构，数据=可编辑网格 */
  const [subTab, setSubTab] = useState<'data' | 'props'>('data');
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
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  /** 列筛选（客户端过滤，即时生效） */
  const [filters, setFilters] = useState<Record<string, string>>({});
  /** 排序：点击表头 asc → desc → 取消 */
  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(null);
  /** 属性子页：新增字段对话框开关 */
  const [addColOpen, setAddColOpen] = useState(false);
  /** 属性子页：结构操作（新增/删除字段）结果提示 */
  const [ddlMsg, setDdlMsg] = useState<string | null>(null);

  const baseRows = result?.rows ?? [];
  const columns = result?.columns ?? [];
  const editable = pkCols.length > 0;

  /** 脏数据计数（编辑 + 新增 + 删除） */
  const dirtyCount = Object.keys(edits).length + newRows.length + deleted.size;

  const reload = async (lim = limit) => {
    setLoading(true);
    setError(null);
    try {
      const [res, cols] = await Promise.all([api.tableData(connId, db, table, lim, pgDb), api.listColumns(connId, db ?? '', table, pgDb)]);
      setResult(res);
      setColMeta(cols);
      setFetchedAt(new Date().toLocaleString('zh-CN', { hour12: false }));
      setPkCols(cols.filter((c) => c.key === 'PRI').map((c) => c.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setFilters({});
    setSort(null);
    rollback();
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, db, pgDb, table]);

  /** 回滚所有未提交改动 */
  const rollback = () => {
    setEdits({});
    setNewRows([]);
    setDeleted(new Set());
    setSelected(null);
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

  /** 筛选 + 排序后的展示行（保留原始行索引，编辑/删除按它定位） */
  const displayRows = useMemo(() => {
    let list = baseRows.map((row, ri) => ({ ri, row }));
    for (const [col, kw] of Object.entries(filters)) {
      const s = kw.trim().toLowerCase();
      if (!s) continue;
      list = list.filter(({ row }) => {
        const v = row[col];
        const t = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        return t.toLowerCase().includes(s);
      });
    }
    if (sort) {
      const { col, dir } = sort;
      list = [...list].sort((a, b) => {
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
  }, [baseRows, filters, sort]);

  /** 导出当前结果集为 CSV（带 BOM，Excel 直接打开不乱码） */
  const exportCsv = () => {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [
      columns.map((c) => esc(c.name)).join(','),
      ...displayRows.map(({ row }) => columns.map((c) => esc(row[c.name])).join(',')),
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
    <div className="flex h-full flex-col">
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
        {/* 子页切换：属性（列结构）/ 数据（网格），DBeaver 表编辑器同款 */}
        <div className="ml-auto flex items-center gap-0.5 rounded border border-line p-0.5">
          <button
            onClick={() => setSubTab('props')}
            title="列结构（列名/类型/默认值/注释）"
            className={`rounded px-2 text-[10px] leading-4 ${subTab === 'props' ? 'bg-panel3 text-fg' : 'text-dim2 hover:text-fg'}`}
          >
            属性
          </button>
          <button
            onClick={() => setSubTab('data')}
            title="表数据（可编辑网格）"
            className={`rounded px-2 text-[10px] leading-4 ${subTab === 'data' ? 'bg-panel3 text-fg' : 'text-dim2 hover:text-fg'}`}
          >
            数据
          </button>
        </div>
      </div>

      {subTab === 'props' ? (
        /* 属性子页：列结构一览（DBeaver 属性页风格） */
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <ErrorBox message={error} onRetry={() => void reload()} />
          ) : (
            <ColumnsView meta={colMeta} loading={loading} ddlMsg={ddlMsg} onAdd={() => setAddColOpen(true)} onDrop={(n) => void submitDropColumn(n)} />
          )}
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto">
            {error ? (
              <ErrorBox message={error} onRetry={() => void reload()} />
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
            editable={editable}
            filters={filters}
            sort={sort}
            onCellDblClick={(ri, col) => setEditing({ ri, col })}
            onCellChange={(ri, col, val) => setEdit(ri, col, val)}
            onEditEnd={() => setEditing(null)}
            onNewChange={(i, col, val) =>
              setNewRows((r) => r.map((row, idx) => (idx === i ? { ...row, [col]: val } : row)))
            }
            onSelectRow={(ri) => setSelected(ri)}
            onToggleDelete={(ri) => setDeleted((s) => (s.has(ri) ? new Set([...s].filter((x) => x !== ri)) : new Set(s).add(ri)))}
            onFilter={(col, val) => setFilters((f) => ({ ...f, [col]: val }))}
            onSort={toggleSort}
            isPg={isPg}
          />
        ) : (
          <div className="p-3 text-[11px] text-dim2">加载中…</div>
        )}
          </div>
        </>
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
        <span className="ml-auto">
          {subTab === 'props'
            ? `${colMeta.length} 列`
            : result
              ? `${displayRows.length} 行已获取` + (displayRows.length !== baseRows.length ? `（筛选自 ${baseRows.length} 行）` : '') + `, ${(result.elapsedMs / 1000).toFixed(3)}s(查询时间)` + (fetchedAt ? `, ${fetchedAt}` : '')
              : ''}
        </span>
      </div>

      {/* 新增字段对话框（属性子页） */}
      {addColOpen && <AddColumnDialog onCancel={() => setAddColOpen(false)} onSubmit={(s) => void submitAddColumn(s)} />}
    </div>
  );
}

/** DBeaver 风格数据网格（表头排序 + 列筛选行 + 可内联编辑） */
function EditableGrid({
  columns,
  pkCols,
  displayRows,
  newRows,
  edits,
  deleted,
  editing,
  selected,
  editable,
  filters,
  sort,
  onCellDblClick,
  onCellChange,
  onEditEnd,
  onNewChange,
  onSelectRow,
  onToggleDelete,
  onFilter,
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
  editable: boolean;
  filters: Record<string, string>;
  sort: { col: string; dir: 'asc' | 'desc' } | null;
  onCellDblClick: (ri: number, col: string) => void;
  onCellChange: (ri: number, col: string, val: string) => void;
  onEditEnd: () => void;
  onNewChange: (i: number, col: string, val: string) => void;
  onSelectRow: (ri: number) => void;
  onToggleDelete: (ri: number) => void;
  onFilter: (col: string, val: string) => void;
  onSort: (col: string) => void;
  isPg: boolean;
}) {
  return (
    <table className="w-full border-collapse text-[11px]">
      <thead className="sticky top-0 z-10">
        {/* 表头：点击排序（asc → desc → 取消） */}
        <tr className="bg-panel2">
          <th className="w-9 border-b border-r border-line px-1 py-1 text-right text-dim2">#</th>
          {columns.map((c) => {
            const isSorted = sort?.col === c.name;
            return (
              <th
                key={c.name}
                onClick={() => onSort(c.name)}
                title="点击排序（升序 → 降序 → 取消）"
                className={`cursor-pointer select-none whitespace-nowrap border-b border-r border-line px-2 py-1 text-left font-medium hover:bg-panel3 ${isSorted ? 'text-accent' : 'text-fg'}`}
              >
                {pkCols.includes(c.name) && <span className="mr-1 text-warn" title="主键">🔑</span>}
                {c.name}
                {isSorted && <span className="ml-1">{sort?.dir === 'asc' ? '▲' : '▼'}</span>}
              </th>
            );
          })}
        </tr>
        {/* 筛选行：输入即过滤（包含匹配，不区分大小写） */}
        <tr className="bg-panel2">
          <th className="border-b border-r border-line px-1 py-0.5 text-right text-dim2">
            <svg className="ml-auto h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" />
            </svg>
          </th>
          {columns.map((c) => (
            <th key={c.name} className="border-b border-r border-line px-1 py-0.5">
              <input
                value={filters[c.name] ?? ''}
                onChange={(e) => onFilter(c.name, e.target.value)}
                spellCheck={false}
                placeholder=""
                className="w-full rounded-sm border border-line bg-bg px-1 py-0.5 text-[10px] font-normal text-fg outline-none focus:border-accent"
              />
            </th>
          ))}
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
              className={`${isDeleted ? 'opacity-40 line-through' : ''} ${isSel ? 'bg-panel3' : isDirty ? 'bg-[#3a2f12]' : 'hover:bg-panel3'}`}
              onClick={() => onSelectRow(ri)}
            >
              <td className="cursor-pointer border-b border-r border-line px-1 py-1 text-right text-dim2" onClick={(e) => { e.stopPropagation(); onToggleDelete(ri); }} title="点击标记删除 / 取消">
                {order + 1}
              </td>
              {columns.map((c) => {
                const key = `${ri}::${c.name}`;
                const isEditing = editing?.ri === ri && editing?.col === c.name;
                const val = edits[key] !== undefined ? edits[key] : row[c.name];
                return (
                  <td
                    key={c.name}
                    className="max-w-[280px] border-b border-r border-line px-2 py-1 text-fg"
                    onDoubleClick={() => editable && onCellDblClick(ri, c.name)}
                    title={editable ? '双击编辑' : undefined}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        defaultValue={edits[key] ?? fmt(row[c.name])}
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
                      <span className={val === null || val === undefined ? 'italic text-dim' : 'block truncate'}>{fmt(val)}</span>
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
            <td className="border-b border-r border-line px-1 py-1 text-right text-ok" title="新增行">
              +{i + 1}
            </td>
            {columns.map((c) => (
              <td key={c.name} className="border-b border-r border-line px-2 py-1">
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
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">列名</th>
            <th className="w-10 border-b border-r border-line px-2 py-1 text-right font-medium">#</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">数据类型</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">标识</th>
            <th className="whitespace-nowrap border-b border-r border-line px-2 py-1 font-medium">默认值</th>
            <th className="w-12 border-b border-r border-line px-2 py-1 font-medium">可空</th>
            <th className="border-b border-r border-line px-2 py-1 font-medium">注释</th>
            <th className="w-14 border-b border-line px-2 py-1 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {meta.map((c) => (
            <tr key={c.name} className="hover:bg-panel3">
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">
                {c.key === 'PRI' && <span className="mr-1 text-warn" title="主键">🔑</span>}
                {c.name}
              </td>
              <td className="border-b border-r border-line px-2 py-1 text-right text-dim2">{c.ordinal ?? ''}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-fg">{c.fullType ?? c.dataType}</td>
              <td className="whitespace-nowrap border-b border-r border-line px-2 py-1 text-accent">
                {c.extra === 'auto_increment' ? 'auto_increment' : ''}
              </td>
              <td className="max-w-[260px] truncate border-b border-r border-line px-2 py-1 text-dim" title={c.defaultValue ?? ''}>
                {c.defaultValue ?? ''}
              </td>
              <td className="border-b border-r border-line px-2 py-1 text-center text-dim2">{c.nullable ? 'Y' : 'N'}</td>
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
              <td colSpan={8} className="px-3 py-6 text-center text-dim2">
                无列信息
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const ddlInputCls = 'h-7 w-full rounded border border-line bg-bg px-2 text-[11px] text-fg outline-none placeholder:text-dim2 focus:border-accent/60';

/** 新增字段对话框：列名 / 类型 / 可空 / 默认值 / 注释 → ALTER TABLE ADD COLUMN */
function AddColumnDialog({ onCancel, onSubmit }: { onCancel: () => void; onSubmit: (spec: DbColumnSpec) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('varchar(255)');
  const [nullable, setNullable] = useState(true);
  const [def, setDef] = useState('');
  const [comment, setComment] = useState('');
  const nameOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim());
  const canSubmit = nameOk && type.trim() !== '';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onCancel}>
      <div className="w-[400px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[12px] font-semibold text-fg">新增字段</div>
        <div className="grid grid-cols-[56px_1fr] items-center gap-x-2 gap-y-2 text-[11px] text-dim">
          <span>列名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && canSubmit && onSubmit({ name: name.trim(), fullType: type.trim(), nullable, defaultValue: def.trim() || undefined, comment: comment.trim() || undefined })}
            placeholder="column_name"
            className={ddlInputCls}
          />
          <span>类型</span>
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="varchar(255) / integer / timestamp" className={ddlInputCls} />
          <span>可空</span>
          <label className="flex items-center gap-1.5 text-[11px] text-fg">
            <input type="checkbox" checked={nullable} onChange={(e) => setNullable(e.target.checked)} />
            允许 NULL
          </label>
          <span>默认值</span>
          <input value={def} onChange={(e) => setDef(e.target.value)} placeholder="留空表示无；可写 0 / 'x' / CURRENT_TIMESTAMP" className={ddlInputCls} />
          <span>注释</span>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="字段备注（可选）" className={ddlInputCls} />
        </div>
        {!nameOk && name.trim() !== '' && <div className="mt-2 text-[10px] text-prod">列名仅允许字母、数字、下划线，且以字母或下划线开头</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onCancel} className="h-7 rounded border border-line px-3 text-[11px] text-dim hover:bg-panel3">
            取消
          </button>
          <button
            disabled={!canSubmit}
            onClick={() => onSubmit({ name: name.trim(), fullType: type.trim(), nullable, defaultValue: def.trim() || undefined, comment: comment.trim() || undefined })}
            className="h-7 rounded bg-accent px-3 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** SQL 查询标签页 */
function QueryTab({ connId }: { connId: string }) {
  const [sql, setSql] = useState('SELECT 1;');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);

  const run = async () => {
    if (!sql.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.runSql(connId, sql));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'enter') {
            e.preventDefault();
            void run();
          }
        }}
        spellCheck={false}
        className="h-24 w-full shrink-0 resize-none border-b border-line bg-[#0d0d0d] p-2 font-mono text-[12px] text-fg outline-none"
        placeholder="输入 SQL，Ctrl/⌘+Enter 执行"
      />
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3 text-[11px]">
        <button onClick={run} disabled={loading} className="rounded bg-accent px-2.5 py-0.5 font-medium text-white hover:bg-accent2 disabled:opacity-50">
          {loading ? '执行中…' : '运行'}
        </button>
        {result && (
          <span className="text-dim2">
            · {result.affectedRows !== undefined ? `${result.affectedRows} 行受影响` : `${result.rowCount} 行`} · {result.elapsedMs}ms
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox message={error} onRetry={run} />
        ) : result ? (
          <ResultGrid result={result} />
        ) : (
          <div className="p-3 text-[11px] text-dim2">执行 SQL 查看结果</div>
        )}
      </div>
    </div>
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
              <td key={c.name} className="max-w-[280px] truncate border-b border-r border-line px-2 py-1 text-fg" title={fmt(row[c.name])}>
                {fmt(row[c.name])}
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

/** 单元格值格式化 */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * 把用户输入值转为 SQL 字面量（基础版，单用户工具内部使用）。
 * - 空串 → NULL（清空单元格即置空，符合 DBeaver 习惯）；
 * - 数值类型 → 裸数字；否则加单引号并转义。
 */
function sqlVal(dataType: string, raw: unknown): string {
  const v = raw == null ? '' : String(raw);
  if (v.trim() === '') return 'NULL';
  const numeric = /int|decimal|float|double|numeric|bigint|real|serial|money|smallint|tinyint|year/i.test(dataType);
  if (numeric) {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : 'NULL';
  }
  return `'${v.replace(/'/g, "''")}'`;
}
