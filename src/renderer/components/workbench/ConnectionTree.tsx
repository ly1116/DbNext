import { useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { useAppStore } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import type { ConnectionFolder, ConnectionSummary, EnvironmentTag } from '@shared/types';
import { folderScope } from '@shared/types';
import { StatusDot } from '@renderer/components/common/States';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';

/**
 * 左侧连接树（真实实现）。
 *
 * 展示层级：**自定义文件夹（新建文件夹按钮创建，真实持久化）→ 环境/分组**。
 * 连接通过右键「移动到文件夹」归入自定义文件夹；未归入的按环境分组展示。
 *
 * 交互：
 * - 头部「📁+」新建文件夹：树内出现内联命名输入，Enter 确认 / Esc 取消；
 * - 文件夹右键：重命名（内联输入）/ 删除文件夹（内部连接移出为未分组，不删连接）；
 * - 连接右键：连接 / 编辑 / 传输文件 / SFTP 全屏 / 移动到文件夹 / 删除。
 *
 * @since 0.1.0
 */
export function ConnectionTree() {
  const connections = useConnections((s) => s.connections);
  const folders = useConnections((s) => s.folders);
  const initialized = useConnections((s) => s.initialized);
  const load = useConnections((s) => s.load);
  const selectedId = useConnections((s) => s.selectedId);
  const select = useConnections((s) => s.select);
  const removeConn = useConnections((s) => s.remove);
  const setStatus = useConnections((s) => s.setStatus);
  const addFolder = useConnections((s) => s.addFolder);
  const renameFolder = useConnections((s) => s.renameFolder);
  const removeFolder = useConnections((s) => s.removeFolder);
  const moveToFolder = useConnections((s) => s.moveToFolder);
  const appSetStatus = useAppStore((s) => s.setStatus);
  const openOverlay = useAppStore((s) => s.openOverlay);

  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /** 新建文件夹：内联命名输入 */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  /** 正在重命名的文件夹（内联输入） */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** 右键菜单：连接 / 文件夹 */
  const [menu, setMenu] = useState<{ conn: ConnectionSummary; x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: ConnectionFolder; x: number; y: number } | null>(null);
  /** 鼠标当前悬停的文件夹：点「+ 新建连接」时新连接直接归入该文件夹 */
  const [hoverFolderName, setHoverFolderName] = useState<string | null>(null);
  /** 拖拽归组：正在拖动的连接 id / 拖拽悬停的目标文件夹 id */
  const [dragConn, setDragConn] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized) void load();
  }, [initialized, load]);

  /** 数据隔离：本树只显示 SSH / 堡垒机连接（数据库连接只在「数据库」树可见） */
  const sshConns = useMemo(() => connections.filter((c) => c.kind === 'ssh' || c.kind === 'bastion'), [connections]);

  /** 本侧栏专属文件夹（SSH / 堡垒机作用域，不显示数据库侧的文件夹） */
  const myFolders = useMemo(() => folders.filter((f) => folderScope(f) === 'ssh'), [folders]);
  /** 归属于本侧栏自定义文件夹的连接名集合（环境分组里排除这些） */
  const folderedNames = useMemo(() => new Set(myFolders.map((f) => f.name)), [myFolders]);
  const groups = useMemo(() => groupByEnvironment(sshConns, filter, folderedNames), [sshConns, filter, folderedNames]);
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  /** 选中连接：联动底部状态栏 + 全局选中态 */
  const selectConn = (c: ConnectionSummary) => {
    select(c.id);
    appSetStatus({ activeConnection: c.name, aiReady: true });
  };

  const toggleConn = async (c: ConnectionSummary) => {
    if (c.status === 'connected') {
      await api.disconnect(c.id).catch(() => undefined);
      setStatus(c.id, 'disconnected');
    } else {
      setStatus(c.id, 'connecting');
      try {
        const s = await api.connect(c.id);
        select(s.id);
        if (c.kind === 'ssh' || c.kind === 'bastion') {
          useAppStore.getState().openTerminal(c.id);
        }
      } catch {
        setStatus(c.id, 'error');
        appSetStatus({ activeConnection: `${c.name}：连接失败` });
      }
    }
  };

  /** 双击连接：数据库类型 → 左侧栏切到「数据库」树（连接如未连则先连）；SSH → 连接/断开切换 */
  const openConn = async (c: ConnectionSummary) => {
    if (c.kind !== 'mysql' && c.kind !== 'postgres') {
      void toggleConn(c);
      return;
    }
    select(c.id);
    appSetStatus({ activeConnection: c.name, aiReady: true });
    if (c.status !== 'connected') {
      setStatus(c.id, 'connecting');
      try {
        const s = await api.connect(c.id);
        select(s.id);
      } catch {
        setStatus(c.id, 'error');
        appSetStatus({ activeConnection: `${c.name}：连接失败` });
        return;
      }
    }
    useAppStore.getState().setWbSidebar('db');
  };

  /** 提交「新建文件夹」内联输入 */
  const submitCreate = () => {
    if (newName.trim()) void addFolder(newName, 'ssh');
    setNewName('');
    setCreating(false);
  };

  /** 提交「重命名」内联输入 */
  const submitRename = () => {
    if (renaming && renaming.name.trim()) void renameFolder(renaming.id, renaming.name);
    setRenaming(null);
  };

  /** 组装连接右键菜单项（按连接类型动态裁剪） */
  const menuItems = (c: ConnectionSummary): MenuItem[] => {
    const isSshLike = c.kind === 'ssh' || c.kind === 'bastion';
    const currentFolder = folders.find((f) => f.name === c.group);
    return [
      {
        label: c.status === 'connected' ? '断开' : '连接',
        onClick: () => void toggleConn(c),
      },
      {
        label: '编辑…',
        onClick: () => openOverlay({ kind: 'connection-edit', connectionId: c.id }),
      },
      ...(isSshLike
        ? ([
            { separator: true, label: '' },
            {
              label: '传输文件…',
              disabled: c.status !== 'connected',
              onClick: () => openOverlay({ kind: 'transfer', connectionId: c.id }),
            },
            {
              label: 'SFTP 全屏',
              disabled: c.status !== 'connected',
              onClick: () => openOverlay({ kind: 'sftpfull', connectionId: c.id }),
            },
          ] as MenuItem[])
        : []),
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
            ? ([
                { separator: true, label: '' },
                { label: '移出文件夹', onClick: () => void moveToFolder(c.id, null) },
              ] as MenuItem[])
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

  /** 文件夹右键菜单 */
  const folderMenuItems = (f: ConnectionFolder): MenuItem[] => [
    { label: '新建连接（归入此文件夹）', onClick: () => openOverlay({ kind: 'connection-edit', preset: { group: f.name } }) },
    { separator: true, label: '' },
    { label: '重命名…', onClick: () => setRenaming({ id: f.id, name: f.name }) },
    { separator: true, label: '' },
    {
      label: '删除文件夹',
      danger: true,
      onClick: () => void removeFolder(f.id),
    },
  ];

  return (
    <div className="flex w-[236px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">连接</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3" title="刷新" onClick={() => void load()}>
            <RefreshIcon />
          </button>
          {/* 新建文件夹：树内内联命名 */}
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3"
            title="新建文件夹"
            aria-label="新建文件夹"
            onClick={() => {
              setCreating(true);
              setNewName('');
            }}
          >
            <FolderPlusIcon />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-accent text-white hover:bg-accent2"
            title={hoverFolderName ? `新建 SSH/堡垒机连接（归入文件夹「${hoverFolderName}」）` : '新建 SSH / 堡垒机连接'}
            onClick={() =>
              openOverlay({
                kind: 'connection-edit',
                preset: { kind: 'ssh', kindScope: ['ssh', 'bastion'], ...(hoverFolderName ? { group: hoverFolderName } : {}) },
              })
            }
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="shrink-0 border-b border-line px-2 py-2">
        <div className="flex h-6 items-center gap-2 rounded border border-line bg-bg px-2">
          <SearchIcon />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选主机…"
            className="flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-dim2"
          />
        </div>
        {/* 新建文件夹内联命名输入（Enter 确认 / Esc 取消） */}
        {creating && (
          <div className="mt-2 flex h-6 items-center gap-1.5 rounded border border-accent bg-bg px-2">
            <FolderIcon className="shrink-0 text-warn" />
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
              className="flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-dim2"
            />
          </div>
        )}
      </div>

      <div
        className="flex-1 overflow-y-auto py-1 text-[12px] mono"
        onDragOver={(e) => {
          // 拖动连接经过树的空白/分组区域：允许放置 = 移出文件夹
          if (!dragConn) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('text/dbnest-conn') || dragConn;
          if (id) void moveToFolder(id, null);
          setDragConn(null);
          setDropFolderId(null);
        }}
      >
        {initialized && sshConns.length === 0 && myFolders.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-dim2">
            暂无连接，点击右上「+」新建。
          </div>
        )}

        {/* —— 自定义文件夹（SSH / 堡垒机作用域，不与数据库侧互通）—— */}
        {myFolders.map((f) => {
          const items = sshConns.filter(
            (c) => c.group === f.name && (!filter || c.name.toLowerCase().includes(filter.trim().toLowerCase()) || c.host.toLowerCase().includes(filter.trim().toLowerCase())),
          );
          const renamingThis = renaming?.id === f.id;
          return (
            <div key={f.id}>
              {renamingThis ? (
                /* 重命名内联输入 */
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <FolderIcon className="shrink-0 text-warn" />
                  <input
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitRename();
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                    onBlur={submitRename}
                    className="flex-1 rounded border border-accent bg-bg px-1.5 py-0.5 text-[12px] text-fg outline-none"
                  />
                </div>
              ) : (
                <button
                  onClick={() => toggle(f.id)}
                  onMouseEnter={() => setHoverFolderName(f.name)}
                  onMouseLeave={() => setHoverFolderName((cur) => (cur === f.name ? null : cur))}
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
                    const id = e.dataTransfer.getData('text/dbnest-conn') || dragConn;
                    if (id) void moveToFolder(id, f.id);
                    setDropFolderId(null);
                    setDragConn(null);
                  }}
                  className={`tree-row flex w-full items-center gap-1 px-2 py-1 text-left ${hoverFolderName === f.name ? 'bg-panel3' : ''} ${dropFolderId === f.id ? 'ring-1 ring-accent' : ''}`}
                  title="拖动连接到此可归入文件夹；右键：重命名 / 删除"
                >
                  <Chevron open={!collapsed[f.id]} />
                  <FolderIcon className="shrink-0 text-warn" />
                  <span className="truncate font-medium text-fg">{f.name}</span>
                  <span className="ml-1 text-[10px] text-dim2">{items.length}</span>
                </button>
              )}

              {!collapsed[f.id] &&
                (items.length === 0 ? (
                  <div className="py-0.5 pl-9 pr-2 text-[10px] text-dim2">（空）右键连接 → 移动到文件夹</div>
                ) : (
                  items.map((c) => (
                    <ConnectionRow
                      key={c.id}
                      conn={c}
                      active={selectedId === c.id}
                      onSelect={() => selectConn(c)}
                      onToggle={() => void toggleConn(c)}
                      onOpen={() => void openConn(c)}
                      onContextMenu={(x, y) => setMenu({ conn: c, x, y })}
                      onDragState={setDragConn}
                    />
                  ))
                ))}
            </div>
          );
        })}

        {/* —— 未归入文件夹的连接：按环境分组 —— */}
        {groups.map((g) => (
          <div key={g.key}>
            <button onClick={() => toggle(g.key)} className="tree-row flex w-full items-center gap-1 px-2 py-1 text-left">
              <Chevron open={!collapsed[g.key]} />
              <EnvIcon env={g.env} />
              <span className="font-medium text-fg">{g.label}</span>
              <span className="ml-1 text-[10px] text-dim2">{g.items.length}</span>
            </button>

            {!collapsed[g.key] &&
              g.items.map((c) => (
                <ConnectionRow
                  key={c.id}
                  conn={c}
                  active={selectedId === c.id}
                  onSelect={() => selectConn(c)}
                  onToggle={() => void toggleConn(c)}
                  onOpen={() => void openConn(c)}
                  onContextMenu={(x, y) => setMenu({ conn: c, x, y })}
                  onDragState={setDragConn}
                />
              ))}
          </div>
        ))}
      </div>

      <div className="flex h-7 shrink-0 items-center border-t border-line px-3 text-[10px] text-dim2">
        {sshConns.length} 个连接 · {sshConns.filter((c) => c.environment === 'prod').length} 个生产
      </div>

      {/* 连接右键菜单（编辑 / 传输 / SFTP 全屏 / 移动到文件夹 / 删除） */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.conn)}
          onClose={() => setMenu(null)}
        />
      )}
      {/* 文件夹右键菜单（重命名 / 删除文件夹） */}
      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems(folderMenu.folder)}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </div>
  );
}

function ConnectionRow({
  conn,
  active,
  onSelect,
  onToggle,
  onOpen,
  onContextMenu,
  onDragState,
}: {
  conn: ConnectionSummary;
  active: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onOpen: () => void;
  onContextMenu: (x: number, y: number) => void;
  onDragState: (id: string | null) => void;
}) {
  const isDb = conn.kind === 'mysql' || conn.kind === 'postgres';
  return (
    <div
      className={`tree-row flex w-full items-center gap-1.5 py-1 pl-9 pr-2 ${active ? 'bg-panel3' : ''}`}
      style={active ? { boxShadow: 'inset 2px 0 0 #0e639c' } : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      onDoubleClick={isDb ? onOpen : onToggle}
      title={isDb ? '双击打开数据库树' : conn.status === 'connected' ? '双击断开连接' : '双击连接'}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/dbnest-conn', conn.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragState(conn.id);
      }}
      onDragEnd={() => onDragState(null)}
    >
      <button onClick={onSelect} className="flex flex-1 items-center gap-1.5 text-left">
        <StatusDot status={conn.status} />
        <KindIcon kind={conn.kind} />
        <span className={active ? 'text-fg' : 'text-dim'}>{conn.name}</span>
      </button>
    </div>
  );
}

/* —— 分组与图标 —— */
interface Group { key: string; label: string; env: EnvironmentTag; items: ConnectionSummary[]; }

/** 按环境分组（已归入自定义文件夹的连接不重复出现） */
function groupByEnvironment(list: ConnectionSummary[], filter: string, folderedNames: Set<string>): Group[] {
  const kw = filter.trim().toLowerCase();
  const matched = (kw ? list.filter((c) => c.name.toLowerCase().includes(kw) || c.host.toLowerCase().includes(kw)) : list).filter(
    (c) => !c.group || !folderedNames.has(c.group),
  );
  const order: EnvironmentTag[] = ['prod', 'staging', 'dev', 'bastion'];
  return order
    .map((env) => ({ key: env, label: envLabel(env), env, items: matched.filter((c) => c.environment === env) }))
    .filter((g) => g.items.length > 0);
}
function envLabel(env: EnvironmentTag): string {
  return { prod: '生产环境', staging: '预发环境', dev: '开发环境', bastion: '堡垒机' }[env];
}
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chev h-3 w-3 text-dim2 ${open ? 'open' : ''}`} fill="currentColor" viewBox="0 0 12 12">
      <path d="M4 3l4 3-4 3z" />
    </svg>
  );
}
function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={`h-3.5 w-3.5 ${className ?? ''}`} fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function EnvIcon({ env }: { env: EnvironmentTag }) {
  const color = env === 'prod' ? 'text-prod' : env === 'bastion' ? 'text-warn' : 'text-ok';
  return (
    <svg className={`h-3.5 w-3.5 shrink-0 ${color}`} fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function KindIcon({ kind }: { kind: ConnectionSummary['kind'] }) {
  if (kind === 'ssh' || kind === 'bastion') {
    return (
      <svg className="h-3.5 w-3.5 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 10 2 2-2 2M13 14h4" />
      </svg>
    );
  }
  return <div className="h-3.5 w-3.5 shrink-0 rounded-sm bg-[#e48e00] text-center text-[8px] font-bold leading-[14px] text-black">M</div>;
}
function RefreshIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function FolderPlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg className="h-3 w-3 text-dim2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
