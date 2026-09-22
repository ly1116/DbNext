import { api } from '@renderer/api';
import { useAppStore } from '@renderer/store/appStore';
import { useEffect, useState } from 'react';

/**
 * 标题栏（窗口顶部）—— 真实桌面应用行为：
 *
 * - 整条为系统拖拽区（-webkit-app-region: drag），可拖动窗口；交互元素单独 no-drag。
 * - macOS：hiddenInset 下系统原生红黄绿按钮显示在左上角，这里只留出等宽空间，绝不画假按钮。
 * - Windows/Linux（frame:false）：右侧提供真实的最小化 / 最大化-还原 / 关闭按钮，
 *   经 IPC 直接操作 BrowserWindow（win.minimize / maximize / close）。
 * - 双击标题栏切换最大化（Windows 惯例）。
 *
 * @since 0.1.0
 */
export function TitleBar() {
  const aiSidebarOpen = useAppStore((s) => s.aiSidebarOpen);
  const toggleAiSidebar = useAppStore((s) => s.toggleAiSidebar);
  const openOverlay = useAppStore((s) => s.openOverlay);
  const [version, setVersion] = useState('');
  const [platform, setPlatform] = useState<string>('browser');
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    api.getVersion().then(setVersion).catch(() => setVersion('0.1.0'));
    api.getPlatform().then(setPlatform).catch(() => setPlatform('browser'));
  }, []);

  // 最大化图标与窗口真实状态同步（双击标题栏 / 系统手势 / 按钮三条路径都准确）
  useEffect(() => {
    if (platform === 'browser') return;
    return api.onMaximized(setMaximized);
  }, [platform]);

  const isMac = platform === 'darwin';
  const isDesktop = platform !== 'browser';

  const control = (action: 'minimize' | 'maximize' | 'close') => () => {
    void api.windowControl(action);
  };

  return (
    <div
      className="flex h-9 shrink-0 select-none items-center gap-3 border-b border-line bg-[#0d0d0d]/95 pl-4 pr-0 backdrop-blur"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      onDoubleClick={isDesktop && !isMac ? control('maximize') : undefined}
    >
      {/* macOS：留出系统原生交通灯空间（真实系统控件在此渲染，应用不画假按钮） */}
      {isMac && <div className="w-[72px] shrink-0" />}

      {/* Windows/Linux：左侧应用标识 */}
      {!isMac && (
        <div className="flex shrink-0 items-center gap-2">
          <div className="h-4 w-4 rounded bg-gradient-to-br from-blue to-purple" />
          <span className="text-[12px] font-medium tracking-wide text-fg">DbNest</span>
        </div>
      )}

      {/* 弹性占位：把右侧控件推到最右 */}
      <div className="flex-1" />

      {/* 右侧：AI 助手开关 + 设置入口（仅保留可操作按钮，去掉装饰性状态图标） */}
      <div className="flex items-center gap-1 pr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* AI 助手开关：默认关闭，点按切换工作台右侧 AI 侧栏 */}
        <button
          onClick={() => toggleAiSidebar()}
          title={aiSidebarOpen ? '关闭 AI 助手' : '打开 AI 助手'}
          aria-label={aiSidebarOpen ? '关闭 AI 助手' : '打开 AI 助手'}
          className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
            aiSidebarOpen ? 'bg-ai/20 text-ai' : 'text-dim hover:bg-panel3 hover:text-fg'
          }`}
        >
          <SparkIcon className="h-4 w-4" />
        </button>
        {/* 设置入口：打开设置弹窗（系统 / AI 助手 / 数据库 / SSH / 同步） */}
        <button
          onClick={() => openOverlay({ kind: 'settings' })}
          title="设置"
          aria-label="设置"
          className="flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:bg-panel3 hover:text-fg"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
        {version && <span className="pr-1 text-[10px] text-dim2">v{version}</span>}
      </div>

      {/* Windows/Linux：真实窗口控制按钮（最小化 / 最大化-还原 / 关闭） */}
      {!isMac && isDesktop && (
        <div className="flex h-full shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <WinBtn onClick={control('minimize')} label="最小化">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.2} viewBox="0 0 12 12">
              <path d="M1.5 6h9" />
            </svg>
          </WinBtn>
          <WinBtn onClick={control('maximize')} label={maximized ? '还原' : '最大化'}>
            {maximized ? (
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.2} viewBox="0 0 12 12">
                <rect x="3.5" y="1.5" width="7" height="7" rx="1" />
                <path d="M8.5 3.5v-1a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1" />
              </svg>
            ) : (
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.2} viewBox="0 0 12 12">
                <rect x="2" y="2" width="8" height="8" rx="1" />
              </svg>
            )}
          </WinBtn>
          <WinBtn onClick={control('close')} label="关闭" danger>
            <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.2} viewBox="0 0 12 12">
              <path d="m2 2 8 8M10 2l-8 8" />
            </svg>
          </WinBtn>
        </div>
      )}
    </div>
  );
}

/** Windows 风格窗口按钮：46×36 命中区，关闭悬停红底白字 */
function WinBtn({
  onClick,
  label,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-full w-[46px] items-center justify-center text-dim transition-colors ${
        danger ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-panel3 hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

/* —— 内联图标，保持组件自包含 —— */
function SparkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
    </svg>
  );
}
function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
