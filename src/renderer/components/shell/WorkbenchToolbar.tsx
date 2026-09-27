import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { api } from '@renderer/api';

/**
 * 工作台工具栏 —— 渲染在标题栏（TitleBar）中间，不再单独占一栏。
 *
 * 随最左窄图标侧栏模式切换：
 * - 数据库模式：新建连接 / 新建查询 / 用户 / 传输 / 结构同步 / 导入 / 导出 / 刷新 / 连接-断开；
 * - SSH 模式：新建主机 / 打开终端 / 刷新 / 连接-断开。
 *
 * 状态全部来自 store（connections / wbSidebar / treeQueryCtx），与工作台解耦；
 * AI 助手开关与窗口控制按钮由 TitleBar 自管理，这里不重复。
 *
 * @since 0.4.0
 */
export function WorkbenchToolbar() {
  const connections = useConnections((s) => s.connections);
  const selectedId = useConnections((s) => s.selectedId);
  const setStatus = useConnections((s) => s.setStatus);

  const wbSidebar = useAppStore((s) => s.wbSidebar);
  const openOverlay = useAppStore((s) => s.openOverlay);
  const setInfo = useAppStore((s) => s.setInfo);
  const info = useAppStore((s) => s.info);
  const treeQueryCtx = useAppStore((s) => s.treeQueryCtx);
  const openDbTab = useAppStore((s) => s.openDbTab);

  const selected = connections.find((c) => c.id === selectedId) ?? null;

  const newConnection = () =>
    openOverlay({ kind: 'connection-edit', preset: { kind: 'mysql', kindScope: ['mysql', 'postgres', 'oracle', 'redis'] } });

  const newQuery = () => {
    // 目标连接优先级：树中最近选中节点所属连接 > 当前选中的连接（选中 ai_vans 等库/模式/对象节点后新建查询直接落到该库）
    const ctxConn = treeQueryCtx ? connections.find((c) => c.id === treeQueryCtx.connId) : null;
    const conn =
      (ctxConn && (ctxConn.kind === 'mysql' || ctxConn.kind === 'postgres' || ctxConn.kind === 'oracle') ? ctxConn : null) ??
      (selected && (selected.kind === 'mysql' || selected.kind === 'postgres' || selected.kind === 'oracle') ? selected : null);
    if (!conn || conn.status !== 'connected') {
      setInfo('请先在左侧连接导航器选中一个已连接的数据库（MySQL / PostgreSQL / Oracle），再新建查询。');
      return;
    }
    // 树上下文与该连接匹配时携带初始库/模式：PG=库名(pgDb)；MySQL=库名(db)；Oracle=模式名(db)
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

  const refreshTree = () => window.dispatchEvent(new Event('dbnest:refresh-tree'));
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

  return (
    <>
      {wbSidebar === 'db' ? (
        <>
          <ToolBtn icon={<PlusIcon />} label="新建连接" onClick={newConnection} />
          <ToolBtn icon={<SqlGlyph />} label="新建查询" onClick={newQuery} />
          <ToolBtn icon={<UsersGlyph />} label="用户" onClick={openUsers} />
          <Divider />
          <ToolBtn icon={<TransferGlyph />} label="传输" onClick={openTransfer} />
          <ToolBtn icon={<DiffGlyph />} label="结构同步" onClick={openDiff} />
          <ToolBtn icon={<ImportGlyph />} label="导入" onClick={() => setInfo('导入向导（CSV / SQL）后续版本提供。')} />
          <ToolBtn icon={<ExportGlyph />} label="导出" onClick={() => setInfo('在查询结果区使用「导出 CSV」即可导出当前结果集。')} />
          <Divider />
          <ToolBtn icon={<RefreshIcon />} label="刷新" onClick={refreshTree} />
          {selected && (
            <ToolBtn
              icon={selected.status === 'connected' ? <DisconnectGlyph /> : <ConnectGlyph />}
              label={selected.status === 'connected' ? '断开' : '连接'}
              onClick={() => void toggleSelectedConn()}
            />
          )}
        </>
      ) : (
        <>
          <ToolBtn
            icon={<PlusIcon />}
            label="新建主机"
            onClick={() => openOverlay({ kind: 'connection-edit', preset: { kind: 'ssh', kindScope: ['ssh'] } })}
          />
          <ToolBtn icon={<TerminalIcon />} label="打开终端" onClick={openTerminalForSelected} />
          <Divider />
          <ToolBtn icon={<RefreshIcon />} label="刷新" onClick={refreshTree} />
          {selected && (
            <ToolBtn
              icon={selected.status === 'connected' ? <DisconnectGlyph /> : <ConnectGlyph />}
              label={selected.status === 'connected' ? '断开' : '连接'}
              onClick={() => void toggleSelectedConn()}
            />
          )}
        </>
      )}

      {/* 轻提示弹窗（原 WorkbenchScreen 的 info 弹窗，随工具栏迁入标题栏） */}
      {info && <InfoModal />}
    </>
  );
}

/** 轻提示弹窗：点遮罩或确定关闭 */
function InfoModal() {
  const info = useAppStore((s) => s.info);
  const setInfo = useAppStore((s) => s.setInfo);
  return (
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
    </div>
  );
}

/** 工具栏按钮（图标 + 文字，Navicat 风格） */
function ToolBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} className="flex h-7 items-center gap-1.5 rounded px-2 text-[12px] transition-colors hover:bg-panel3">
      <span className="text-accent">{icon}</span>
      <span className="text-dim">{label}</span>
    </button>
  );
}
function Divider() {
  return <div className="mx-1 h-5 w-px bg-line" />;
}

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
function TerminalIcon() {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 10 2 2-2 2M13 14h4" /></svg>;
}
