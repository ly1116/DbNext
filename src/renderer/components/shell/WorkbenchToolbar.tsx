import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { api } from '@renderer/api';

/**
 * 工作台工具栏 —— 渲染在标题栏（TitleBar）中间，不再单独占一栏。
 *
 * 采用「模式感知菜单栏」：DB / SSH 两种模式下，各菜单的下拉内容随当前模式联动，
 * 仅保留系统真实具备的动作（不虚构功能）：
 *   - 运行 / 终端：新建查询 / 新建连接（DB）；打开终端 / 新建主机（SSH）
 *   - 工具：用户 / 结构同步 / 数据传输 / 导入 / 导出（DB）
 *   - 视图：切换 数据库 / SSH 侧栏、刷新连接树、AI 助手、连接-断开
 *   - AI：切换右侧 AI 助手侧栏
 *   - 帮助：关于、键盘快捷键
 *
 * 状态全部来自 store（connections / wbSidebar / treeQueryCtx），与工作台解耦；
 * 窗口控制按钮由 TitleBar 自管理。
 *
 * @since 0.4.0
 */
export function WorkbenchToolbar() {
  const connections = useConnections((s) => s.connections);
  const selectedId = useConnections((s) => s.selectedId);
  const setStatus = useConnections((s) => s.setStatus);

  const wbSidebar = useAppStore((s) => s.wbSidebar);
  const setWbSidebar = useAppStore((s) => s.setWbSidebar);
  const openOverlay = useAppStore((s) => s.openOverlay);
  const setInfo = useAppStore((s) => s.setInfo);
  const info = useAppStore((s) => s.info);
  const treeQueryCtx = useAppStore((s) => s.treeQueryCtx);
  const openDbTab = useAppStore((s) => s.openDbTab);
  const aiSidebarOpen = useAppStore((s) => s.aiSidebarOpen);
  const toggleAiSidebar = useAppStore((s) => s.toggleAiSidebar);
  const setAiPrefill = useAppStore((s) => s.setAiPrefill);

  const selected = connections.find((c) => c.id === selectedId) ?? null;

  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const newConnection = (kind: 'mysql' | 'ssh') =>
    openOverlay({
      kind: 'connection-edit',
      preset: kind === 'ssh' ? { kind: 'ssh', kindScope: ['ssh'] } : { kind: 'mysql', kindScope: ['mysql', 'postgres', 'oracle', 'redis'] },
    });

  const newQuery = () => {
    const ctxConn = treeQueryCtx ? connections.find((c) => c.id === treeQueryCtx.connId) : null;
    const conn =
      (ctxConn && (ctxConn.kind === 'mysql' || ctxConn.kind === 'postgres' || ctxConn.kind === 'oracle') ? ctxConn : null) ??
      (selected && (selected.kind === 'mysql' || selected.kind === 'postgres' || selected.kind === 'oracle') ? selected : null);
    if (!conn || conn.status !== 'connected') {
      setInfo('请先在左侧连接导航器选中一个已连接的数据库（MySQL / PostgreSQL / Oracle），再新建查询。');
      return;
    }
    const ctx = treeQueryCtx && treeQueryCtx.connId === conn.id ? treeQueryCtx : null;
    const pgDb = ctx && conn.kind === 'postgres' ? ctx.db : undefined;
    const mysqlDb = ctx && conn.kind === 'mysql' ? ctx.db : undefined;
    const oraSchema = ctx && conn.kind === 'oracle' ? ctx.schema : undefined;
    const dbLabel = pgDb ?? mysqlDb ?? oraSchema;
    openDbTab({
      id: `q:${conn.id}:${Date.now()}`,
      connId: conn.id,
      type: 'query',
      title: dbLabel ? `查询 ${conn.name} · ${dbLabel}` : `查询 ${conn.name}`,
      db: mysqlDb ?? oraSchema,
      pgDb,
    });
  };

  const openUsers = () => {
    const conn = selected && (selected.kind === 'mysql' || selected.kind === 'postgres' || selected.kind === 'oracle') ? selected : null;
    if (!conn || conn.status !== 'connected') {
      setInfo('请先选中一个已连接的数据库，再打开「用户」。');
      return;
    }
    openDbTab({ id: `users:${conn.id}`, connId: conn.id, type: 'users', title: '用户' });
  };

  const toggleSelectedConn = async () => {
    if (!selected) return;
    if (selected.status === 'connected') {
      await api.disconnect(selected.id).catch(() => undefined);
      setStatus(selected.id, 'disconnected');
    } else {
      setStatus(selected.id, 'connecting');
      try {
        await api.connect(selected.id);
      } catch {
        setStatus(selected.id, 'error');
      }
    }
  };

  const refreshTree = () => window.dispatchEvent(new Event('dataroost:refresh-tree'));
  const openTransfer = () => openOverlay({ kind: 'transfer', connectionId: selectedId ?? undefined });
  const openDiff = () => openOverlay({ kind: 'diff', connectionId: selectedId ?? undefined });
  const openTerminalForSelected = () => {
    const c = selected && (selected.kind === 'ssh' || selected.kind === 'bastion') ? selected : null;
    if (!c) {
      setInfo('请先在左侧导航器选中一个 SSH / 堡垒机主机，再打开命令列界面。');
      return;
    }
    useAppStore.getState().openTerminal(c.id);
  };

  const isDb = wbSidebar === 'db';
  const close = () => setOpen(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));

  return (
    <div ref={ref} className="flex items-center gap-0.5">
      {/* 运行 / 终端：模式相关 */}
      <div className="relative">
        <MenuBtn active={open === 'run'} onClick={() => toggle('run')}>
          <span>{isDb ? '运行' : '终端'}</span>
          <Caret />
        </MenuBtn>
        {open === 'run' && (
          <Dropdown>
            {isDb ? (
              <>
                <Item icon={<SqlGlyph />} label="新建查询" onClick={() => { newQuery(); close(); }} />
                <Item icon={<PlusIcon />} label="新建连接" onClick={() => { newConnection('mysql'); close(); }} />
              </>
            ) : (
              <>
                <Item icon={<TermGlyph />} label="打开终端" onClick={() => { openTerminalForSelected(); close(); }} />
                <Item icon={<PlusIcon />} label="新建主机" onClick={() => { newConnection('ssh'); close(); }} />
              </>
            )}
          </Dropdown>
        )}
      </div>

      {/* 工具 */}
      <div className="relative">
        <MenuBtn active={open === 'tools'} onClick={() => toggle('tools')}>
          <span>工具</span>
          <Caret />
        </MenuBtn>
        {open === 'tools' && (
          <Dropdown>
            {isDb ? (
              <>
                <Item icon={<UsersGlyph />} label="用户管理" onClick={() => { openUsers(); close(); }} />
                <Item icon={<DiffGlyph />} label="结构同步" onClick={() => { openDiff(); close(); }} />
                <Item icon={<TransferGlyph />} label="数据传输" onClick={() => { openTransfer(); close(); }} />
                <Item icon={<ImportGlyph />} label="导入" onClick={() => { setInfo('导入向导（CSV / SQL）后续版本提供。'); close(); }} />
                <Item icon={<ExportGlyph />} label="导出" onClick={() => { setInfo('在查询结果区使用「导出 CSV」即可导出当前结果集。'); close(); }} />
              </>
            ) : (
              <Item icon={<RefreshIcon />} label="刷新连接树" onClick={() => { refreshTree(); close(); }} />
            )}
          </Dropdown>
        )}
      </div>

      {/* 视图 */}
      <div className="relative">
        <MenuBtn active={open === 'view'} onClick={() => toggle('view')}>
          <span>视图</span>
          <Caret />
        </MenuBtn>
        {open === 'view' && (
          <Dropdown>
            <Item icon={<DbGlyph />} label="数据库侧栏" onClick={() => { setWbSidebar('db'); close(); }} />
            <Item icon={<SshGlyph />} label="SSH 侧栏" onClick={() => { setWbSidebar('ssh'); close(); }} />
            <Divider />
            <Item icon={<RefreshIcon />} label="刷新连接树" onClick={() => { refreshTree(); close(); }} />
            <Item icon={<SparkIcon />} label={aiSidebarOpen ? '关闭 AI 助手' : '打开 AI 助手'} onClick={() => { toggleAiSidebar(); close(); }} />
            {selected && (
              <Item
                icon={selected.status === 'connected' ? <DisconnectGlyph /> : <ConnectGlyph />}
                label={selected.status === 'connected' ? '断开连接' : '连接'}
                onClick={() => { void toggleSelectedConn(); close(); }}
              />
            )}
          </Dropdown>
        )}
      </div>

      {/* AI：下拉菜单（切换侧栏 / 生成 SQL / 解释 / 优化） */}
      <div className="relative">
        <MenuBtn active={open === 'ai'} onClick={() => toggle('ai')}>
          <span>AI</span>
          <Caret />
        </MenuBtn>
        {open === 'ai' && (
          <Dropdown>
            <Item
              label="AI 助手面板"
              kbd="Ctrl+Shift+A"
              onClick={() => { toggleAiSidebar(); close(); }}
            />
            {/* SQL 相关动作仅数据库模式提供（SSH 模式下没有 SQL 上下文） */}
            {isDb && (
              <>
                <Divider />
                <Item
                  label="生成 SQL…"
                  onClick={() => { useAppStore.getState().toggleAiSidebar(true); setAiPrefill('请帮我生成一条 SQL：'); close(); }}
                />
                <Item
                  label="解释这条 SQL"
                  onClick={() => { useAppStore.getState().toggleAiSidebar(true); setAiPrefill('请解释这条 SQL 的含义与执行逻辑：'); close(); }}
                />
                <Item
                  label="优化建议"
                  onClick={() => { useAppStore.getState().toggleAiSidebar(true); setAiPrefill('请对这条 SQL 给出优化建议：'); close(); }}
                />
              </>
            )}
          </Dropdown>
        )}
      </div>

      {/* 帮助 */}
      <div className="relative">
        <MenuBtn active={open === 'help'} onClick={() => toggle('help')}>
          <span>帮助</span>
          <Caret />
        </MenuBtn>
        {open === 'help' && (
          <Dropdown>
            <Item icon={<InfoGlyph />} label="关于 DataRoost" onClick={() => { openOverlay({ kind: 'about' }); close(); }} />
            <Item icon={<KeyGlyph />} label="键盘快捷键" onClick={() => { setInfo('常用快捷键：Ctrl/⌘+Enter 执行查询、Ctrl/⌘+Shift+Enter 脚本运行、Ctrl+` 打开终端。'); close(); }} />
          </Dropdown>
        )}
      </div>

      {info && <InfoModal />}
    </div>
  );
}

/* —— 菜单栏内部件 —— */
function MenuBtn({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex h-7 items-center gap-1 rounded px-2.5 text-[12px] text-fg transition-colors hover:bg-panel3 ${
        active ? 'bg-panel3' : ''
      }`}
    >
      {children}
    </button>
  );
}
function Dropdown({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute top-full left-0 z-50 mt-1 min-w-[184px] rounded-md border border-line bg-panel p-1 shadow-xl">
      {children}
    </div>
  );
}
function Item({ icon, label, kbd, onClick }: { icon?: React.ReactNode; label: string; kbd?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-panel3"
    >
      {icon && <span className="text-accent">{icon}</span>}
      <span>{label}</span>
      {kbd && <span className="ml-auto rounded bg-panel3 px-1.5 py-0.5 text-[10px] text-dim2">{kbd}</span>}
    </button>
  );
}
function Divider() {
  return <div className="my-1 h-px bg-line" />;
}
function Caret() {
  return <span className="text-[8px] text-dim2">▼</span>;
}

/** 轻提示弹窗：点遮罩或确定关闭；createPortal 挂 body——标题栏有 backdrop-blur 会把 fixed 定位基准变成标题栏自身，弹窗会被压在顶部 */
function InfoModal() {
  const info = useAppStore((s) => s.info);
  const setInfo = useAppStore((s) => s.setInfo);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={() => setInfo(null)}>
      <div
        className="max-w-[360px] rounded-lg border border-line bg-panel p-4 text-[12px] text-fg shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 leading-relaxed">{info}</div>
        <div className="flex justify-end">
          <button onClick={() => setInfo(null)} className="h-7 rounded bg-accent px-3 text-[11px] text-white hover:opacity-90">
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* —— 图标（内联，保持组件自包含）—— */
function PlusIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>;
}
function SqlGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10" /></svg>;
}
function UsersGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /><path d="M16 6.2a3 3 0 010 5.6M16.5 19c0-2.4 1.4-4.1 3.5-4.6" /></svg>;
}
function TransferGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><path d="M4 8h13M13 4l4 4-4 4" /><path d="M20 16H7M11 20l-4-4 4-4" /></svg>;
}
function DiffGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><path d="M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4" /></svg>;
}
function ImportGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><path d="M12 3v12M8 11l4 4 4-4M4 19h16" /></svg>;
}
function ExportGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4M4 19h16" /></svg>;
}
function RefreshIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>;
}
function ConnectGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}
function DisconnectGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
}
function TermGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 10 2 2-2 2M13 14h4" /></svg>;
}
function DbGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="7.5" ry="3" /><path d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13" /></svg>;
}
function SshGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 10 2 2-2 2M13 14h4" /></svg>;
}
function InfoGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
}
function KeyGlyph() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><circle cx="8" cy="8" r="4" /><path d="M11 11l8 8M16 16l2-2M19 19l2-2" /></svg>;
}
function SparkIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
    </svg>
  );
}
