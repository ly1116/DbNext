import { useEffect, useRef, useState } from "react";
import { Icon } from "@renderer/components/common/icons";
import { ContextMenu, type MenuItem } from "@renderer/components/common/ContextMenu";
import { api } from "@renderer/api";
import { Button } from "@renderer/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell } from "@renderer/components/ui/table";
import { cn } from "@renderer/lib/utils";
import { useAppStore } from "@renderer/store/appStore";
import { useConnections } from "@renderer/store/connectionStore";
import { ErrorBox } from "@renderer/components/common/States";
import { CreateTableDialog } from "@renderer/components/common/CreateTableDialog";
import { errMsg } from "@renderer/utils/errMsg";
import type { DbTab } from "@renderer/store/appStore";
import type { DbObjectMeta } from "@shared/types";
import { fmtBytes, fmtNum, hasStorage, objFilterCache } from "./shared";

/* ——————————————— 列宽拖拽（表/视图清单共用一套列定义）——————————————— */

/** 清单表格的列 key（与表头渲染顺序一致；不含复选框列，其宽度固定） */
type ObjListColKey = 'name' | 'comment' | 'rows' | 'size' | 'engine' | 'created' | 'updated';

/** 各列默认宽度（px）：名称/注释占比最大，数字与时间列窄而等宽 */
const OBJLIST_COL_DEFAULT: Record<ObjListColKey, number> = {
  name: 240,
  comment: 260,
  rows: 90,
  size: 80,
  engine: 100,
  created: 150,
  updated: 150,
};
/** 拖拽宽度上下限：过窄会挤坏内容，过宽会吃掉横向空间 */
const OBJLIST_COL_MIN = 56;
const OBJLIST_COL_MAX = 640;
/** 列宽持久化 key：表 / 视图 / 物化视图共用一套宽度，切标签不丢 */
const OBJLIST_COL_LS = 'dataroost:objlist-colw:v1';

/** 读取持久化列宽；localStorage 不可用或数据损坏时回退默认宽度 */
function loadColWidths(): Record<ObjListColKey, number> {
  const base = { ...OBJLIST_COL_DEFAULT };
  try {
    const raw = localStorage.getItem(OBJLIST_COL_LS);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Record<ObjListColKey, number>>;
    for (const key of Object.keys(base) as ObjListColKey[]) {
      const v = saved[key];
      if (typeof v === 'number' && v >= OBJLIST_COL_MIN && v <= OBJLIST_COL_MAX) base[key] = v;
    }
  } catch {
    /* 忽略损坏数据，用默认宽度 */
  }
  return base;
}

/**
 * 可拖拽表头单元格（基于 shadcn TableHead）：右缘 5px 命中区，悬停 / 拖拽时显示主色细线；
 * 双击命中区还原该列默认宽度。宽度通过 style 写到 th，交给表格自动布局。
 */
function ColTh({
  width,
  align,
  dragging,
  onDragStart,
  onReset,
  sortable,
  sortDir,
  onSort,
  children,
}: {
  width: number;
  align?: 'right';
  dragging: boolean;
  onDragStart: (e: React.MouseEvent) => void;
  onReset: () => void;
  /** 是否可排序（展示升降序指示） */
  sortable?: boolean;
  /** 当前排序方向（null = 未排序，显示中性双箭头） */
  sortDir?: 'asc' | 'desc' | null;
  onSort?: () => void;
  children: React.ReactNode;
}) {
  return (
    <TableHead
      className={cn(
        'group/th relative h-[34px] border-b border-border py-0',
        align === 'right' ? 'text-right' : 'text-left',
      )}
      style={{ width }}
      title={sortable ? '点击排序，右缘拖拽调整列宽（双击还原默认宽度）' : undefined}
      onClick={sortable ? onSort : undefined}
    >
      <span className={cn('flex items-center gap-1 truncate', align === 'right' && 'justify-end', sortable && 'cursor-pointer')}>
        <span className="truncate">{children}</span>
        {sortable && (
          <span className="shrink-0 font-normal text-muted-foreground">
            {sortDir === 'asc' ? '↑' : sortDir === 'desc' ? '↓' : '↕'}
          </span>
        )}
      </span>
      <span
        role="separator"
        aria-orientation="vertical"
        title="拖拽调整列宽，双击还原默认宽度"
        onMouseDown={onDragStart}
        onDoubleClick={(e) => {
          e.preventDefault();
          onReset();
        }}
        className="absolute right-0 top-0 z-10 h-full w-[5px] cursor-col-resize"
      >
        {/* 表头列分隔线 = 主体单元格同款 border-border/60（颜色粗细全表统一）；
            悬停/拖拽时叠主色细线提示可拖拽，平时透明不与边框撞色 */}
        <span
          className={`pointer-events-none absolute inset-y-0 right-0 w-[2px] transition-colors ${
            dragging ? 'bg-primary' : 'bg-transparent group-hover/th:bg-primary'
          }`}
        />
      </span>
    </TableHead>
  );
}

export function ObjListTab({ tab }: { tab: Extract<DbTab, { type: 'objlist' }> }) {
  const openDbTab = useAppStore((s) => s.openDbTab);
  const [items, setItems] = useState<DbObjectMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 搜索关键字（Ctrl+F 聚焦，实时过滤名称/注释）；初值从缓存恢复，切换标签后不丢失 */
  const [kw, setKw] = useState(() => objFilterCache.get(tab.id) ?? '');
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
  /** 列宽（拖拽调节，按列 key 持久化到 localStorage） */
  const [colW, setColW] = useState<Record<ObjListColKey, number>>(loadColWidths);
  /** 正在拖拽的列：用于表头分隔线高亮 */
  const [dragCol, setDragCol] = useState<ObjListColKey | null>(null);
  /** 复选框多选（批量删除用；与单击选中行相互独立） */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  /** 排序：默认按名称升序（与参考设计一致），再次点击同一列切换升降序 */
  const [sort, setSort] = useState<{ key: ObjListColKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });

  useEffect(() => {
    try {
      localStorage.setItem(OBJLIST_COL_LS, JSON.stringify(colW));
    } catch {
      /* 隐私模式 / 配额满时忽略：宽度本次会话仍生效 */
    }
  }, [colW]);

  /** 按住列边界开始拖拽：全局监听 move/up，光标锁定 col-resize（与侧栏分隔线同一范式） */
  const startColDrag = (key: ObjListColKey) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colW[key];
    setDragCol(key);
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      setColW((prev) => ({
        ...prev,
        [key]: Math.min(OBJLIST_COL_MAX, Math.max(OBJLIST_COL_MIN, startW + (ev.clientX - startX))),
      }));
    };
    const onUp = () => {
      setDragCol(null);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /** 还原单列默认宽度（双击列边界触发） */
  const resetCol = (key: ObjListColKey) => setColW((prev) => ({ ...prev, [key]: OBJLIST_COL_DEFAULT[key] }));

  /** 可排序列：点击切换升/降序（名称按本地字典序，时间按字符串序，数字按数值） */
  const toggleSort = (key: ObjListColKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  /** 表头单元格简写：统一绑好宽度 / 拖拽 / 还原 */
  const colTh = (key: ObjListColKey, label: string, align?: 'right') => (
    <ColTh
      key={key}
      width={colW[key]}
      align={align}
      dragging={dragCol === key}
      onDragStart={startColDrag(key)}
      onReset={() => resetCol(key)}
      sortDir={sort.key === key ? sort.dir : null}
      onSort={() => toggleSort(key)}
      sortable
    >
      {label}
    </ColTh>
  );

  const kindLabel = tab.kind === 'table' ? '表' : tab.kind === 'view' ? '视图' : '物化视图';
  /** 对象类型对应的线性图标（表 / 视图 / 物化视图） */
  const kindIcon = tab.kind === 'table' ? 'table-2' : tab.kind === 'view' ? 'eye' : 'table-3';
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
      setError(errMsg(e));
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
              setError(errMsg(e));
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
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connId, tab.kind, tab.schema, tab.pgDb]);

  /** 筛选关键字同步进缓存：卸载（切走标签 / 刷新重挂载）后再回来可恢复 */
  useEffect(() => {
    objFilterCache.set(tab.id, kw);
  }, [tab.id, kw]);

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
  /** 筛选：名称 / 注释命中即可 */
  const listed = (items ?? []).filter(
    (it) => !k || it.name.toLowerCase().includes(k) || (it.comment ?? '').toLowerCase().includes(k),
  );
  /** 排序：默认按名称升序；数字按数值，时间/名称按字符串（ISO 时间天然有序） */
  const filtered = [...listed].sort((a, b) => {
    const mul = sort.dir === 'asc' ? 1 : -1;
    switch (sort.key) {
      case 'rows':
        return ((a.rows ?? 0) - (b.rows ?? 0)) * mul;
      case 'size':
        return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * mul;
      case 'created':
        return (a.createdAt ?? '').localeCompare(b.createdAt ?? '') * mul;
      case 'updated':
        return (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '') * mul;
      case 'comment':
        return (a.comment ?? '').localeCompare(b.comment ?? '') * mul;
      case 'engine':
        return (a.engine ?? '').localeCompare(b.engine ?? '') * mul;
      default:
        return a.name.localeCompare(b.name) * mul;
    }
  });
  /** 引擎列仅在有引擎数据时展示（MySQL 有 / PG、Oracle 无） */
  const showEngine = hasStorage(tab.kind) && !!items?.some((it) => it.engine);
  /** 表格总列数：复选框 + 名称 + 注释 +（行数/大小）+（引擎）+ 创建时间 + 修改时间 */
  const colCount = 4 + (hasStorage(tab.kind) ? 2 : 0) + (showEngine ? 1 : 0);
  /** 当前可见行的勾选状态：全选 / 部分选（不确定态） */
  const checkedVisible = filtered.filter((it) => checked.has(it.name)).length;
  const allChecked = filtered.length > 0 && checkedVisible === filtered.length;
  const someChecked = checkedVisible > 0 && !allChecked;
  /** 表头全选：对当前筛选结果整体勾选/取消 */
  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) filtered.forEach((it) => next.delete(it.name));
      else filtered.forEach((it) => next.add(it.name));
      return next;
    });
  const toggleOne = (name: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  /** 批量删除（勾选后出现的红色按钮）：逐个删除并刷新，结果写回错误条/状态 */
  const batchDelete = async () => {
    const names = [...checked].filter((n) => items?.some((x) => x.name === n));
    if (!names.length) return;
    if (!window.confirm(`确认删除选中的 ${names.length} 个${kindLabel}？此操作不可恢复。`)) return;
    setLoading(true);
    const failed: string[] = [];
    for (const name of names) {
      try {
        await api.dropObject(tab.connId, tab.kind, tab.schema, name, tab.pgDb);
      } catch {
        failed.push(name);
      }
    }
    setChecked(new Set());
    if (selName && names.includes(selName)) setSelName(null);
    await load();
    setError(failed.length ? `${failed.length} 个${kindLabel}删除失败：${failed.join('、')}` : null);
  };

  /** 单元格基础样式：36px 行高 + 行间细横线；不再画列间竖线（保持朴素、无实色分割） */
  const cell = 'h-9 border-b border-border/60 py-0';

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden p-2.5"
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      {/* 统一面板卡：页头 + 表格 + 状态栏（参考设计：单卡片三段式，无外挂卡片） */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
        {/* ① 页头：32px 图标片 + 标题/元信息 + 搜索 + 操作 */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
            <Icon name={kindIcon} className="h-[18px] w-[18px]" strokeWidth={1.9} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[length:calc(var(--pref-fs)*0.875)] font-semibold leading-tight text-foreground">{kindLabel}清单</div>
            <div className="truncate font-mono text-[length:calc(var(--pref-fs)*0.75)] text-muted-foreground">
              {dialectLabel} · {tab.schema} · {items ? `${items.length} 个${kindLabel}` : '加载中…'}
            </div>
          </div>
          <div className="relative flex h-[30px] w-60 shrink-0 items-center">
            <Icon name="search" className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              ref={searchRef}
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder={`筛选${kindLabel}名 / 注释（Ctrl+F）`}
              spellCheck={false}
              className="h-full w-full rounded-md border border-input bg-background pl-8 pr-3 text-[length:calc(var(--pref-fs)*0.786)] text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {kw && (
              <button onClick={() => setKw('')} className="absolute right-2 text-muted-foreground transition-colors hover:text-foreground" title="清空搜索">
                <Icon name="close" className="h-3 w-3" />
              </button>
            )}
          </div>
          {checked.size > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-[30px] shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10"
              title={`删除选中的 ${checked.size} 个${kindLabel}`}
              onClick={() => void batchDelete()}
            >
              <Icon name="trash" className="h-3.5 w-3.5" />
              删除
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-[30px] shrink-0" onClick={() => void load()} disabled={loading} title="重新读取对象列表">
            <Icon name="refresh-3" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.8} />
            刷新
          </Button>
          <Button size="sm" className="h-[30px] shrink-0" onClick={() => { setEditName(undefined); setCreateOpen(true); }}>
            <Icon name="plus-2" className="h-3.5 w-3.5" strokeWidth={2.5} />
            新建{tab.kind === 'table' ? '表' : kindLabel}
          </Button>
        </div>

        {/* ② 表格：固定列宽 + 紧凑行高。
            注意：shadcn <Table> 自带一层 div.relative.w-full.overflow-auto，sticky 表头
            以它为定位基准 —— 外层这里绝不能再套 overflow-auto（双层滚动容器会让表头跟滚），
            用单行 grid 把高度约束传下去，让 Table 自带容器成为唯一滚动层。 */}
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]">
          {error ? (
            <ErrorBox message={error} onRetry={() => void load()} />
          ) : (
            <Table className="table-fixed text-[length:calc(var(--pref-fs)*0.786)]">
              <TableHeader className="sticky top-0 z-10">
                <TableRow className="bg-muted text-[length:calc(var(--pref-fs)*0.75)] font-semibold text-muted-foreground hover:bg-muted">
                  <TableHead className={cn(cell, 'w-10 bg-muted p-0 text-center')}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => { if (el) el.indeterminate = someChecked; }}
                      onChange={toggleAll}
                      disabled={!filtered.length}
                      className="h-3.5 w-3.5 align-middle accent-primary"
                      title="全选 / 取消全选（当前筛选结果）"
                      aria-label="全选"
                    />
                  </TableHead>
                  {colTh('name', '名称')}
                  {colTh('comment', '注释')}
                  {hasStorage(tab.kind) && (
                    <>
                      {colTh('rows', '行数', 'right')}
                      {colTh('size', '大小', 'right')}
                      {showEngine && colTh('engine', '引擎')}
                    </>
                  )}
                  {colTh('created', '创建时间')}
                  {colTh('updated', '修改时间')}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((it) => {
                  const on = selName === it.name;
                  return (
                    <TableRow
                      key={it.name}
                      data-state={on ? 'selected' : undefined}
                      className={cn('cursor-pointer hover:bg-muted', on && 'bg-primary/10 hover:bg-primary/15')}
                      title="单击选中，双击打开表数据"
                      onClick={() => setSelName(it.name)}
                      onDoubleClick={() => openTable(it.name)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenu({ x: e.clientX, y: e.clientY, item: it });
                      }}
                    >
                      <TableCell className={cn(cell, 'p-0 text-center')} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={checked.has(it.name)}
                          onChange={() => toggleOne(it.name)}
                          className="h-3.5 w-3.5 align-middle accent-primary"
                          aria-label={`选择 ${it.name}`}
                        />
                      </TableCell>
                      <TableCell className={cn(cell, 'font-medium text-foreground')}>
                        <span className="flex min-w-0 items-center gap-2">
                          {/* 按对象类型区分图标（表 / 视图 / 物化视图），纯线性图标无底片无动画 */}
                          <Icon name={kindIcon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.9} />
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
                              className="w-56 max-w-full rounded border border-primary bg-background px-1.5 py-0.5 font-medium text-foreground outline-none"
                              title="Enter 提交，Esc 取消"
                            />
                          ) : (
                            <span className="truncate font-mono" title={it.name}>{it.name}</span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className={cn(cell, 'truncate text-muted-foreground')} title={it.comment ?? undefined}>
                        {it.comment ?? <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                      {hasStorage(tab.kind) && (
                        <>
                          <TableCell className={cn(cell, 'whitespace-nowrap text-right tabular-nums', it.rows ? 'text-primary' : 'text-muted-foreground')}>
                            {fmtNum(it.rows)}
                          </TableCell>
                          <TableCell className={cn(cell, 'whitespace-nowrap text-right tabular-nums text-muted-foreground')}>
                            {fmtBytes(it.sizeBytes)}
                          </TableCell>
                          {showEngine && (
                            <TableCell className={cn(cell, 'whitespace-nowrap truncate font-mono text-muted-foreground')}>
                              {it.engine ?? <span className="text-muted-foreground/50">—</span>}
                            </TableCell>
                          )}
                        </>
                      )}
                      <TableCell className={cn(cell, 'whitespace-nowrap truncate font-mono text-muted-foreground')} title={it.createdAt ? `创建于：${it.createdAt}` : undefined}>
                        {it.createdAt ?? <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                      <TableCell className={cn(cell, 'whitespace-nowrap truncate font-mono text-muted-foreground')} title={it.updatedAt ? `最近修改：${it.updatedAt}` : undefined}>
                        {it.updatedAt ?? <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && filtered.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={colCount} className="h-24 text-center text-muted-foreground">
                      {items && k ? '无匹配对象' : items ? '（空）' : '加载中…'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </div>

        {/* ③ 底部状态栏：汇总统计（左）+ 就绪/筛选/已选（右） */}
        <div className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-muted px-4 font-mono text-[length:calc(var(--pref-fs)*0.6875)] text-muted-foreground">
          <span className="truncate">
            {items
              ? `共 ${items.length} 个${kindLabel}${hasStorage(tab.kind) ? ` · 总行数 ${fmtNum(items.reduce((s, x) => s + (x.rows ?? 0), 0))} · 占用 ${fmtBytes(items.reduce((s, x) => s + (x.sizeBytes ?? 0), 0))}` : ''}`
              : ''}
          </span>
          <span className="shrink-0">
            {checked.size ? `已选 ${checked.size} 个` : k && items ? `筛选 ${filtered.length} / ${items.length}` : '就绪'}
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
