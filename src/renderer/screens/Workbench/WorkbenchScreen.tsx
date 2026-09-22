import { useRef, useState } from 'react';
import { ConnectionTree } from '@renderer/components/workbench/ConnectionTree';
import { DbTree } from '@renderer/components/workbench/DbTree';
import { DbDataTabs } from '@renderer/components/workbench/DbDataTabs';
import { TerminalPane } from '@renderer/components/workbench/TerminalPane';
import { SftpTree } from '@renderer/components/workbench/SftpTree';
import { AiSidebar } from '@renderer/components/workbench/AiSidebar';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { StatusDot } from '@renderer/components/common/States';
import { api } from '@renderer/api';

/**
 * ① 主工作台屏幕：SSH 终端（多会话标签）+ SFTP 树 + 数据库树 + AI 助手。
 *
 * 布局规则（对齐 XTerminal / DBeaver 桌面客户端信息架构）：
 * - 左侧为**窄图标导航**（36px）：SSH（连接树）/ 数据库（库表字段树）两个面板切换；
 * - 中间区顶部标签栏：**每个已连 SSH 主机一个终端标签**（可切换/关闭，XTerminal 风格）+ 数据库数据标签；
 * - 终端标签激活时中间区展示真实 xterm 终端 + 底部「快捷命令」栏；SFTP 面板在 SSH 主机连上时可开启；
 * - 数据库标签激活时中间区展示表数据网格 / SQL 结果；
 * - AI 侧栏由标题栏按钮控制，默认关闭。
 *
 * @since 0.1.0
 */
export function WorkbenchScreen() {
  const connections = useConnections((s) => s.connections);
  const setStatus = useConnections((s) => s.setStatus);
  const aiSidebarOpen = useAppStore((s) => s.aiSidebarOpen);
  const wbSidebar = useAppStore((s) => s.wbSidebar);
  const setWbSidebar = useAppStore((s) => s.setWbSidebar);
  const dbTabs = useAppStore((s) => s.dbTabs);
  const activeDbTab = useAppStore((s) => s.activeDbTab);
  const setActiveDbTab = useAppStore((s) => s.setActiveDbTab);
  const closeDbTab = useAppStore((s) => s.closeDbTab);
  const openDbTab = useAppStore((s) => s.openDbTab);
  const termTabs = useAppStore((s) => s.termTabs);
  const activeTerm = useAppStore((s) => s.activeTerm);
  const setActiveTerm = useAppStore((s) => s.setActiveTerm);
  const closeTerminal = useAppStore((s) => s.closeTerminal);
  const openTerminal = useAppStore((s) => s.openTerminal);
  const [sftpOpen, setSftpOpen] = useState(true);
  /** SFTP 面板宽度（px），左侧边缘可左右拖拽调整 */
  const [sftpWidth, setSftpWidth] = useState(300);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  /** 开始拖拽 SFTP 分隔条 */
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

  const selectedId = useConnections((s) => s.selectedId);
  const selected = connections.find((c) => c.id === selectedId);

  /** 数据库标签是否激活（决定中间区显示终端还是数据库内容） */
  const showDb = !!activeDbTab && dbTabs.some((t) => t.id === activeDbTab);  /** 当前激活终端对应的连接（须存在于 termTabs） */
  const activeTermConn = termTabs.find((t) => t.connId === activeTerm)?.connId ?? termTabs[0]?.connId ?? null;
  /** 激活终端对应的连接对象 */
  const termConn = connections.find((c) => c.id === activeTermConn && (c.kind === 'ssh' || c.kind === 'bastion')) ?? null;
  /** 活动终端主机是否已连上（决定 SFTP 面板 / 快捷命令栏是否可用） */
  const isSshHost = !!termConn && termConn.status === 'connected';

  const newQuery = () => {
    const conn = selected && (selected.kind === 'mysql' || selected.kind === 'postgres') ? selected : null;
    if (!conn || conn.status !== 'connected') return;
    openDbTab({ id: `q:${conn.id}:${Date.now()}`, connId: conn.id, type: 'query', title: '查询' });
  };

  /** 关闭终端标签：断开该主机并移除标签 */
  const onCloseTerminal = async (connId: string) => {
    closeTerminal(connId);
    const c = connections.find((x) => x.id === connId);
    if (c && c.status === 'connected') {
      await api.disconnect(connId).catch(() => undefined);
      setStatus(connId, 'disconnected');
    }
  };

  /** 新建终端：打开当前选中/首个已连 SSH 主机的终端标签 */
  const onNewTerminal = () => {
    const target =
      selected && (selected.kind === 'ssh' || selected.kind === 'bastion') && selected.status === 'connected'
        ? selected
        : connections.find((c) => (c.kind === 'ssh' || c.kind === 'bastion') && c.status === 'connected');
    if (target) openTerminal(target.id);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* 顶部标签栏：按侧栏模式隔离——SSH 模式只显示终端标签，数据库模式只显示数据标签 */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel2 text-[12px]">
        {/* SSH 模式：终端会话标签（XTerminal 风格，可多开） */}
        {wbSidebar === 'ssh' &&
          termTabs.map((t) => {
            const c = connections.find((x) => x.id === t.connId);
            if (!c) return null;
            const isActive = activeTermConn === t.connId;
            return (
              <div
                key={`term:${t.connId}`}
                className={`flex items-center gap-1.5 border-r border-line px-3 ${isActive ? 'tab-active' : 'text-dim hover:text-fg'}`}
              >
                <button
                  onClick={() => setActiveTerm(t.connId)}
                  className="flex items-center gap-1.5"
                  title={`终端：${c.name}`}
                >
                  <StatusDot status={c.status} />
                  <span className="max-w-[140px] truncate">{c.name}</span>
                  <span className="text-[10px] text-dim2">{c.kind === 'bastion' ? '堡垒' : 'ssh'}</span>
                </button>
                <button
                  onClick={() => void onCloseTerminal(t.connId)}
                  className="ml-1 text-[10px] text-dim2 hover:text-prod"
                  title="关闭终端（断开连接）"
                >
                  ✕
                </button>
              </div>
            );
          })}

        {/* 数据库模式：数据标签 */}
        {wbSidebar === 'db' &&
          dbTabs.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-1.5 border-r border-line px-3 ${activeDbTab === t.id ? 'tab-active' : 'text-dim hover:text-fg'}`}
            >
              <button onClick={() => setActiveDbTab(t.id)} className="flex items-center gap-1.5">
                {t.type === 'table' ? <TableGlyph /> : <SqlGlyph />}
                <span className="max-w-[140px] truncate">{t.title}</span>
              </button>
              <button onClick={() => closeDbTab(t.id)} className="text-[10px] text-dim2 hover:text-prod" title="关闭">
                ✕
              </button>
            </div>
          ))}

        {/* 模式化操作按钮：SSH=新建终端/SFTP 开关；数据库=新建查询 */}
        <div className="ml-auto flex items-center gap-1 pr-2 text-dim2">
          {wbSidebar === 'ssh' ? (
            <>
              {termTabs.length === 0 && (
                <span className="px-2 text-[11px] text-dim2">连接一台 SSH / 堡垒机主机后，这里会自动出现终端标签</span>
              )}
              <ToolBtn title="新建终端（打开已连主机的会话）" onClick={onNewTerminal}>
                <span className="flex items-center gap-1.5">
                  <PlusGlyph />
                  <span>终端</span>
                </span>
              </ToolBtn>
              {isSshHost && (
                <ToolBtn title={sftpOpen ? '隐藏 SFTP' : '显示 SFTP'} onClick={() => setSftpOpen((v) => !v)} active={sftpOpen}>
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  <span>SFTP</span>
                </ToolBtn>
              )}
            </>
          ) : (
            <>
              {dbTabs.length === 0 && (
                <span className="px-2 text-[11px] text-dim2">在左侧数据库树双击连接并展开表后，双击表即可打开数据标签</span>
              )}
              <ToolBtn
                title={selected && (selected.kind === 'mysql' || selected.kind === 'postgres') ? '新建查询标签页' : '先在左侧数据库树选中一个已连接的数据库'}
                onClick={newQuery}
              >
                <span className="flex items-center gap-1.5">
                  <SqlGlyph />
                  <span>新建查询</span>
                </span>
              </ToolBtn>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* —— 左侧：窄图标导航（SSH / 数据库）+ 对应面板 —— */}
        <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-line bg-[#0d0d0d] py-2">
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
        </div>
        {wbSidebar === 'ssh' ? <ConnectionTree /> : <DbTree />}

        {/* —— 中间区：按侧栏模式隔离——SSH 模式只渲染终端，数据库模式只渲染数据标签 —— */}
        <div className="flex min-w-0 flex-1 flex-col">
          {wbSidebar === 'ssh' ? (
            termTabs.length === 0 ? (
              <Empty text="请在左侧连接树选中并连上一台 SSH / 堡垒机主机，将自动打开真实终端标签（支持多主机同时开多个终端）。" />
            ) : (
              <>
                {/* 所有已开终端实例保持挂载，仅显示激活的那个（保证 xterm 状态不丢） */}
                {termTabs.map((t) => (
                  <div
                    key={`pane:${t.connId}`}
                    className="flex min-h-0 flex-1 flex-col"
                    style={{ display: activeTermConn === t.connId ? 'flex' : 'none' }}
                  >
                    <TerminalPane connectionId={t.connId} hostLabel={termConn?.name} active={activeTermConn === t.connId} />
                  </div>
                ))}
                {isSshHost && <QuickCommandBar connectionId={activeTermConn} />}
              </>
            )
          ) : showDb ? (
            <DbDataTabs />
          ) : (
            <Empty text="在左侧数据库树双击连接展开库与表，双击表即可在此打开数据网格。" />
          )}
        </div>

        {/* SFTP：仅 SSH 模式 + 主机已连时渲染；左缘分隔条可左右拖拽调整宽度 */}
        {wbSidebar === 'ssh' && isSshHost && sftpOpen && (
          <>
            <div
              onMouseDown={startSftpDrag}
              className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent/50"
              title="左右拖拽调整 SFTP 面板宽度"
            />
            <div className="flex shrink-0 flex-col" style={{ width: sftpWidth }}>
              <SftpTree connectionId={activeTermConn} hostLabel={termConn?.name} />
            </div>
          </>
        )}
        {/* AI 侧栏：由标题栏按钮控制，默认关闭 */}
        {aiSidebarOpen && <AiSidebar />}
      </div>
    </div>
  );
}

/**
 * 终端底部「快捷命令」栏（XTerminal 命令片段风格，基础版）。
 * 选择/输入一段命令，回车或点发送即写入当前激活终端。
 */
function QuickCommandBar({ connectionId }: { connectionId: string | null }) {
  const [cmd, setCmd] = useState('');
  const SNIPPETS = [
    'df -h',
    'free -m',
    'top -b -n1 | head -20',
    'systemctl status',
    'ps aux | head -20',
    'tail -n 50 /var/log/messages',
    'uptime',
    'uname -a',
  ];
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
    <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line bg-panel2 px-2 text-[11px]">
      <span className="shrink-0 text-dim2">快捷命令</span>
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) {
            setCmd(e.target.value);
          }
        }}
        className="h-6 rounded border border-line bg-bg px-1 text-[11px] text-fg outline-none"
        title="选择常用命令片段"
      >
        <option value="">片段…</option>
        {SNIPPETS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <input
        value={cmd}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') send(cmd);
        }}
        placeholder="输入命令发送到当前终端，Enter 发送"
        className="h-6 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-[11px] text-fg outline-none placeholder:text-dim2"
      />
      <button
        onClick={() => send(cmd)}
        className="h-6 shrink-0 rounded bg-accent px-2.5 text-white hover:bg-accent2"
        title="发送到终端"
      >
        发送
      </button>
    </div>
  );
}

/** 左侧窄图标导航按钮 */
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
        active ? 'bg-panel3 text-fg' : 'text-dim hover:bg-panel3 hover:text-fg'
      }`}
      style={active ? { boxShadow: 'inset 2px 0 0 #0e639c' } : undefined}
    >
      <svg className="h-[18px] w-[18px]">{icon}</svg>
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-[12px] text-dim2">{text}</div>
  );
}

function TableGlyph() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14h18M9 4v16" />
    </svg>
  );
}
function SqlGlyph() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-ai" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  );
}
function PlusGlyph() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ToolBtn({
  title,
  children,
  onClick,
  active,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 rounded px-2 ${active ? 'bg-panel3 text-fg' : 'text-dim'} hover:bg-panel3`}
      title={title}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
