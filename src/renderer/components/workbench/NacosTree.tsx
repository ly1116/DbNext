import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { KindIcon } from '@renderer/components/common/KindIcon';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { StatusDot } from '@renderer/components/common/States';
import { Icon } from '@renderer/components/common/icons';
import { useAppStore } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import { errMsg } from '@renderer/utils/errMsg';
import { folderScope, type ConnectionFolder, type ConnectionSummary, type NacosNamespace } from '@shared/types';

/**
 * 注册与配置中心树（Nacos 等注册中心连接的导航器）。
 *
 * 独立于数据库树 / SSH 主机树的第三棵侧栏树，架构上按多注册中心预留
 * （当前接入 Nacos，etcd / ZooKeeper / Consul 后续按需扩展）。
 *
 * 交互（对齐数据库树）：
 * - 头部：刷新 / 新建文件夹 / 新建 Nacos 连接；
 * - 文件夹：点击折叠展开、拖拽连接归组、右键重命名 / 删除；
 * - 连接：单击行展开 / 收起命名空间子节点（仅展示有权限的空间，服务端鉴权过滤）；
 * - 右键「打开配置中心」→ 工作台标签页中打开配置中心（非弹窗）；
 *   单击命名空间子节点 → 直接打开该空间的配置中心；
 * - 右键连接：打开 / 刷新命名空间 / 编辑 / 移动到文件夹 / 删除。
 *
 * @since 0.2.2
 */
export function NacosTree({ width = 252 }: { width?: number }) {
  const connections = useConnections((s) => s.connections);
  const initialized = useConnections((s) => s.initialized);
  const load = useConnections((s) => s.load);
  const select = useConnections((s) => s.select);
  const removeConn = useConnections((s) => s.remove);
  const folders = useConnections((s) => s.folders);
  const addFolder = useConnections((s) => s.addFolder);
  const renameFolder = useConnections((s) => s.renameFolder);
  const removeFolder = useConnections((s) => s.removeFolder);
  const moveToFolder = useConnections((s) => s.moveToFolder);
  const openOverlay = useAppStore((s) => s.openOverlay);
  const openNacosTab = useAppStore((s) => s.openNacosTab);

  const [filter, setFilter] = useState('');
  const ft = filter.trim().toLowerCase();
  /** 刷新进行中：头部刷新按钮图标旋转 */
  const [refreshing, setRefreshing] = useState(false);
  const [menu, setMenu] = useState<{ conn: ConnectionSummary; x: number; y: number } | null>(null);

  /* —— 文件夹（本侧栏专属作用域，与 SSH / 数据库树独立）—— */
  const myFolders = useMemo(() => folders.filter((f) => folderScope(f) === 'nacos'), [folders]);
  /** 新建文件夹：内联命名输入 */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  /** 正在重命名的文件夹（内联输入） */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** 文件夹折叠状态 */
  const [collapsedF, setCollapsedF] = useState<Record<string, boolean>>({});
  const [folderMenu, setFolderMenu] = useState<{ folder: ConnectionFolder; x: number; y: number } | null>(null);
  /** 拖拽归组：正在拖动的连接 id / 拖拽悬停的目标文件夹 id */
  const [dragConn, setDragConn] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized) void load();
  }, [initialized, load]);

  /** 刷新连接列表（新建/删除/外部同步后重新拉取） */
  const refreshAll = async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  /** 数据隔离：本树只显示注册与配置中心连接（Nacos），按名称 / 主机过滤 */
  const conns = useMemo(
    () =>
      connections
        .filter((c) => c.kind === 'nacos')
        .filter((c) => !ft || `${c.name} ${c.host}`.toLowerCase().includes(ft)),
    [connections, ft],
  );

  /** 归入本侧栏自定义文件夹的文件夹名集合（未分组列表里排除这些） */
  const folderedNames = useMemo(() => new Set(myFolders.map((f) => f.name)), [myFolders]);
  const ungrouped = useMemo(() => conns.filter((c) => !c.group || !folderedNames.has(c.group)), [conns, folderedNames]);

  const submitCreate = () => {
    if (newName.trim()) void addFolder(newName, 'nacos');
    setNewName('');
    setCreating(false);
  };
  const submitRename = () => {
    if (renaming && renaming.name.trim()) void renameFolder(renaming.id, renaming.name);
    setRenaming(null);
  };

  /** 打开 Nacos 配置中心（工作台标签页；**每个命名空间独立标签**，标题 `连接名|空间名` 对齐参考系统）——非弹窗 */
  const openBrowser = (c: ConnectionSummary, ns?: string, nsLabel?: string) => {
    select(c.id);
    openNacosTab(c.id, ns !== undefined ? `${c.name}|${nsLabel || ns || 'public'}` : c.name, ns);
  };

  /* —— 命名空间子节点（懒加载：展开连接时拉取，仅展示有权限的空间）—— */
  type NsState = { loading?: boolean; error?: string; items: NacosNamespace[] };
  const [nsMap, setNsMap] = useState<Record<string, NsState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /** 拉取某连接的命名空间列表（强制刷新时复用） */
  const fetchNs = async (connId: string) => {
    setNsMap((m) => ({ ...m, [connId]: { loading: true, items: m[connId]?.items ?? [] } }));
    try {
      const items = await api.nacosNamespaces(connId);
      setNsMap((m) => ({ ...m, [connId]: { items } }));
    } catch (e) {
      setNsMap((m) => ({ ...m, [connId]: { items: [], error: errMsg(e) } }));
    }
  };

  /** 展开 / 折叠连接的命名空间子节点（首次展开懒加载） */
  const toggleExpand = (c: ConnectionSummary) => {
    const id = c.id;
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!nsMap[id]) void fetchNs(id);
  };

  /** 已自动探测过的连接（避免列表刷新导致重复请求） */
  const autoFetched = useRef<Set<string>>(new Set());
  /** 连接列表就绪后自动探测命名空间（免手动展开；失败结果也缓存，不会循环重试） */
  useEffect(() => {
    for (const c of conns) {
      if (!autoFetched.current.has(c.id) && !nsMap[c.id]) {
        autoFetched.current.add(c.id);
        void fetchNs(c.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns]);

  /** 连接右键菜单（打开 / 刷新命名空间 / 编辑 / 移动到文件夹 / 删除） */
  const menuItems = (c: ConnectionSummary): MenuItem[] => {
    const currentFolder = folders.find((f) => f.name === c.group);
    return [
      { label: '打开配置中心', onClick: () => openBrowser(c) },
      { label: '刷新命名空间', onClick: () => void fetchNs(c.id) },
      {
        label: '编辑…',
        onClick: () => openOverlay({ kind: 'connection-edit', connectionId: c.id, preset: { kindScope: ['nacos'] } }),
      },
      { separator: true, label: '' },
      {
        label: '移动到文件夹',
        children: [
          ...myFolders.map((f) => ({
            label: `${f.name}${currentFolder?.id === f.id ? ' ✓' : ''}`,
            onClick: () => void moveToFolder(c.id, f.id),
          })),
          ...(myFolders.length === 0 ? ([{ label: '（暂无文件夹，先在树上方新建）', disabled: true }] as MenuItem[]) : []),
          ...(currentFolder
            ? ([{ separator: true, label: '' }, { label: '移出文件夹', onClick: () => void moveToFolder(c.id, null) }] as MenuItem[])
            : []),
        ],
      },
      { separator: true, label: '' },
      {
        label: '删除',
        danger: true,
        onClick: () => {
          void api.deleteConnection(c.id).catch(() => undefined);
          removeConn(c.id);
        },
      },
    ];
  };

  /** 文件夹右键菜单（新建连接归入此文件夹 / 重命名 / 删除文件夹） */
  const folderMenuItems = (f: ConnectionFolder): MenuItem[] => [
    {
      label: '新建 Nacos 连接（归入此文件夹）',
      onClick: () => openOverlay({ kind: 'connection-edit', preset: { group: f.name, kind: 'nacos', kindScope: ['nacos'] } }),
    },
    { separator: true, label: '' },
    { label: '重命名…', onClick: () => setRenaming({ id: f.id, name: f.name }) },
    { separator: true, label: '' },
    { label: '删除文件夹', danger: true, onClick: () => void removeFolder(f.id) },
  ];

  /** 单个 Nacos 连接节点（可展开命名空间子节点） */
  const renderConn = (c: ConnectionSummary) => {
    const ns = nsMap[c.id];
    const isOpen = expanded.has(c.id);
    return (
      <div key={c.id}>
        <div
          className="group flex h-7 cursor-default items-center gap-1.5 rounded px-2 hover:bg-panel3"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/dataroost-conn', c.id);
            e.dataTransfer.effectAllowed = 'move';
            setDragConn(c.id);
          }}
          onDragEnd={() => setDragConn(null)}
          onClick={(e) => {
            // 单击连接行 = 展开 / 收起命名空间子节点（对齐参考工具；打开控制台由点命名空间触发）
            if (e.button === 0) toggleExpand(c);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ conn: c, x: e.clientX, y: e.clientY });
          }}
          title={`${c.host}:${c.port}${c.remark ? ` · ${c.remark}` : ''} · 单击展开命名空间`}
        >
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-dim2 hover:bg-panel2 hover:text-fg"
            title={isOpen ? '收起命名空间' : '展开命名空间'}
            onClick={(e) => {
              e.stopPropagation();
              toggleExpand(c);
            }}
          >
            <Icon name="chevronDown" className="h-3 w-3 shrink-0 transition-transform" style={{ transform: isOpen ? undefined : 'rotate(-90deg)' }} />
          </button>
          <StatusDot status={c.status} />
          <KindIcon kind="nacos" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-fg">{c.name}</span>
          <span className="shrink-0 text-[10px] text-dim2">{c.environment === 'prod' ? '生产' : c.environment === 'staging' ? '预发' : '开发'}</span>
        </div>

        {/* —— 命名空间子节点（懒加载；服务端鉴权时仅返回有权限的空间）—— */}
        {isOpen && (
          <div className="ml-4 border-l border-line pl-1">
            {!ns && <div className="py-0.5 pl-2 text-[11px] text-dim2">加载命名空间…</div>}
            {ns?.loading && (!ns.items || ns.items.length === 0) && <div className="py-0.5 pl-2 text-[11px] text-dim2">加载命名空间…</div>}
            {ns?.error && (
              <div className="py-1 pl-2 pr-1 text-[11px] leading-relaxed text-prod" title={ns.error}>
                {ns.error}
                <button className="ml-1 text-accent hover:underline" onClick={() => void fetchNs(c.id)}>
                  重试
                </button>
              </div>
            )}
            {ns && !ns.error && ns.items.length === 0 && !ns.loading && (
              <div className="py-0.5 pl-2 text-[11px] text-dim2">（无可见 / 有权限的命名空间）</div>
            )}
            {ns?.items.map((item) => (
              <div
                key={item.namespaceId || 'public'}
                className="flex h-6 cursor-default items-center gap-1.5 rounded px-2 hover:bg-panel3"
                title={`${item.namespaceId === '' ? 'public（默认）' : item.namespaceShowName || item.namespaceId} · 配置 ${item.configCount ?? 0} 条 · 单击打开该空间的配置中心`}
                onClick={() => openBrowser(c, item.namespaceId, item.namespaceId === '' ? 'public' : item.namespaceShowName || item.namespaceId)}
              >
                <Icon name="cluster" className="h-3.5 w-3.5 shrink-0 text-dim" />
                <span className="min-w-0 flex-1 truncate">{item.namespaceId === '' ? 'public' : item.namespaceShowName || item.namespaceId}</span>
                <span className="shrink-0 rounded bg-panel3 px-1 text-[10px] text-dim2">{item.configCount ?? 0}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex shrink-0 flex-col bg-panel" style={{ width }}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[length:calc(var(--pref-fs)*0.786)] font-semibold uppercase tracking-wider text-dim">注册与配置</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3 hover:text-fg"
            title={refreshing ? '正在刷新…' : '刷新连接列表'}
            onClick={() => void refreshAll()}
          >
            <span className={`flex ${refreshing ? 'animate-spin' : ''}`}>
              <Icon name="refresh" className="h-3.5 w-3.5" />
            </span>
          </button>
          {/* 新建文件夹：树内内联命名（与数据库树 / SSH 树同一套持久化） */}
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3 hover:text-fg"
            title="新建文件夹"
            aria-label="新建文件夹"
            onClick={() => {
              setCreating(true);
              setNewName('');
            }}
          >
            <Icon name="folder-2" className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-accent text-white hover:bg-accent2"
            title="新建 Nacos 连接"
            onClick={() => openOverlay({ kind: 'connection-edit', preset: { kind: 'nacos', kindScope: ['nacos'] } })}
          >
            <Icon name="plus" className="h-3.5 w-3.5" strokeWidth={2.2} />
          </button>
        </div>
      </div>

      <div className="shrink-0 border-b border-line px-2 py-2">
        <div className="flex h-6 items-center gap-2 rounded border border-line bg-bg px-2">
          <Icon name="search-2" className="h-3 w-3 shrink-0 text-dim2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setFilter('');
            }}
            placeholder="筛选连接…"
            className="flex-1 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2"
          />
        </div>
      </div>

      {/* 新建文件夹内联命名输入（Enter 确认 / Esc 取消） */}
      {creating && (
        <div className="shrink-0 border-b border-line px-2 py-2">
          <div className="flex h-6 items-center gap-1.5 rounded border border-accent bg-bg px-2">
            <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-warn" strokeWidth={1.7} />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setNewName('');
                }
              }}
              onBlur={submitCreate}
              placeholder="文件夹名称，Enter 确认"
              className="flex-1 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2"
            />
          </div>
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto px-1 py-1 text-[length:calc(var(--pref-fs)*0.857)]"
        onDragOver={(e) => {
          // 拖动连接经过树的空白区域：允许放置 = 移出文件夹
          if (!dragConn) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('text/dataroost-conn') || dragConn;
          if (id) void moveToFolder(id, null);
          setDragConn(null);
          setDropFolderId(null);
        }}
      >
        {conns.length === 0 && myFolders.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-dim2">
            暂无 Nacos 连接
            <br />
            点右上角「+」新建
          </div>
        )}
        {(() => {
          return (
            <>
              {/* —— 自定义文件夹（仅注册与配置侧作用域）—— */}
              {myFolders.map((f) => {
                const items = conns.filter((c) => c.group === f.name);
                // 筛选时隐藏没有匹配连接的文件夹
                if (ft && items.length === 0) return null;
                const renamingThis = renaming?.id === f.id;
                return (
                  <div key={f.id}>
                    {renamingThis ? (
                      /* 重命名内联输入 */
                      <div className="flex items-center gap-1.5 px-2 py-1">
                        <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-warn" strokeWidth={1.7} />
                        <input
                          autoFocus
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitRename();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={submitRename}
                          className="flex-1 rounded border border-accent bg-bg px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.857)] text-fg outline-none"
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => setCollapsedF((m) => ({ ...m, [f.id]: !m[f.id] }))}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFolderMenu({ folder: f, x: e.clientX, y: e.clientY });
                        }}
                        onDragOver={(e) => {
                          if (!dragConn) return;
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'move';
                          setDropFolderId(f.id);
                        }}
                        onDragLeave={() => setDropFolderId((cur) => (cur === f.id ? null : cur))}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const id = e.dataTransfer.getData('text/dataroost-conn') || dragConn;
                          if (id) void moveToFolder(id, f.id);
                          setDropFolderId(null);
                          setDragConn(null);
                        }}
                        className={`tree-row flex w-full items-center gap-1 px-2 py-[3px] text-left ${dropFolderId === f.id ? 'ring-1 ring-accent' : ''}`}
                        title="拖动 Nacos 连接到此可归入文件夹；右键：重命名 / 删除"
                      >
                        <Icon
                          name="chevronDown"
                          className="h-3 w-3 shrink-0 text-dim2 transition-transform"
                          style={{ transform: collapsedF[f.id] ? 'rotate(-90deg)' : undefined }}
                        />
                        <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-warn" strokeWidth={1.7} />
                        <span className="truncate font-medium text-fg">{f.name}</span>
                        {items.length > 0 && <span className="cnt-pill">{items.length}</span>}
                      </button>
                    )}

                    {!collapsedF[f.id] &&
                      (items.length === 0 ? (
                        <div className="py-0.5 pl-[1.5rem] pr-2 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">（空）右键连接 → 移动到文件夹</div>
                      ) : (
                        /* 目录内容整体缩进 + 左侧树状引导线，清晰表达 目录 → 连接 的层级 */
                        <div className="ml-3 border-l border-line pl-1">{items.map((c) => renderConn(c))}</div>
                      ))}
                  </div>
                );
              })}

              {/* —— 未归入文件夹的 Nacos 连接 —— */}
              {ungrouped.map((c) => renderConn(c))}
            </>
          );
        })()}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.conn)} onClose={() => setMenu(null)} />}
      {folderMenu && <ContextMenu x={folderMenu.x} y={folderMenu.y} items={folderMenuItems(folderMenu.folder)} onClose={() => setFolderMenu(null)} />}
    </div>
  );
}
