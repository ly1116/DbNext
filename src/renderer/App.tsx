import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from './store/appStore';
import { useConnections } from './store/connectionStore';
import { usePrefs } from './store/prefsStore';
import { api } from './api';
import { TitleBar } from './components/shell/TitleBar';
import { WorkbenchToolbar } from './components/shell/WorkbenchToolbar';
import { applyUiTheme, UI_THEMES } from './theme/ui-themes';
import { WorkbenchScreen } from './screens/Workbench/WorkbenchScreen';
import { SchemaDiffScreen } from './screens/SchemaDiff/SchemaDiffScreen';
import { SettingsModal } from './components/common/SettingsModal';
import { AboutModal } from './components/common/AboutModal';
import { ConnectionDialog, DEFAULT_PORT } from './components/common/ConnectionDialog';
import { CreateTableDialog } from './components/common/CreateTableDialog';
import { TransferScreen } from './screens/Transfer/TransferScreen';
import { SftpFullscreenScreen } from './screens/SftpFullscreen/SftpFullscreenScreen';
import { AiTaskScreen } from './screens/AiTask/AiTaskScreen';
import { ChmodDialogHost, PromptDialogHost } from './components/common/PromptDialog';
import { SshInputHost } from './components/common/SshInputDialog';
import { ErrorBoundary } from './components/common/ErrorBoundary';

/**
 * 应用根组件。
 *
 * 组合「标题栏 + 顶部导航 + 屏幕路由 + 状态栏」的经典桌面布局：
 * - 屏幕路由由 `useAppStore.activeScreen` 驱动，仅保留 5 个核心屏；
 * - 低频功能（设置 / 连接编辑 / 传输 / SFTP 全屏 / AI 深度任务）经 `overlay` 以
 *   **弹层**呈现（模态对话框或全屏浮层），不占用导航位。
 *
 * @since 0.1.0
 */
export default function App() {
  const overlay = useAppStore((s) => s.overlay);
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);

  // 应用启动即加载真实连接列表与通用偏好，并订阅主进程推送的连接状态变化
  useEffect(() => {
    void useConnections.getState().load();
    void usePrefs.getState().load();
    const off = api.onConnectionStatus((id, status) => useConnections.getState().setStatus(id, status));
    return off;
  }, []);

  // 配色方案 + 字体大小：订阅 prefs，即时把主题写入 CSS 变量（数据库区/导航器/对话框整体换肤）
  const theme = usePrefs((s) => s.prefs.theme);
  const fontSize = usePrefs((s) => s.prefs.fontSize);
  useEffect(() => {
    applyUiTheme(theme, fontSize);
    // 原生窗口底色跟随主题：frameless 窗口在 HTML 加载前的底色（浅色主题防白闪）
    try {
      api.setNativeBackgroundColor(UI_THEMES[theme]?.bg ?? '#181818');
    } catch {
      /* 浏览器预览无此能力，忽略 */
    }
  }, [theme, fontSize]);

  // 全局快捷键：⌘K / Ctrl+K 打开命令面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleCommandPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCommandPalette]);

  // Esc 关闭当前弹层
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, closeOverlay]);

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <TitleBar>
        {/* 工具栏内嵌标题栏：新建连接/新建查询/用户/传输/结构同步/导入/导出/刷新/连接，不再单独占一栏 */}
        <WorkbenchToolbar />
      </TitleBar>
      {/* Navicat 风格单窗口：连接导航器 + 标签区 + 底部状态栏由 WorkbenchScreen 自管理 */}
      <div className="flex min-h-0 flex-1">
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <WorkbenchScreen />

        {/* —— 全局弹层（挂到 body，脱离 main 堆叠上下文，确保置顶显示） —— */}
        {createPortal(
          <>
            {overlay?.kind === 'settings' && <SettingsModal onClose={closeOverlay} />}

            {overlay?.kind === 'about' && <AboutModal onClose={closeOverlay} />}

            {overlay?.kind === 'connection-edit' && (
              <ConnectionDialog
                preset={overlay.preset}
                initial={
                  overlay.connectionId
                    ? // 编辑：载入已存配置（口令留空即沿用已存密文）
                      (() => {
                        const c = useConnections.getState().connections.find((x) => x.id === overlay.connectionId);
                        return c ? { ...(c as unknown as Record<string, unknown>), password: '', privateKey: '', passphrase: '' } as never : {};
                      })()
                    : // 新建：按侧栏分类预置类型（db/ssh），端口取该类型默认值
                      (() => {
                        const p = overlay.preset ?? {};
                        const kind = p.kind ?? 'mysql';
                        return { kind, environment: 'dev', port: DEFAULT_PORT[kind], ...(p.group ? { group: p.group } : {}) };
                      })()
                }
                onClose={closeOverlay}
                onSaved={closeOverlay}
              />
            )}

            {/* 全屏浮层：结构同步 / 传输向导 / SFTP 全屏 / AI 深度任务
                居中浮动卡片，四周留出窗口边距（不铺满），但**不加半透明遮罩**——
                遮罩会让底层工具栏透出来形成两层观感（用户明确要求「不要遮罩层」）。
                卡片外层透明承接点击 → 点空白处等同 Esc 关闭。
                z-[100] 高于标题栏 z-50 与所有下拉 z-50。 */}
            {(overlay?.kind === 'transfer' || overlay?.kind === 'sftpfull' || overlay?.kind === 'aitask' || overlay?.kind === 'diff') && (
              <div
                className="fixed inset-0 z-[100] flex items-center justify-center p-5"
                onMouseDown={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}
              >
                {/* 卡片尺寸按屏类型分档：向导类（传输/对比）收窄，SFTP 与 AI 任务属全屏型工具，给更大空间。
                    不加半透明遮罩——遮罩会让底层工具栏透出来形成两层观感（用户明确要求「不要遮罩层」）。 */}
                <div
                  className={`relative flex w-full flex-col overflow-hidden rounded-xl border border-line2 bg-bg shadow-[0_10px_44px_rgb(0_0_0/0.5)] ${
                    overlay.kind === 'sftpfull' || overlay.kind === 'aitask'
                      ? 'h-full max-w-[1500px]'
                      : 'h-full max-w-[1180px]'
                  }`}
                >
                  <ErrorBoundary>
                    {overlay.kind === 'transfer' && <TransferScreen initialConnectionId={overlay.connectionId} />}
                    {overlay.kind === 'sftpfull' && <SftpFullscreenScreen initialConnectionId={overlay.connectionId} />}
                    {overlay.kind === 'aitask' && <AiTaskScreen />}
                    {overlay.kind === 'diff' && <SchemaDiffScreen />}
                  </ErrorBoundary>
                </div>
              </div>
            )}

            {/* CreateTableDialog（独立 portal，z-index 更高） */}
            {overlay?.kind === 'create-table' && (
              <CreateTableDialog
                connectionId={overlay.connectionId!}
                preset={overlay.preset as { db?: string; schema?: string; kind?: 'table' | 'view' | 'mview' | 'sequence' | 'function'; editName?: string } | undefined}
                onClose={closeOverlay}
                onCreated={closeOverlay}
              />
            )}
          </>,
          document.body,
        )}
        </main>
      </div>
      {/* 全局输入弹窗宿主（替代 Electron 不支持的 window.prompt） */}
      <PromptDialogHost />
      {/* 权限九宫格弹窗宿主（SFTP chmod） */}
      <ChmodDialogHost />
      {/* SSH 二次验证弹窗宿主（keyboard-interactive / TOTP 动态码） */}
      <SshInputHost />
    </div>
  );
}
