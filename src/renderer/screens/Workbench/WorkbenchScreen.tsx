import { useRef, useState } from 'react';
import { DbTree } from '@renderer/components/workbench/DbTree';
import { ConnectionTree } from '@renderer/components/workbench/ConnectionTree';
import { DbDataTabs } from '@renderer/components/workbench/DbDataTabs';
import { TerminalPane } from '@renderer/components/workbench/TerminalPane';
import { SftpTree } from '@renderer/components/workbench/SftpTree';
import { AiSidebar } from '@renderer/components/workbench/AiSidebar';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { api } from '@renderer/api';

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
  /** SSH 终端重连计数：bump 对应键即可让 TerminalPane 重挂载并重新连接 */
  const [termRefresh, setTermRefresh] = useState<Record<string, number>>({});

  const showDb = !!activeDbTab && dbTabs.some((t) => t.id === activeDbTab);
  const activeTermConn = termTabs.find((t) => t.connId === activeTerm)?.connId ?? termTabs[0]?.connId ?? null;
  const termConn = connections.find((c) => c.id === activeTermConn && (c.kind === 'ssh' || c.kind === 'bastion')) ?? null;
  const isSshHost = !!termConn && termConn.status === 'connected';
  /** 最左窄图标侧边栏的当前面板：数据库树 / SSH 主机树（互不串门；工具栏随模式切换） */
  const wbSidebar = useAppStore((s) => s.wbSidebar);
  const setWbSidebar = useAppStore((s) => s.setWbSidebar);
  const [sftpWidth, setSftpWidth] = useState(300);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

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
    <div className="workbench flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* 主体：窄图标侧栏 + 导航器 + 标签区（工具栏已内嵌顶部标题栏，由 App.tsx 挂载） */}
      <div className="flex min-h-0 flex-1">
        {/* —— 最左：窄图标导航（数据库 / SSH 主机），点击切换对应面板 —— */}
        <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel2 py-2">
          <SideIcon
            active={wbSidebar === 'db'}
            label="数据库"
            onClick={() => setWbSidebar('db')}
            icon={
              <svg fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
                <ellipse cx="12" cy="5" rx="8" ry="3" />
                <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
                <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
              </svg>
            }
          />
          <SideIcon
            active={wbSidebar === 'ssh'}
            label="SSH / 主机"
            onClick={() => setWbSidebar('ssh')}
            icon={
              <svg fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="m7 10 2 2-2 2M13 14h4" />
              </svg>
            }
          />
        </div>
        {/* 两棵树常驻挂载，切换仅改可见性：展开状态 / 已加载数据不丢 */}
        <div className="flex min-h-0 shrink-0" style={{ display: wbSidebar === 'ssh' ? 'flex' : 'none' }}>
          <ConnectionTree />
        </div>
        <div className="flex min-h-0 shrink-0" style={{ display: wbSidebar === 'db' ? 'flex' : 'none' }}>
          <DbTree />
        </div>

        {/* —— 中间区：SSH 面板与数据库面板均常驻挂载，切换侧栏仅改可见性（终端会话不中断）—— */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* SSH 模式：主机标签栏 + 终端 */}
          <div className="flex min-h-0 flex-1 flex-col" style={{ display: wbSidebar === 'ssh' ? 'flex' : 'none' }}>
            {termTabs.length === 0 ? (
              <Empty text="请在左侧主机树双击一台 SSH / 堡垒机主机，将自动打开真实终端标签（支持多主机同时开多个终端）。" />
            ) : (
              <>
                {/* 主机标签栏：与数据库模式一致的标签外观（主机名 + 关闭；支持多主机同时开多个终端） */}
                <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel2 text-[length:calc(var(--pref-fs)*0.857)]">
                  {termTabs.map((t) => {
                    const c = connections.find((x) => x.id === t.connId);
                    const isActive = activeTermConn === t.connId;
                    return (
                      <div
                        key={`term:${t.connId}`}
                        className={`flex items-center gap-1.5 border-r border-line px-3 ${isActive ? 'tab-active' : 'text-dim hover:text-fg'}`}
                      >
                        <button onClick={() => setActiveTerm(t.connId)} className="flex items-center gap-1.5">
                          <TerminalGlyph />
                          <span className="max-w-[160px] truncate">{c?.name ?? t.connId}</span>
                          <span className="text-[9px] text-dim2">终端</span>
                        </button>
                        <button onClick={() => closeTerminal(t.connId)} className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2 hover:text-prod" title="关闭终端">
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
                {/* 所有已开终端实例保持挂载，仅显示激活的那个（保证 xterm 状态不丢）；切换 = 点击上方标签或双击树中主机 */}
                {termTabs.map((t) => {
                  const c = connections.find((x) => x.id === t.connId);
                  return (
                    <div
                      key={`pane:${t.connId}`}
                      className="flex min-h-0 flex-1 flex-col"
                      style={{ display: activeTermConn === t.connId ? 'flex' : 'none' }}
                    >
                      <TerminalToolbar
                        connectionId={t.connId}
                        hostLabel={c?.name}
                        onReconnect={() => setTermRefresh((m) => ({ ...m, [t.connId]: (m[t.connId] ?? 0) + 1 }))}
                      />
                      <div className="flex min-h-0 flex-1">
                        <TerminalPane
                          key={`tp:${t.connId}:${termRefresh[t.connId] ?? 0}`}
                          connectionId={t.connId}
                          hostLabel={c?.name}
                          active={wbSidebar === 'ssh' && activeTermConn === t.connId}
                        />
                      </div>
                    </div>
                  );
                })}
                {isSshHost && <QuickCommandBar connectionId={activeTermConn} />}
              </>
            )}
          </div>

          {/* 数据库模式：标签栏 + 数据区 */}
          <div className="flex min-h-0 flex-1 flex-col" style={{ display: wbSidebar === 'db' ? 'flex' : 'none' }}>
            <>
              <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel2 text-[length:calc(var(--pref-fs)*0.857)]">
                {dbTabs.map((t) => {
                  const isActive = activeDbTab === t.id;
                  const glyph =
                    t.type === 'table' || t.type === 'objlist'
                      ? <TableGlyph />
                      : t.type === 'redis'
                      ? <RedisGlyph />
                      : t.type === 'users'
                      ? <UsersGlyph />
                      : <SqlGlyph />;
                  return (
                    <div
                      key={t.id}
                      className={`flex items-center gap-1.5 border-r border-line px-3 ${isActive ? 'tab-active' : 'text-dim hover:text-fg'}`}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setActiveDbTab(t.id);
                        setTabMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
                      }}
                    >
                      <button onClick={() => setActiveDbTab(t.id)} className="flex items-center gap-1.5">
                        {glyph}
                        <span className="max-w-[150px] truncate">{t.title}</span>
                      </button>
                      <button onClick={() => closeDbTab(t.id)} className="text-[length:calc(var(--pref-fs)*0.714)] text-dim2 hover:text-prod" title="关闭">
                        ✕
                      </button>
                    </div>
                  );
                })}
                {dbTabs.length === 0 && (
                  <div className="flex items-center px-3 text-[length:calc(var(--pref-fs)*0.786)] text-dim2">
                    在左侧连接导航器双击连接展开库与表；双击表打开数据，双击 Redis 打开键浏览器。
                  </div>
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
                <Empty text="在左侧连接导航器双击连接展开库与表：双击表打开数据网格，双击视图/函数/序列打开定义，双击 Redis 打开键浏览器。" />
              )}
            </>
          </div>
        </div>

        {/* SFTP 面板（主机已连即常驻挂载，切到数据库模式仅隐藏，目录状态不丢） */}
        {isSshHost && (
          <>
            <div
              onMouseDown={startSftpDrag}
              className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent/50"
              style={{ display: wbSidebar === 'ssh' ? 'block' : 'none' }}
              title="左右拖拽调整 SFTP 面板宽度"
            />
            <div className="flex shrink-0 flex-col" style={{ display: wbSidebar === 'ssh' ? 'flex' : 'none', width: sftpWidth }}>
              <SftpTree connectionId={activeTermConn} hostLabel={termConn?.name} />
            </div>
          </>
        )}
        {aiSidebarOpen && <AiSidebar />}
      </div>
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
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.786)]">
      <span className="shrink-0 text-dim2">快捷命令</span>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) setCmd(e.target.value);
        }}
        className="h-6 rounded border border-line bg-bg px-1 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none"
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
        className="h-6 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2"
      />
      <button onClick={() => send(cmd)} className="h-6 shrink-0 rounded bg-accent px-2.5 text-white hover:bg-accent2">
        发送
      </button>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full w-full items-center justify-center p-6 text-center text-[length:calc(var(--pref-fs)*0.857)] text-dim2">{text}</div>;
}

/** 最左窄图标导航按钮（切换 数据库树 / SSH 主机树） */
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
      className={`relative flex h-8 w-8 items-center justify-center rounded transition-colors ${
        active ? 'bg-panel3 text-accent' : 'text-dim hover:bg-panel3 hover:text-fg'
      }`}
      style={active ? { boxShadow: 'inset 2px 0 0 #2f7dd1' } : undefined}
    >
      <svg className="h-[18px] w-[18px]">{icon}</svg>
    </button>
  );
}

/** 工具栏按钮与工具栏专属图标已迁至 components/shell/WorkbenchToolbar.tsx（内嵌标题栏） */

function SqlGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10" /></svg>;
}
function UsersGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /><path d="M16 6.2a3 3 0 010 5.6M16.5 19c0-2.4 1.4-4.1 3.5-4.6" /></svg>;
}
function TableGlyph() {
  return <svg className="h-3.5 w-3.5 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14h18M9 4v16" /></svg>;
}
function RedisGlyph() {
  return <svg className="h-3.5 w-3.5 shrink-0 text-[#e0483d]" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /></svg>;
}

function TerminalGlyph() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-dim" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 10 2 2-2 2M13 14h4" />
    </svg>
  );
}

/** 终端标签顶部工具条：主机名 + 重连（刷新）+ 清屏 */
function TerminalToolbar({ connectionId, hostLabel, onReconnect }: { connectionId: string; hostLabel?: string; onReconnect: () => void }) {
  const clear = () => window.dispatchEvent(new CustomEvent('dbnest:term-clear', { detail: connectionId }));
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-[length:calc(var(--pref-fs)*0.786)]">
      <span className="font-medium text-fg">{hostLabel ?? connectionId}</span>
      <span className="text-[9px] text-dim2">SSH 终端</span>
      <div className="flex-1" />
      <button onClick={onReconnect} className="rounded px-2 py-0.5 text-dim hover:bg-panel3 hover:text-fg" title="断开并重新连接（刷新）">
        重连
      </button>
      <button onClick={clear} className="rounded px-2 py-0.5 text-dim hover:bg-panel3 hover:text-fg" title="清屏（Ctrl+L）">
        清屏
      </button>
    </div>
  );
}
