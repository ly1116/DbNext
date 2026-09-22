import { create } from 'zustand';
import { api } from '@renderer/api';
import type { ConnectionConfig, ConnectionFolder, ConnectionKind, ConnectionStatus, ConnectionSummary } from '@shared/types';

/**
 * 连接状态 store（渲染端单一事实来源）。
 *
 * 取代原型的「内存种子 / mock 数据」：所有连接来自主进程真实持久化存储
 * （userData 下 connections.json，凭据加密），连接状态由主进程经
 * `connection:status` 实时推送并反映到这里。
 *
 * 屏幕组件统一从这里取连接列表与选中态，避免各自重复拉取。
 *
 * @since 0.1.0
 */
interface ConnectionState {
  /** 全部连接（脱敏摘要，含运行时状态） */
  connections: ConnectionSummary[];
  /** 自定义文件夹列表（连接树「新建文件夹」产物，持久化于主进程） */
  folders: ConnectionFolder[];
  /** 当前选中的连接 id（多数屏幕需要「针对哪个连接操作」） */
  selectedId: string | null;
  /** 加载中 */
  loading: boolean;
  /** 错误信息（如未运行在桌面端） */
  error: string | null;
  /** 是否已尝试过初次加载 */
  initialized: boolean;

  /** 初次/手动加载连接列表（连同自定义文件夹） */
  load: () => Promise<void>;
  /** 选中某连接 */
  select: (id: string | null) => void;
  /** 新增或更新一条连接（保存/导入后调用） */
  upsert: (c: ConnectionSummary) => void;
  /** 删除一条连接 */
  remove: (id: string) => void;
  /** 更新某连接的运行时状态 */
  setStatus: (id: string, status: ConnectionStatus) => void;
  /** 新建文件夹（真实持久化，可指定所属侧栏作用域 ssh/db） */
  addFolder: (name: string, scope?: 'ssh' | 'db') => Promise<void>;
  /** 重命名文件夹（同步更新归属连接的 group） */
  renameFolder: (id: string, name: string) => Promise<void>;
  /** 删除文件夹（内部连接移出为未分组，连接本身不删） */
  removeFolder: (id: string) => Promise<void>;
  /** 把连接移入/移出文件夹（folderId=null 移出） */
  moveToFolder: (connId: string, folderId: string | null) => Promise<void>;
  /** 内部：按文件夹名直接写回连接 group（moveToFolder 的底层实现） */
  moveToFolderByGroup: (connId: string, group: string | undefined) => Promise<void>;
  /** 各 SSH 连接的终端当前工作目录（用于 SFTP 面板跟随终端 cd） */
  cwdByConn: Record<string, string>;
  /** 更新某连接的终端当前目录（仅变化时更新，避免无谓刷新） */
  setCwd: (connId: string, cwd: string) => void;
}

export const useConnections = create<ConnectionState>((set, get) => ({
  connections: [],
  folders: [],
  selectedId: null,
  loading: false,
  error: null,
  initialized: false,
  cwdByConn: {},

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const [list, folders] = await Promise.all([api.listConnections(), api.getFolders().catch(() => [])]);
      set((s) => ({
        connections: list,
        folders,
        loading: false,
        initialized: true,
        selectedId: s.selectedId && list.some((c) => c.id === s.selectedId) ? s.selectedId : list[0]?.id ?? null,
      }));
    } catch (e) {
      set({ error: (e as Error).message, loading: false, initialized: true });
    }
  },

  select: (id) => set({ selectedId: id }),

  upsert: (c) =>
    set((s) => {
      const idx = s.connections.findIndex((x) => x.id === c.id);
      const next = idx >= 0 ? [...s.connections.slice(0, idx), c, ...s.connections.slice(idx + 1)] : [c, ...s.connections];
      return { connections: next };
    }),

  remove: (id) =>
    set((s) => ({
      connections: s.connections.filter((c) => c.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),

  setStatus: (id, status) =>
    set((s) => ({ connections: s.connections.map((c) => (c.id === id ? { ...c, status } : c)) })),

  addFolder: async (name, scope) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const folders = [...get().folders, { id: `fld-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: trimmed, scope: scope ?? 'ssh' }];
    set({ folders: await api.setFolders(folders).catch(() => folders) });
  },

  renameFolder: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const target = get().folders.find((f) => f.id === id);
    if (!target || target.name === trimmed) return;
    const folders = get().folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f));
    set({ folders: await api.setFolders(folders).catch(() => folders) });
    // 归属连接的 group 跟随改名（真实写回连接存储）
    for (const c of get().connections.filter((x) => x.group === target.name)) {
      await get().moveToFolderByGroup(c.id, trimmed);
    }
  },

  removeFolder: async (id) => {
    const target = get().folders.find((f) => f.id === id);
    if (!target) return;
    const folders = get().folders.filter((f) => f.id !== id);
    set({ folders: await api.setFolders(folders).catch(() => folders) });
    // 内部连接移出为未分组（连接本身保留）
    for (const c of get().connections.filter((x) => x.group === target.name)) {
      await get().moveToFolderByGroup(c.id, undefined);
    }
  },

  moveToFolder: async (connId, folderId) => {
    const folder = folderId ? get().folders.find((f) => f.id === folderId) : undefined;
    await get().moveToFolderByGroup(connId, folder?.name);
  },

  /**
   * 真实写回连接的 group 字段。
   * 摘要不含凭据 → saveConnection 对既有连接「凭据留空即沿用密文」，不会丢凭据。
   */
  moveToFolderByGroup: async (connId, group) => {
    const c = get().connections.find((x) => x.id === connId);
    if (!c) return;
    try {
      const saved = await api.saveConnection({ ...c, group } as unknown as ConnectionConfig);
      // 保留当前运行时状态（主进程返回的是未连接快照）
      get().upsert({ ...saved, status: c.status });
    } catch {
      /* 桌面端写回失败时保持原状 */
    }
  },

  setCwd: (connId, cwd) =>
    set((s) => {
      const next = cwd || '/';
      if (s.cwdByConn[connId] === next) return s;
      return { cwdByConn: { ...s.cwdByConn, [connId]: next } };
    }),
}));

/** 取某类连接（按 kind 过滤） */
export function connectionsOfKind(kind: ConnectionKind | ConnectionKind[]): ConnectionSummary[] {
  const list = useConnections.getState().connections;
  const kinds = Array.isArray(kind) ? kind : [kind];
  return list.filter((c) => kinds.includes(c.kind));
}
