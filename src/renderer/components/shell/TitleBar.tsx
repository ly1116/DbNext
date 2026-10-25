import { api } from '@renderer/api';
import { useAppStore } from '@renderer/store/appStore';
import { useEffect, useState } from 'react';
import { Icon, AppLogo } from '@renderer/components/common/icons';

/**
 * 标题栏（窗口顶部）—— 真实桌面应用行为：
 *
 * - 整条为系统拖拽区（-webkit-app-region: drag），可拖动窗口；交互元素单独 no-drag。
 * - 中部 children 插槽：工作台工具栏（WorkbenchToolbar）内嵌于此，应用不再单独占一栏工具栏。
 * - macOS：hiddenInset 下系统原生红黄绿按钮显示在左上角，这里只留出等宽空间，绝不画假按钮。
 * - Windows/Linux（frame:false）：右侧提供真实的最小化 / 最大化-还原 / 关闭按钮，
 *   经 IPC 直接操作 BrowserWindow（win.minimize / maximize / close）。
 * - 双击标题栏切换最大化（Windows 惯例）。
 *
 * @since 0.1.0
 */
export function TitleBar({ children }: { children?: React.ReactNode }) {
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
      className="relative z-50 flex h-9 shrink-0 select-none items-center gap-3 border-b border-border bg-background/95 pl-4 pr-0 backdrop-blur"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      onDoubleClick={isDesktop && !isMac ? control('maximize') : undefined}
    >
      {/* macOS：留出系统原生交通灯空间（真实系统控件在此渲染，应用不画假按钮） */}
      {isMac && <div className="w-[72px] shrink-0" />}

      {/* Windows/Linux：左侧应用标识（仅 logo，不显示应用名） */}
      {!isMac && (
        <div className="flex shrink-0 items-center">
          <AppLogo className="h-4 w-4" />
        </div>
      )}

      {/* 中部插槽：工作台工具栏（no-drag 保证按钮可点击） */}
      {children && (
        <div className="ml-2 flex min-w-0 items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {children}
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
            aiSidebarOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
          }`}
        >
          <SparkIcon className="h-4 w-4" />
        </button>
        {/* 设置入口：打开设置弹窗（系统 / AI 助手 / 数据库 / SSH / 同步） */}
        <button
          onClick={() => openOverlay({ kind: 'settings' })}
          title="设置"
          aria-label="设置"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <SettingsIcon className="h-4 w-4" />
        </button>
        {version && <span className="pr-1 text-[10px] text-muted-foreground">v{version}</span>}
      </div>

      {/* Windows/Linux：真实窗口控制按钮（最小化 / 最大化-还原 / 关闭） */}
      {!isMac && isDesktop && (
        <div className="flex h-full shrink-0" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <WinBtn onClick={control('minimize')} label="最小化">
            <Icon name="winMinimize" className="h-3 w-3" strokeWidth={1.2} />
          </WinBtn>
          <WinBtn onClick={control('maximize')} label={maximized ? '还原' : '最大化'}>
            {maximized ? (
              <Icon name="winRestore" className="h-3 w-3" strokeWidth={1.2} />
            ) : (
              <Icon name="winMaximize" className="h-3 w-3" strokeWidth={1.2} />
            )}
          </WinBtn>
          <WinBtn onClick={control('close')} label="关闭" danger>
            <Icon name="winClose" className="h-3 w-3" strokeWidth={1.2} />
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
      className={`flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors ${
        danger ? 'hover:bg-destructive hover:text-white' : 'hover:bg-secondary hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

/* —— 应用 Logo 已统一收进 icons 模块，此处直接复用 —— */

function SparkIcon({ className }: { className?: string }) {
  return (
    <Icon name="sparkles" className={className} strokeWidth={1.8} />
  );
}
function SettingsIcon({ className }: { className?: string }) {
  return (
    <Icon name="settings" className={className} strokeWidth={1.8} />
  );
}
