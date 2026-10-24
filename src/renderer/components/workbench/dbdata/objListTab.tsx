import { useEffect, useRef, useState } from "react";
import { Icon } from "@renderer/components/common/icons";
import { ContextMenu, type MenuItem } from "@renderer/components/common/ContextMenu";
import { api } from "@renderer/api";
import { PageHeaderCard } from "@renderer/components/common/PageHeaderCard";
import { Button } from "@renderer/components/ui/button";
import { useAppStore } from "@renderer/store/appStore";
import { useConnections } from "@renderer/store/connectionStore";
import { ErrorBox } from "@renderer/components/common/States";
import { CreateTableDialog } from "@renderer/components/common/CreateTableDialog";
import { errMsg } from "@renderer/utils/errMsg";
import type { DbTab } from "@renderer/store/appStore";
import type { DbObjectMeta } from "@shared/types";
import { fmtBytes, fmtNum, hasStorage, objFilterCache } from "./shared";

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
          <Icon name="table-2" className="h-[18px] w-[18px]" strokeWidth={1.9} />
        }
        title={`${kindLabel}清单`}
        subtitle={
          <>
            <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium leading-[18px] text-secondary-foreground">{dialectLabel}</span>
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
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} title="重新读取对象列表">
              <Icon name="refresh-3" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.8} />
              刷新
            </Button>
            <Button size="sm" onClick={() => { setEditName(undefined); setCreateOpen(true); }}>
              <Icon name="plus-2" className="h-3.5 w-3.5" strokeWidth={2.5} />
              新建{tab.kind === 'table' ? '表' : kindLabel}
            </Button>
          </>
        }
      />

      {/* 表格卡 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <ErrorBox message={error} onRetry={() => void load()} />
        ) : (
          <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
            <thead className="sticky top-0 z-10">
              <tr className="bg-muted text-left text-[length:calc(var(--pref-fs)*0.714)] tracking-wide text-muted-foreground">
                <th className="border-b border-border px-3 py-1.5 font-medium">名称</th>
                <th className="border-b border-border px-3 py-1.5 font-medium">注释</th>
                {hasStorage(tab.kind) && (
                  <>
                    <th className="border-b border-border px-3 py-1.5 text-right font-medium">行数</th>
                    <th className="border-b border-border px-3 py-1.5 text-right font-medium">大小</th>
                    {showEngine && <th className="border-b border-border px-3 py-1.5 font-medium">引擎</th>}
                  </>
                )}
                <th className="border-b border-border px-3 py-1.5 font-medium">创建时间</th>
                <th className="border-b border-border px-3 py-1.5 font-medium">修改时间</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const on = selName === it.name;
                return (
                  <tr
                    key={it.name}
                    className={`group cursor-pointer ${on ? 'bg-primary/10' : 'even:bg-muted/50 hover:bg-secondary'}`}
                    style={on ? { boxShadow: 'inset 2.5px 0 0 hsl(var(--primary))' } : undefined}
                    title="单击选中，双击打开表数据"
                    onClick={() => setSelName(it.name)}
                    onDoubleClick={() => openTable(it.name)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenu({ x: e.clientX, y: e.clientY, item: it });
                    }}
                  >
                    <td className="border-b border-border whitespace-nowrap px-3 py-2">
                      <span className="flex items-center gap-2.5">
                        {/* 对象图标片：朴素纯色底（shadcn 风格，选中时主色描边） */}
                        <span
                          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-transform group-hover:scale-105"
                          style={{ outline: on ? '1.5px solid hsl(var(--primary))' : undefined, outlineOffset: 1 }}
                        >
                          <Icon name="table-2" className="h-3 w-3" strokeWidth={1.9} />
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
                            className="w-56 rounded border border-primary bg-background px-1.5 py-0.5 font-medium text-foreground outline-none"
                            title="Enter 提交，Esc 取消"
                          />
                        ) : (
                          <span className={`font-mono font-medium ${on ? 'text-primary' : 'text-foreground'}`}>{it.name}</span>
                        )}
                      </span>
                    </td>
                    <td className="max-w-[280px] truncate border-b border-border px-3 py-2 text-muted-foreground">
                      {it.comment ?? <span className="text-muted-foreground/50">—</span>}
                    </td>
                    {hasStorage(tab.kind) && (
                      <>
                        <td className={`border-b border-border px-3 py-2 text-right tabular-nums ${it.rows ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>
                          {fmtNum(it.rows)}
                        </td>
                        <td className="border-b border-border px-3 py-2">
                          <div className="flex flex-col items-end gap-[3px]">
                            <span className="tabular-nums text-muted-foreground">{fmtBytes(it.sizeBytes)}</span>
                            {/* 大小比例微条：相对全库最大表（纯色填充，无渐变） */}
                            <span className="h-[3px] w-16 overflow-hidden rounded-full bg-muted">
                              <span
                                className="block h-full rounded-full bg-primary"
                                style={{ width: it.sizeBytes ? `${Math.max(4, Math.round((it.sizeBytes / maxBytes) * 100))}%` : '0%' }}
                              />
                            </span>
                          </div>
                        </td>
                        {showEngine && (
                          <td className="whitespace-nowrap border-b border-border px-3 py-2">
                            {it.engine && (
                              <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
                                {it.engine}
                              </span>
                            )}
                          </td>
                        )}
                      </>
                    )}
                    <td className="whitespace-nowrap border-b border-border px-3 py-2 tabular-nums text-muted-foreground" title={it.createdAt ? `创建于：${it.createdAt}` : undefined}>
                      {it.createdAt ?? <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="whitespace-nowrap border-b border-border px-3 py-2 tabular-nums text-muted-foreground" title={it.updatedAt ? `最近修改：${it.updatedAt}` : undefined}>
                      {it.updatedAt ?? <span className="text-muted-foreground/50">—</span>}
                    </td>
                  </tr>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={4 + (hasStorage(tab.kind) ? (showEngine ? 3 : 2) : 0)} className="px-3 py-10 text-center text-muted-foreground">
                    {items && k ? '无匹配对象' : items ? '（空）' : '加载中…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* 底部状态栏：汇总统计（筛选时数字联动） */}
      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border px-3 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
        {items && (
          <>
            <span>
              共 <b className="font-semibold tabular-nums text-foreground">{filtered.length}</b> {kindLabel}
            </span>
            {hasStorage(tab.kind) && (
              <>
                <span>
                  总行数 <b className="font-semibold tabular-nums text-foreground">{fmtNum(filtered.reduce((s, x) => s + (x.rows ?? 0), 0))}</b>
                </span>
                <span>
                  占用 <b className="font-semibold tabular-nums text-foreground">{fmtBytes(filtered.reduce((s, x) => s + (x.sizeBytes ?? 0), 0))}</b>
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
