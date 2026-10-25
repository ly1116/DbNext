import { useEffect, useRef, useState } from 'react';
import { DbTree } from '@renderer/components/workbench/DbTree';
import { ConnectionTree } from '@renderer/components/workbench/ConnectionTree';
import { DbDataTabs } from '@renderer/components/workbench/DbDataTabs';
import { TerminalPane } from '@renderer/components/workbench/TerminalPane';
import { RemoteFileEditor } from '@renderer/components/workbench/RemoteFileEditor';
import { SftpTree } from '@renderer/components/workbench/SftpTree';
import { NacosTree } from '@renderer/components/workbench/NacosTree';
import { AiSidebar } from '@renderer/components/workbench/AiSidebar';
import { WorkbenchStatusBar } from '@renderer/components/workbench/WorkbenchStatusBar';
import { KindIcon } from '@renderer/components/common/KindIcon';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore, type DbTab, type TermTab } from '@renderer/store/appStore';
import { usePrefs } from '@renderer/store/prefsStore';
import type { ConnectionStatus, ConnectionSummary } from '@shared/types';
import { api } from '@renderer/api';
import { Icon, IconBox } from '@renderer/components/common/icons';

/**
 * Navicat 风格主窗口。
 *
 * 信息架构（对齐 Navicat Premium）：
 * - 顶部标题栏内嵌工具栏（新建连接 / 新建查询 / 用户 / 传输 / 结构同步 / 导入 / 导出 / 刷新，随侧栏模式切换；见 WorkbenchToolbar）；
 * - 最左：窄图标侧栏，切换「数据库树」/「SSH 主机树」两棵互不串门的导航器（两棵树与中间面板均常驻挂载，切换仅改可见性，终端会话/展开状态/SFTP 目录不丢）；
 * - 左侧：当前模式的连接导航器（数据库模式 = DbTree：文件夹 → 连接 → 库/模式 → 对象类型分组，含 Redis；SSH 模式 = ConnectionTree：SSH/堡垒机主机 + 专属文件夹 + 筛选）；
 * - 中间：标签区随模式隔离——SSH 模式只有终端标签，数据库模式只有数据标签，激活标签对应内容在下方渲染；
 * - 激活 SSH 主机且已连时，右侧出现 SFTP 面板；
 * - AI 侧栏由标题栏按钮控制。
 *
 * @since 0.3.0
 */

/** 左侧导航树默认宽度（连接树与数据库树共用，保证两种模式切换时宽度一致） */
const DEFAULT_TREE_WIDTH = 252;

export function WorkbenchScreen() {
  const connections = useConnections((s) => s.connections);

  const dbTabs = useAppStore((s) => s.dbTabs);
  const aiSidebarOpen = useAppStore((s) => s.aiSidebarOpen);
  const activeDbTab = useAppStore((s) => s.activeDbTab);
  const setActiveDbTab = useAppStore((s) => s.setActiveDbTab);
  const closeDbTab = useAppStore((s) => s.closeDbTab);
  const closeOtherDbTabs = useAppStore((s) => s.closeOtherDbTabs);
  const refreshDbTab = useAppStore((s) => s.refreshDbTab);
  /** 标签右键菜单：{x,y} + 目标标签 id（标签栏「刷新 / 关闭当前 / 关闭其他」） */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const termTabs = useAppStore((s) => s.termTabs);
  const activeTerm = useAppStore((s) => s.activeTerm);
  const setActiveTerm = useAppStore((s) => s.setActiveTerm);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const openTerminal = useAppStore((s) => s.openTerminal);
  /** 远端文件编辑标签（SFTP 打开的文件） */
  const editorTabs = useAppStore((s) => s.editorTabs);
  const closeEditor = useAppStore((s) => s.closeEditor);
  /** 当前激活的编辑标签 id（null=未激活编辑标签，显示终端）；存于全局 store，openEditor 直接激活 */
  const activeEditorId = useAppStore((s) => s.activeEditor);
  const setActiveEditorId = useAppStore((s) => s.setActiveEditor);
  /** 激活编辑标签：切到 SSH 模式并停用终端标签（终端会话保持不断） */
  const setActiveEditor = (id: string) => {
    setActiveEditorId(id);
    setActiveTerm(null);
    useAppStore.getState().setWbSidebar('ssh');
  };
  /** SSH 终端重连计数：bump 对应键即可让 TerminalPane 重挂载并重新连接 */
  // 终端数据通路版本号：进 key 强制已开会话重挂载（v3=先订阅后建会话；v4=@ai 拦截+尺寸自愈；v5=清残留行；v6=流式+保留输入行；v7=Markdown ANSI 渲染）
  const TERM_LOGIC_V = 7;
  const [termRefresh, setTermRefresh] = useState<Record<string, number>>({});
  /** 终端字号「跟随终端」开关：开=字号跟随全局偏好；关=每个标签独立字号（工具条 A-/A+ 控制） */
  const [termFollow, setTermFollow] = useState<Record<string, boolean>>({});
  /** 每标签独立字号覆盖（仅「跟随终端」关闭时使用），单位 px */
  const [termFont, setTermFont] = useState<Record<string, number>>({});

  const showDb = !!activeDbTab && dbTabs.some((t) => t.id === activeDbTab);
  /** 激活终端标签（按标签 id 解析出连接）；无激活标签时回退到第一个标签 */
  const activeTermTab = termTabs.find((t) => t.id === activeTerm) ?? termTabs[0] ?? null;
  const activeTermConn = activeTermTab?.connId ?? null;
  const termConn = connections.find((c) => c.id === activeTermConn && (c.kind === 'ssh' || c.kind === 'bastion')) ?? null;
  /** SFTP 面板开关（SSH 模式右侧；终端工具条「SFTP」按钮切换） */
  const [sftpOpen, setSftpOpen] = useState(true);
  const isSshHost = !!termConn && termConn.status === 'connected';
  /** 最左窄图标侧边栏的当前面板：数据库树 / SSH 主机树（互不串门；工具栏随模式切换） */
  const wbSidebar = useAppStore((s) => s.wbSidebar);
  /** 标签栏按当前模式过滤：数据库模式只看非 nacos 标签，注册与配置模式只看 nacos 标签，
   *  使两类标签不再混在同一标签栏（各自独立页面，互不串台）。 */
  const visibleDbTabs =
    wbSidebar === 'nacos' ? dbTabs.filter((t) => t.type === 'nacos') : dbTabs.filter((t) => t.type !== 'nacos');

  // 激活标签被关闭/失效时顺延到最后一个（openEditor 已在 store 内直接激活新标签，无需在此处理）
  useEffect(() => {
    if (!editorTabs.length) {
      if (activeEditorId) setActiveEditorId(null);
      return;
    }
    if (activeEditorId && !editorTabs.some((t) => t.id === activeEditorId)) {
      setActiveEditorId(editorTabs[editorTabs.length - 1].id);
    }
  }, [editorTabs, activeEditorId, setActiveEditorId]);

  const activeEditor = editorTabs.find((t) => t.id === activeEditorId) ?? null;

  /* —— 标签栏溢出处理：激活标签自动滚入可视区 + 滚轮横向滚动（滚动条隐藏） —— */
  const dbTabBarRef = useRef<HTMLDivElement>(null);
  const termTabBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = dbTabBarRef.current;
    if (!bar || !activeDbTab) return;
    bar.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeDbTab)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeDbTab, visibleDbTabs.length]);
  useEffect(() => {
    const bar = termTabBarRef.current;
    if (!bar || !activeTermTab) return;
    bar.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTermTab.id)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeTermTab, termTabs.length]);
  /** 垂直滚轮转为标签栏横向滚动（浏览器标签页习惯）；事件触发时再读 ref，避免首渲染捕获 null */
  const wheelScrollBar = (ref: React.RefObject<HTMLDivElement | null>) => (e: React.WheelEvent) => {
    const bar = ref.current;
    if (!bar || e.deltaY === 0) return;
    bar.scrollLeft += e.deltaY;
  };
  /* —— 标签栏溢出箭头：内容超宽时右侧出现 ▾，点开下拉列出全部标签（激活高亮），点击滚回可视区 —— */
  const [dbOverflow, setDbOverflow] = useState(false);
  const [dbMoreOpen, setDbMoreOpen] = useState(false);
  const [termOverflow, setTermOverflow] = useState(false);
  const [termMoreOpen, setTermMoreOpen] = useState(false);
  /** 量一次溢出状态（scrollWidth > clientWidth 即有标签被挤出屏幕外） */
  const measureOverflow = () => {
    const db = dbTabBarRef.current;
    if (db) setDbOverflow(db.scrollWidth > db.clientWidth + 1);
    const term = termTabBarRef.current;
    if (term) setTermOverflow(term.scrollWidth > term.clientWidth + 1);
  };
  useEffect(() => {
    // 栏尺寸随窗口/侧栏拖拽变化 → ResizeObserver；标签增删 → 依赖数组触发
    const ro = new ResizeObserver(measureOverflow);
    if (dbTabBarRef.current) ro.observe(dbTabBarRef.current);
    if (termTabBarRef.current) ro.observe(termTabBarRef.current);
    measureOverflow();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(measureOverflow, [visibleDbTabs, termTabs]);
  /** 从下拉激活标签：即使已激活（effect 不触发）也强制滚回可视区 */
  const activateDbTabFromMore = (id: string) => {
    setActiveDbTab(id);
    setDbMoreOpen(false);
    requestAnimationFrame(() => {
      dbTabBarRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  };
  const activateTermFromMore = (id: string) => {
    setActiveTerm(id);
    setTermMoreOpen(false);
    requestAnimationFrame(() => {
      termTabBarRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  };
  const setWbSidebar = useAppStore((s) => s.setWbSidebar);
  const [sftpWidth, setSftpWidth] = useState(300);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  // 左侧导航树宽度（连接树 / 数据库树共用同一宽度，保证切换时视觉一致；分隔线可拖拽）
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const treeDragRef = useRef<{ startX: number; startW: number } | null>(null);
  /** 拖拽中：给光标与分隔线持续反馈（按住拖时也能看出在动） */
  const [treeDragging, setTreeDragging] = useState(false);

  const startTreeDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    treeDragRef.current = { startX: e.clientX, startW: treeWidth };
    setTreeDragging(true);
    // 拖拽期间锁定全局光标，移出分隔线也保持 col-resize
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const w = treeDragRef.current;
      if (!w) return;
      setTreeWidth(Math.min(560, Math.max(180, w.startW + (ev.clientX - w.startX))));
    };
    const onUp = () => {
      treeDragRef.current = null;
      setTreeDragging(false);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  // AI 助手侧栏宽度（可拖拽分隔线调整；与 SFTP 面板同一范式）
  const [aiWidth, setAiWidth] = useState(320);
  const aiDragRef = useRef<{ startX: number; startW: number } | null>(null);

  const startAiDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    aiDragRef.current = { startX: e.clientX, startW: aiWidth };
    const onMove = (ev: MouseEvent) => {
      const w = aiDragRef.current;
      if (!w) return;
      // 侧栏在右，向左拖变宽
      setAiWidth(Math.min(880, Math.max(240, w.startW + (w.startX - ev.clientX))));
    };
    const onUp = () => {
      aiDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startSftpDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: sftpWidth };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const w = dragRef.current.startW + (dragRef.current.startX - ev.clientX);
      setSftpWidth(Math.min(680, Math.max(180, w)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="workbench flex h-full w-full flex-col overflow-hidden bg-background">
      {/* 主体：窄图标侧栏 + 导航器 + 标签区（工具栏已内嵌顶部标题栏，由 App.tsx 挂载） */}
      <div className="flex min-h-0 flex-1">
        {/* —— 最左：窄图标导航（数据库 / SSH 主机 / 注册与配置），点击切换对应「页面」——
            每个模式的左树、标签栏、内容区各自独立（标签栏由 visibleDbTabs 按域过滤），互不混排。 */}
        <div className="flex w-[54px] shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/40 py-2">
          <SideIcon
            active={wbSidebar === 'db'}
            label="数据库"
            onClick={() => setWbSidebar('db')}
            icon={<Icon name="database-4" strokeWidth={1.7} />}
          />
          <SideIcon
            active={wbSidebar === 'ssh'}
            label="SSH / 主机"
            onClick={() => setWbSidebar('ssh')}
            icon={<Icon name="terminal" strokeWidth={1.7} />}
          />
          <SideIcon
            active={wbSidebar === 'nacos'}
            label="注册与配置"
            onClick={() => setWbSidebar('nacos')}
            icon={<Icon name="checklist" strokeWidth={1.7} />}
          />
        </div>
        {/* 两棵树常驻挂载，切换仅改可见性：展开状态 / 已加载数据不丢。
            宽度统一由 treeWidth 控制（两棵树一致）。
            注意顺序：分隔线必须在「树」之后（树的右边缘），不能夹在两棵树之间——
            否则 db 模式下 ConnectionTree 隐藏，分隔线会跑到 DbTree 左边。 */}
        <div className="flex min-h-0 shrink-0" style={{ display: wbSidebar === 'ssh' ? 'flex' : 'none' }}>
          <ConnectionTree width={treeWidth} />
        </div>
        <div className="flex min-h-0 shrink-0" style={{ display: wbSidebar === 'db' ? 'flex' : 'none' }}>
          <DbTree width={treeWidth} />
        </div>
        <div className="flex min-h-0 shrink-0" style={{ display: wbSidebar === 'nacos' ? 'flex' : 'none' }}>
          <NacosTree width={treeWidth} />
        </div>
        {/* 分隔线（树的右边缘）：命中区 7px 便于抓取，视觉上 1px 实线 + hover/拖拽强调色，
            浅色主题下也清晰（不再依赖几乎透明的 border-border）。*/}
        <div
          onMouseDown={startTreeDrag}
          onDoubleClick={() => setTreeWidth(DEFAULT_TREE_WIDTH)}
          className="group relative -ml-[3px] w-[7px] shrink-0 cursor-col-resize bg-transparent"
          style={{ display: wbSidebar === 'db' || wbSidebar === 'ssh' || wbSidebar === 'nacos' ? 'block' : 'none' }}
          title="左右拖拽调整侧栏宽度（双击恢复默认）"
        >
          <div className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${treeDragging ? 'bg-primary' : 'bg-line2 group-hover:bg-primary'}`} />
          {/* 拖拽热区：悬停/拖拽时显示加粗竖条，给出明确的可拖反馈 */}
          <div className={`absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-primary transition-opacity ${treeDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-70'}`} />
        </div>

        {/* —— 中间区：SSH 面板与数据库面板均常驻挂载，切换侧栏仅改可见性（终端会话不中断）—— */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* SSH 模式：主机标签栏 + 终端 */}
          <div className="flex min-h-0 flex-1 flex-col" style={{ display: wbSidebar === 'ssh' ? 'flex' : 'none' }}>
            {termTabs.length === 0 ? (
              <Empty text="请在左侧主机树双击一台 SSH / 堡垒机主机，将自动打开真实终端标签（支持多主机同时开多个终端）。" />
            ) : (
              <>
                {/* 主机标签栏：与数据库模式一致的标签外观（统一 flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 规范） */}
                <div className="relative flex h-9 shrink-0 items-stretch border-b border-border bg-background">
                  <div ref={termTabBarRef} onWheel={wheelScrollBar(termTabBarRef)} className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5">
                  {termTabs.map((t) => {
                    const c = connections.find((x) => x.id === t.connId);
                    const isActive = activeTermTab?.id === t.id;
                    // 同一主机开多个终端时，标题追加序号区分（host、host (2)、host (3)…）
                    const sameHost = termTabs.filter((x) => x.connId === t.connId);
                    const ord = sameHost.findIndex((x) => x.id === t.id) + 1;
                    const label = sameHost.length > 1 ? `${c?.name ?? t.connId} (${ord})` : (c?.name ?? t.connId);
                    return (
                      <div
                        key={t.id}
                        data-tab-id={t.id}
                        className={`group flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 transition-colors ${isActive ? 'tab-chip-active font-medium' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                      >
                        <button
                          onClick={() => {
                            // 切回终端：退出文件编辑态
                            setActiveEditorId(null);
                            setActiveTerm(t.id);
                          }}
                          className="flex items-center gap-1.5"
                          title={`${c ? `${c.name} · ${c.host}:${c.port}` : t.connId}（终端会话）`}
                        >
                          <TerminalGlyph />
                          <span className="max-w-[160px] truncate text-[length:calc(var(--pref-fs)*0.857)]">{label}</span>
                        </button>
                        <button
                          onClick={() => closeTerminal(t.id)}
                          className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none text-muted-foreground transition-opacity hover:bg-line2/40 hover:text-destructive ${isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                          title="关闭终端"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  {/* 「+」新终端标签：为当前激活主机再开一个独立会话（同一主机可多开） */}
                  <button
                    onClick={() => activeTermConn && openTerminal(activeTermConn)}
                    disabled={!activeTermConn}
                    className="ml-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    title="新建终端标签（同一主机可开多个独立会话）"
                  >
                    <Icon name="plus" className="h-3.5 w-3.5" strokeWidth={2.2} />
                  </button>
                  {/* 远端文件编辑标签（SFTP 打开的文件，VSCode 式独立标签；预览标签斜体，双击转正式） */}
                  {editorTabs.map((t) => {
                    const isActive = activeEditorId === t.id;
                    return (
                      <div
                        key={t.id}
                        data-tab-id={t.id}
                        className={`group flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 transition-colors ${isActive ? 'tab-chip-active font-medium' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                        onDoubleClick={() => useAppStore.getState().openEditor({ connId: t.connId, path: t.path, title: t.title })}
                        title={t.preview ? `${t.path}（预览标签：打开其他文件会替换 · 双击固定）` : t.path}
                      >
                        <button onClick={() => setActiveEditor(t.id)} className="flex items-center gap-1.5">
                          <FileGlyph />
                          <span className={`max-w-[160px] truncate text-[length:calc(var(--pref-fs)*0.857)] ${t.preview ? 'italic' : ''}`}>{t.title}</span>
                        </button>
                        <button
                          onClick={() => closeEditor(t.id)}
                          className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none text-muted-foreground transition-opacity hover:bg-line2/40 hover:text-destructive ${isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                          title="关闭编辑器标签"
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                  {termOverflow && <div className="w-7 shrink-0" />}
                  </div>
                  {termOverflow && (
                    <>
                      {termMoreOpen && <div className="fixed inset-0 z-40" onMouseDown={() => setTermMoreOpen(false)} />}
                      <div className="relative z-50 flex shrink-0 items-stretch border-l border-border bg-popover">
                        <button
                          onClick={() => setTermMoreOpen((v) => !v)}
                          title="查看所有终端标签"
                          className={`flex w-7 items-center justify-center ${termMoreOpen ? 'bg-secondary text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                        >
                          <Icon name="chevronDown" className="h-3.5 w-3.5"  />
                        </button>
                        {termMoreOpen && (
                          <div className="absolute right-0 top-full mt-px max-h-72 min-w-60 overflow-auto rounded-md border border-border bg-popover py-1 shadow-lg">
                            {termTabs.map((t) => {
                              const c = connections.find((x) => x.id === t.connId);
                              const isActive = activeTermTab?.id === t.id;
                              const sameHost = termTabs.filter((x) => x.connId === t.connId);
                              const ord = sameHost.findIndex((x) => x.id === t.id) + 1;
                              const label = sameHost.length > 1 ? `${c?.name ?? t.connId} (${ord})` : (c?.name ?? t.connId);
                              return (
                                <button
                                  key={t.id}
                                  onClick={() => activateTermFromMore(t.id)}
                                  className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[length:calc(var(--pref-fs)*0.857)] ${isActive ? 'bg-secondary text-primary' : 'text-foreground hover:bg-secondary'}`}
                                >
                                  <TerminalGlyph />
                                  <span className="min-w-0 flex-1 truncate">{label}</span>
                                  <span className="text-[9px] text-muted-foreground">终端</span>
                                  <span
                                    role="button"
                                    tabIndex={-1}
                                    onMouseDown={(e) => {
                                      e.stopPropagation();
                                      closeTerminal(t.id);
                                      if (termTabs.length <= 1) setTermMoreOpen(false);
                                    }}
                                    className="text-muted-foreground hover:text-destructive"
                                    title="关闭终端"
                                  >
                                    ✕
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {/* 所有已开终端实例保持挂载，仅显示激活的那个（保证 xterm 状态不丢）；切换 = 点击上方标签或双击树中主机。
                    激活文件编辑标签时全部隐藏（终端会话不中断） */}
                {termTabs.map((t) => {
                  const c = connections.find((x) => x.id === t.connId);
                  const follow = termFollow[t.id] ?? true;
                  const fontOverride = follow ? undefined : termFont[t.id];
                  return (
                    <div
                      key={`pane:${t.id}`}
                      className="flex min-h-0 flex-1 flex-col"
                      style={{ display: !activeEditor && activeTermTab?.id === t.id ? 'flex' : 'none' }}
                    >
                      <TerminalToolbar
                        tab={t}
                        hostLabel={c?.name}
                        connection={c}
                        status={c?.status}
                        follow={follow}
                        onToggleFollow={() =>
                          setTermFollow((m) => {
                            const next = { ...m, [t.id]: follow ? false : true };
                            if (follow) {
                              // 关掉「跟随」时快照当前全局字号，作为本标签独立字号的起点
                              setTermFont((f) => ({ ...f, [t.id]: usePrefs.getState().prefs.fontSize }));
                            } else {
                              setTermFont((f) => {
                                const n = { ...f };
                                delete n[t.id];
                                return n;
                              });
                            }
                            return next;
                          })
                        }
                        onFontDelta={(d) => {
                          if (follow) {
                            const cur = usePrefs.getState().prefs.fontSize;
                            usePrefs.getState().patch({ fontSize: Math.min(28, Math.max(10, cur + d)) });
                          } else {
                            const cur = termFont[t.id] ?? usePrefs.getState().prefs.fontSize;
                            setTermFont((m) => ({ ...m, [t.id]: Math.min(28, Math.max(10, cur + d)) }));
                          }
                        }}
                        sftpOpen={sftpOpen}
                        onToggleSftp={() => setSftpOpen((v) => !v)}
                        onReconnect={() => setTermRefresh((m) => ({ ...m, [t.id]: (m[t.id] ?? 0) + 1 }))}
                        onNewTab={() => openTerminal(t.connId)}
                        onCloseTab={() => closeTerminal(t.id)}
                      />
                      <div className="flex min-h-0 flex-1">
                        <TerminalPane
                          key={`tp:${t.id}:${termRefresh[t.id] ?? 0}:v${TERM_LOGIC_V}`}
                          connectionId={t.connId}
                          hostLabel={c?.name}
                          active={!activeEditor && wbSidebar === 'ssh' && activeTermTab?.id === t.id}
                          fontSizeOverride={fontOverride}
                        />
                      </div>
                    </div>
                  );
                })}
                {/* 远端文件编辑区：同样保持挂载（CodeMirror 实例不丢），仅切换显示 */}
                {editorTabs.map((t) => (
                  <div
                    key={`epane:${t.id}`}
                    className="flex min-h-0 flex-1 flex-col"
                    style={{ display: activeEditor?.id === t.id ? 'flex' : 'none' }}
                  >
                    <RemoteFileEditor
                      key={`fe:${t.id}`}
                      connectionId={t.connId}
                      path={t.path}
                      onSaved={() => {
                        // 保存成功后让 SFTP 面板刷新（文件大小/修改时间会变）
                        window.dispatchEvent(new CustomEvent('dataroost:sftp-refresh', { detail: t.connId }));
                      }}
                    />
                  </div>
                ))}
                {!activeEditor && isSshHost && <QuickCommandBar connectionId={activeTermConn} />}
              </>
            )}
          </div>

          {/* 数据库 / 注册与配置模式共享同一标签栏 + 数据区（Nacos 配置中心以工作台标签页形式嵌入，非弹窗） */}
          <div className="flex min-h-0 flex-1 flex-col" style={{ display: wbSidebar === 'db' || wbSidebar === 'nacos' ? 'flex' : 'none' }}>
            <>
              <div className="relative flex h-9 shrink-0 items-stretch border-b border-border bg-background">
                <div ref={dbTabBarRef} onWheel={wheelScrollBar(dbTabBarRef)} className="scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1.5">
                {visibleDbTabs.map((t) => {
                  const isActive = activeDbTab === t.id;
                  const glyph = dbTabGlyph(t);
                  return (
                    <div
                      key={t.id}
                      data-tab-id={t.id}
                      className={`group flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 transition-colors ${isActive ? 'tab-chip-active font-medium' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setActiveDbTab(t.id);
                        setTabMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
                      }}
                    >
                      <button onClick={() => setActiveDbTab(t.id)} className="flex items-center gap-1.5">
                        {glyph}
                        <span className="max-w-[150px] truncate text-[length:calc(var(--pref-fs)*0.857)]">{t.title}</span>
                      </button>
                      <button
                        onClick={() => closeDbTab(t.id)}
                        className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] leading-none text-muted-foreground transition-opacity hover:bg-line2/40 hover:text-destructive ${isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                        title="关闭"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {visibleDbTabs.length === 0 && (
                  <div className="flex items-center px-2 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
                    在左侧连接导航器双击连接展开库与表；双击表打开数据，双击 Redis 打开键浏览器。
                  </div>
                )}
                {/* 溢出时留出箭头宽度，避免最后一个标签被箭头盖住 */}
                {dbOverflow && <div className="w-7 shrink-0" />}
                </div>
                {dbOverflow && (
                  <>
                    {/* 点击其他区域关闭下拉的透明遮罩 */}
                    {dbMoreOpen && <div className="fixed inset-0 z-40" onMouseDown={() => setDbMoreOpen(false)} />}
                    <div className="relative z-50 flex shrink-0 items-stretch border-l border-border bg-popover">
                      <button
                        onClick={() => setDbMoreOpen((v) => !v)}
                        title="查看所有标签"
                        className={`flex w-7 items-center justify-center ${dbMoreOpen ? 'bg-secondary text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
                      >
                        <Icon name="chevronDown" className="h-3.5 w-3.5"  />
                      </button>
                      {dbMoreOpen && (
                        <div className="absolute right-0 top-full mt-px max-h-72 min-w-60 overflow-auto rounded-md border border-border bg-popover py-1 shadow-lg">
                          {visibleDbTabs.map((t) => {
                            const isActive = activeDbTab === t.id;
                            const glyph = dbTabGlyph(t);
                            return (
                              <button
                                key={t.id}
                                onClick={() => activateDbTabFromMore(t.id)}
                                className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[length:calc(var(--pref-fs)*0.857)] ${isActive ? 'bg-secondary text-primary' : 'text-foreground hover:bg-secondary'}`}
                              >
                                {glyph}
                                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                                <span
                                  role="button"
                                  tabIndex={-1}
                                  onMouseDown={(e) => {
                                    e.stopPropagation();
                                    closeDbTab(t.id);
                                    if (dbTabs.length <= 1) setDbMoreOpen(false);
                                  }}
                                  className="text-muted-foreground hover:text-destructive"
                                  title="关闭"
                                >
                                  ✕
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* 标签右键菜单：刷新 / 关闭当前 / 关闭其他 */}
              {tabMenu && (
                <ContextMenu
                  x={tabMenu.x}
                  y={tabMenu.y}
                  onClose={() => setTabMenu(null)}
                  items={
                    [
                      { label: '刷新', onClick: () => refreshDbTab(tabMenu.tabId) },
                      { separator: true, label: '' },
                      { label: '关闭当前', onClick: () => closeDbTab(tabMenu.tabId) },
                      { label: '关闭其他', onClick: () => closeOtherDbTabs(tabMenu.tabId) },
                    ] as MenuItem[]
                  }
                />
              )}

              {showDb ? (
                <DbDataTabs />
              ) : (
                <Empty
                  text={
                    wbSidebar === 'nacos'
                      ? '在左侧「注册与配置」导航器单击 Nacos 连接或命名空间，在标签页中打开配置中心（命名空间切换 / 配置查看·编辑·发布·删除）。'
                      : '在左侧连接导航器双击连接展开库与表：双击表打开数据网格，双击视图/函数/序列打开定义，双击 Redis 打开键浏览器。'
                  }
                />
              )}
            </>
          </div>
        </div>

        {/* SFTP 面板（主机已连即常驻挂载，切到数据库模式仅隐藏，目录状态不丢） */}
        {isSshHost && (
          <>
            {/* SFTP 分隔线：7px 命中区 + 1px 实线（与左侧树分隔线同一视觉范式） */}
            <div
              onMouseDown={startSftpDrag}
              onDoubleClick={() => setSftpWidth(300)}
              className="group relative -ml-[3px] w-[7px] shrink-0 cursor-col-resize bg-transparent"
              style={{ display: sftpOpen && wbSidebar === 'ssh' ? 'block' : 'none' }}
              title="左右拖拽调整 SFTP 面板宽度（双击恢复默认）"
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line2 transition-colors group-hover:bg-primary" />
              <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-primary opacity-0 transition-opacity group-hover:opacity-70" />
            </div>
            <div className="flex shrink-0 flex-col" style={{ display: sftpOpen && wbSidebar === 'ssh' ? 'flex' : 'none', width: sftpWidth }}>
              <SftpTree connectionId={activeTermConn} hostLabel={termConn?.name} />
            </div>
          </>
        )}
        {aiSidebarOpen && (
          <>
            {/* AI 侧栏分隔线：同 SFTP 范式，7px 命中区 + 1px 实线，双击回默认 320 */}
            <div
              onMouseDown={startAiDrag}
              onDoubleClick={() => setAiWidth(320)}
              className="group relative -ml-[3px] w-[7px] shrink-0 cursor-col-resize bg-transparent"
              title="左右拖拽调整 AI 助手宽度（双击恢复默认）"
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line2 transition-colors group-hover:bg-secondary" />
              <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-secondary opacity-0 transition-opacity group-hover:opacity-70" />
            </div>
            <AiSidebar width={aiWidth} />
          </>
        )}
      </div>

      {/* 底部状态栏：连接上下文跟随激活标签（v4 核心原则） */}
      <WorkbenchStatusBar />
    </div>
  );
}

/** 终端底部「快捷命令」栏 */
function QuickCommandBar({ connectionId }: { connectionId: string | null }) {
  const [cmd, setCmd] = useState('');
  const SNIPPETS = ['df -h', 'free -m', 'systemctl status', 'ps aux | head -20', 'uptime', 'uname -a'];
  const send = (text: string) => {
    const v = (text ?? '').trim();
    if (!v || !connectionId) return;
    try {
      api.terminalWrite(connectionId, v + '\n');
    } catch {
      /* ignore */
    }
    setCmd('');
  };
  return (
    <div className="statusbar" style={{ height: 32 }}>
      <span className="shrink-0 text-[11px] text-muted-foreground">快捷命令</span>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) setCmd(e.target.value);
        }}
        className="ipt text-[length:calc(var(--pref-fs)*0.786)] text-foreground"
      >
        <option value="">片段…</option>
        {SNIPPETS.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <input
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') send(cmd);
        }}
        placeholder="输入命令发送到当前终端，Enter 发送"
        className="ipt min-w-0 flex-1 text-[length:calc(var(--pref-fs)*0.786)] text-foreground placeholder:text-muted-foreground"
      />
      <button onClick={() => send(cmd)} className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90">
        发送
      </button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full w-full items-center justify-center p-6 text-center text-[length:calc(var(--pref-fs)*0.857)] text-muted-foreground">{text}</div>;
}

/** 最左窄图标导航按钮（切换 数据库树 / SSH 主机树 / 注册与配置树） */
function SideIcon({
  active,
  label,
  onClick,
  icon,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative flex h-[38px] w-[38px] items-center justify-center rounded-lg transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
    >
      {/* 激活指示条：贴 rail 左边缘（容器 54px - 按钮 38px = 每边 8px，故 left:-8px 正好在边缘） */}
      {active && <span className="absolute left-[-8px] top-[9px] h-5 w-[3px] rounded-full bg-primary" />}
      <IconBox className="h-[18px] w-[18px]">{icon}</IconBox>
    </button>
  );
}

/** 工具栏按钮与工具栏专属图标已迁至 components/shell/WorkbenchToolbar.tsx（内嵌标题栏） */

function SqlGlyph() {
  return <Icon name="menu" className="h-4 w-4" strokeWidth={1.8} />;
}
function UsersGlyph() {
  return <Icon name="user" className="h-4 w-4" strokeWidth={1.7} />;
}
function TableGlyph() {
  return <Icon name="table-3" className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={1.7} />;
}
// 类型图标标识色（品牌/语义标识，集中声明，避免散落硬编码色值；品牌色不随主题变化）
const GLYPH_REDIS = '#e0483d';
const GLYPH_VIEW = '#3b82f6';
function RedisGlyph() {
  return <Icon name="database-5" className="h-3.5 w-3.5 shrink-0" style={{ color: GLYPH_REDIS }} strokeWidth={1.7} />;
}
function ViewGlyph() {
  // 视图/物化视图：眼睛（与树节点同形同色）
  return <Icon name="eye" className="h-3.5 w-3.5 shrink-0" style={{ color: GLYPH_VIEW }} strokeWidth={1.7} />;
}
function SequenceGlyph() {
  // 序列：递增箭头列表（与树节点同形同色）
  return <Icon name="list-2" className="h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.7} />;
}
function FunctionGlyph() {
  // 函数：斜体 f（与树节点同形同色）
  return <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[length:calc(var(--pref-fs)*0.786)] font-semibold italic leading-none text-ai2">f</span>;
}
function ProcedureGlyph() {
  // 存储过程：齿轮 + 内部闪电（与树节点同形同色）
  return (
    <Icon name="star-3" className="h-3.5 w-3.5 shrink-0 text-foreground" strokeWidth={1.7} />
  );
}

/** 数据库标签页图标：按标签类型/对象类型匹配树节点语义（表/视图/序列/函数/存储过程各自专属，不再共用 SQL 图标） */
function dbTabGlyph(t: DbTab) {
  switch (t.type) {
    case 'table':
      return <TableGlyph />;
    case 'objlist':
      return t.kind === 'table' ? <TableGlyph /> : <ViewGlyph />;
    case 'def':
      return t.kind === 'function' ? <FunctionGlyph /> : t.kind === 'procedure' ? <ProcedureGlyph /> : <ViewGlyph />;
    case 'sequence':
      return <SequenceGlyph />;
    case 'redis':
      return <RedisGlyph />;
    case 'users':
      return <UsersGlyph />;
    case 'nacos':
      return <KindIcon kind="nacos" className="h-3.5 w-3.5 shrink-0" />;
    default:
      return <SqlGlyph />;
  }
}

function TerminalGlyph() {
  return (
    <Icon name="terminal" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
  );
}

/** 文件编辑标签图标（文档 + 折角） */
function FileGlyph() {
  return (
    <Icon name="file" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
  );
}

/** 终端标签顶部工具条：主机名 + 重连（刷新）+ 清屏 */
type ConnStatusBadge = { label: string; dot: string; text: string };
const STATUS_BADGE: Record<ConnectionStatus, ConnStatusBadge> = {
  connected: { label: '已连接', dot: 'bg-success', text: 'text-success' },
  connecting: { label: '连接中', dot: 'bg-warning', text: 'text-warning' },
  error: { label: '错误', dot: 'bg-destructive', text: 'text-destructive' },
  disconnected: { label: '未连接', dot: 'bg-muted-foreground/50', text: 'text-muted-foreground' },
};

/**
 * SSH 终端工具条（FinalShell 风格单行工具条）。
 * 左：连接名 + 状态徽标 + 信息按钮；右：字号 A-/A+、跟随终端开关、清屏、重连、SFTP 面板、新标签、关闭。
 */
function TerminalToolbar({
  tab,
  hostLabel,
  connection,
  status,
  follow,
  onToggleFollow,
  onFontDelta,
  sftpOpen,
  onToggleSftp,
  onReconnect,
  onNewTab,
  onCloseTab,
}: {
  tab: TermTab;
  hostLabel?: string;
  connection?: ConnectionSummary;
  status?: ConnectionStatus;
  follow: boolean;
  onToggleFollow: () => void;
  onFontDelta: (d: number) => void;
  sftpOpen: boolean;
  onToggleSftp: () => void;
  onReconnect: () => void;
  onNewTab: () => void;
  onCloseTab: () => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const clear = () => window.dispatchEvent(new CustomEvent('dataroost:term-clear', { detail: tab.connId }));
  const badge = STATUS_BADGE[status ?? 'disconnected'];

  const ToolBtn = ({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      title={title}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] transition-colors ${
        active ? 'bg-secondary text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );

  return (
    <div className="relative flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-2.5">
      <Icon name="terminal" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-[180px] truncate text-[13px] font-medium text-foreground" title={hostLabel ?? tab.connId}>
        {hostLabel ?? tab.connId}
      </span>
      <span className={`inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-[1px] text-[10px] ${badge.text}`} title={`连接状态：${badge.label}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${badge.dot}`} />
        {badge.label}
      </span>
      <button
        title="连接信息"
        onClick={() => setInfoOpen((v) => !v)}
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-secondary ${infoOpen ? 'bg-secondary text-primary' : 'text-muted-foreground'}`}
      >
        <Icon name="info" className="h-3.5 w-3.5" />
      </button>

      <div className="ml-auto flex items-center gap-0.5">
        <ToolBtn title="缩小字号" onClick={() => onFontDelta(-1)}>
          <span className="text-[11px]">A−</span>
        </ToolBtn>
        <ToolBtn title="放大字号" onClick={() => onFontDelta(1)}>
          <span className="text-[13px] font-semibold">A+</span>
        </ToolBtn>
        <ToolBtn title="字号跟随全局设置（关闭则本标签独立）" active={follow} onClick={onToggleFollow}>
          跟随
        </ToolBtn>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <ToolBtn title="清屏（Ctrl+L）" onClick={clear}>
          清屏
        </ToolBtn>
        <ToolBtn title="断开并重新连接" onClick={onReconnect}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          重连
        </ToolBtn>
        <ToolBtn title="切换 SFTP 文件面板" active={sftpOpen} onClick={onToggleSftp}>
          <Icon name="folder" className="h-3.5 w-3.5" />
          SFTP
        </ToolBtn>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <ToolBtn title="新终端标签（同一主机可开多个）" onClick={onNewTab}>
          <Icon name="plus" className="h-3.5 w-3.5" />
        </ToolBtn>
        <ToolBtn title="关闭此终端标签" onClick={onCloseTab}>
          <Icon name="close" className="h-3.5 w-3.5" />
        </ToolBtn>
      </div>

      {infoOpen && connection && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setInfoOpen(false)} />
          <div className="absolute left-2 top-full z-50 min-w-[220px] rounded-md border border-border bg-popover px-3 py-2 text-[12px] shadow-lg">
            <Row k="主机" v={`${connection.host}:${connection.port}`} />
            <Row k="用户" v={connection.username ?? '—'} />
            <Row k="类型" v={connection.kind} />
            {connection.remark && <Row k="备注" v={connection.remark} />}
            <Row k="状态" v={badge.label} cls={badge.text} />
          </div>
        </>
      )}
    </div>
  );
}

function Row({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className={`font-mono ${cls ?? 'text-foreground'}`}>{v}</span>
    </div>
  );
}
