import { create } from 'zustand';
import type { ConnectionKind } from '@shared/types';

/**
 * 屏幕标识 —— 顶部导航只保留核心屏。
 *
 * 按专业桌面客户端的信息架构：
 * - 导航常驻：工作台 / SQL 编辑器 / 数据网格 / Redis / 结构对比；
 * - 云同步、AI 配置 → 「设置」弹窗（openOverlay('settings')）；
 * - 传输向导、SFTP 全屏 → 连接树右键菜单 / SFTP 面板按钮；
 * - 连接编辑 → 连接树「+」/ 右键「编辑」弹窗；
 * - AI 深度任务 → AI 侧栏头部按钮；
 * - 堡垒机连接 → 工作台连接树直接管理（无独立屏）。
 * - 双击数据库连接 → 工作台左侧栏切到「数据库」树（不跳独立屏）。
 *
 * @since 0.1.0
 */
export type ScreenId =
  | 'shell' // 工作台（SSH + SFTP + 数据库树 + AI）
  | 'query' // SQL 编辑器
  | 'grid' // 数据网格
  | 'redis' // Redis
  | 'diff'; // 结构对比

/** 工作台左侧栏模式：SSH 连接树 / 数据库对象树 */
export type WbSidebar = 'ssh' | 'db';

/** 工作台终端标签：每个已连接 SSH 主机的终端为一个标签（XTerminal 风格多会话） */
export interface TermTab {
  /** 所属 SSH / 堡垒机连接 id */
  connId: string;
}

/** 数据库数据标签页（工作台中间区域，与终端标签并列）。PG：db=模式(schema)，pgDb=实际库名（跨库内省/预览用） */
export type DbTab =
  | { id: string; connId: string; type: 'table'; db?: string; pgDb?: string; table: string; title: string }
  | { id: string; connId: string; type: 'query'; title: string };

/** 单个导航项元数据（用于顶部导航渲染） */
export interface NavItem {
  id: ScreenId;
  label: string;
  /** 序号角标，如 "①" */
  badge: string;
}

/** 顶部导航项列表（顺序即展示顺序） */
export const NAV_ITEMS: NavItem[] = [
  { id: 'shell', label: '工作台', badge: '①' },
  { id: 'query', label: 'SQL 编辑器', badge: '②' },
  { id: 'grid', label: '数据网格', badge: '③' },
  { id: 'redis', label: 'Redis', badge: '④' },
  { id: 'diff', label: '结构对比', badge: '⑤' },
];

/** 全局弹层种类（模态覆盖层，非屏幕跳转） */
export type OverlayKind = 'settings' | 'transfer' | 'sftpfull' | 'aitask' | 'connection-edit';

/** 打开的弹层；connectionId 为可选上下文（如右键某条连接触发的传输/全屏/编辑） */
export interface Overlay {
  kind: OverlayKind;
  connectionId?: string;
  /** connection-edit 预置表单值
   * - 悬停文件夹下新建 → 预置 group；
   * - 按侧栏分类新建 → 预置 kind（默认类型）+ kindScope（类型选择器可选项范围）。 */
  preset?: { group?: string; kind?: ConnectionKind; kindScope?: ConnectionKind[] };
}

/** 底部状态栏状态 */
export interface StatusState {
  /** 当前活跃连接名 */
  activeConnection?: string;
  /** 网络延迟（ms） */
  latencyMs?: number;
  /** 是否录制中 */
  recording: boolean;
  /** SFTP 是否跟随终端 */
  sftpFollowing: boolean;
  /** AI 是否就绪 */
  aiReady: boolean;
}

/** 应用全局 UI 状态 */
interface AppState {
  /** 当前激活屏幕 */
  activeScreen: ScreenId;
  /** 当前打开的全局弹层（null=无） */
  overlay: Overlay | null;
  /** 全局命令面板（⌘K）开关 */
  commandPaletteOpen: boolean;
  /** AI 助手侧栏开关（默认关闭，标题栏按钮切换） */
  aiSidebarOpen: boolean;
  /** 工作台左侧栏当前模式（SSH 连接树 / 数据库对象树） */
  wbSidebar: WbSidebar;
  /** 工作台中间区打开的数据库标签页（终端为常驻第一个标签） */
  dbTabs: DbTab[];
  /** 当前激活的数据库标签页 id */
  activeDbTab: string | null;
  /** 已打开的终端会话标签（每个 SSH/堡垒机连接一个，XTerminal 风格） */
  termTabs: TermTab[];
  /** 当前激活的终端标签连接 id（null=无激活终端，显示数据库标签或空态） */
  activeTerm: string | null;
  /** 底部状态栏 */
  status: StatusState;
  /** 切换屏幕（并关闭弹层） */
  setScreen: (id: ScreenId) => void;
  /** 切换工作台左侧栏模式 */
  setWbSidebar: (m: WbSidebar) => void;
  /** 打开/聚焦数据库标签页（同 id 幂等） */
  openDbTab: (t: DbTab) => void;
  /** 关闭数据库标签页 */
  closeDbTab: (id: string) => void;
  /** 激活某个数据库标签页 */
  setActiveDbTab: (id: string | null) => void;
  /** 打开/聚焦一个终端会话标签（同 connId 幂等） */
  openTerminal: (connId: string) => void;
  /** 关闭一个终端会话标签 */
  closeTerminal: (connId: string) => void;
  /** 激活某个终端标签 */
  setActiveTerm: (connId: string | null) => void;
  /** 打开全局弹层 */
  openOverlay: (o: Overlay) => void;
  /** 关闭全局弹层 */
  closeOverlay: () => void;
  /** 切换命令面板 */
  toggleCommandPalette: (open?: boolean) => void;
  /** 切换 AI 侧栏；不传参时取反 */
  toggleAiSidebar: (open?: boolean) => void;
  /** 更新状态栏 */
  setStatus: (patch: Partial<StatusState>) => void;
}

/**
 * 应用全局状态 store。
 *
 * 仅保存 UI 级状态（当前屏幕、弹层、面板开关、状态栏），
 * 领域数据（连接、文件树、结果集）由各业务 store 持有，避免单点膨胀。
 *
 * @since 0.1.0
 */
export const useAppStore = create<AppState>((set) => ({
  activeScreen: 'shell',
  overlay: null,
  commandPaletteOpen: false,
  aiSidebarOpen: false,
  wbSidebar: 'ssh',
  dbTabs: [],
  activeDbTab: null,
  termTabs: [],
  activeTerm: null,
  status: {
    recording: false,
    sftpFollowing: true,
    aiReady: false,
  },

  /** 切换激活屏幕，并关闭命令面板与弹层 */
  setScreen: (id) => set({ activeScreen: id, overlay: null, commandPaletteOpen: false }),

  setWbSidebar: (m) => set({ wbSidebar: m }),

  openDbTab: (t) =>
    set((s) => ({
      dbTabs: s.dbTabs.some((x) => x.id === t.id) ? s.dbTabs : [...s.dbTabs, t],
      activeDbTab: t.id,
      wbSidebar: 'db',
    })),

  closeDbTab: (id) =>
    set((s) => {
      const tabs = s.dbTabs.filter((t) => t.id !== id);
      return {
        dbTabs: tabs,
        activeDbTab: s.activeDbTab === id ? (tabs[tabs.length - 1]?.id ?? null) : s.activeDbTab,
      };
    }),

  setActiveDbTab: (id) => set((s) => ({ activeDbTab: id, wbSidebar: id ? 'db' : s.wbSidebar })),

  openTerminal: (connId) =>
    set((s) => ({
      termTabs: s.termTabs.some((t) => t.connId === connId) ? s.termTabs : [...s.termTabs, { connId }],
      activeTerm: connId,
      activeDbTab: null,
      wbSidebar: 'ssh',
    })),

  closeTerminal: (connId) =>
    set((s) => {
      const tabs = s.termTabs.filter((t) => t.connId !== connId);
      const active = s.activeTerm === connId ? (tabs[tabs.length - 1]?.connId ?? null) : s.activeTerm;
      return { termTabs: tabs, activeTerm: active };
    }),

  setActiveTerm: (connId) => set((s) => ({ activeTerm: connId, activeDbTab: null, wbSidebar: connId ? 'ssh' : s.wbSidebar })),

  /** 打开弹层（同屏只保留一个） */
  openOverlay: (o) => set({ overlay: o, commandPaletteOpen: false }),

  /** 关闭弹层 */
  closeOverlay: () => set({ overlay: null }),

  /** 打开/关闭命令面板；不传参时取反 */
  toggleCommandPalette: (open) =>
    set((s) => ({ commandPaletteOpen: open ?? !s.commandPaletteOpen })),

  /** 打开/关闭 AI 助手侧栏；不传参时取反 */
  toggleAiSidebar: (open) => set((s) => ({ aiSidebarOpen: open ?? !s.aiSidebarOpen })),

  /** 局部更新状态栏 */
  setStatus: (patch) => set((s) => ({ status: { ...s.status, ...patch } })),
}));
