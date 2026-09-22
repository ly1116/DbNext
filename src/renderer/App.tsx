import { useEffect } from 'react';
import { useAppStore } from './store/appStore';
import { useConnections } from './store/connectionStore';
import { usePrefs } from './store/prefsStore';
import { api } from './api';
import { TitleBar } from './components/shell/TitleBar';
import { StatusBar } from './components/shell/StatusBar';
import { WorkbenchScreen } from './screens/Workbench/WorkbenchScreen';
import { SqlEditorScreen } from './screens/SqlEditor/SqlEditorScreen';
import { DataGridScreen } from './screens/DataGrid/DataGridScreen';
import { RedisScreen } from './screens/Redis/RedisScreen';
import { SchemaDiffScreen } from './screens/SchemaDiff/SchemaDiffScreen';
import { SettingsModal } from './components/common/SettingsModal';
import { ConnectionDialog, DEFAULT_PORT } from './components/common/ConnectionDialog';
import { TransferScreen } from './screens/Transfer/TransferScreen';
import { SftpFullscreenScreen } from './screens/SftpFullscreen/SftpFullscreenScreen';
import { AiTaskScreen } from './screens/AiTask/AiTaskScreen';
import { PromptDialogHost } from './components/common/PromptDialog';
import { SshInputHost } from './components/common/SshInputDialog';

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
  const activeScreen = useAppStore((s) => s.activeScreen);
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
    <div className="flex h-full flex-col bg-[#0d0d0d] text-fg">
      <TitleBar />
      {/* 屏幕内容区：核心屏（默认常驻工作台） */}
      <div className="flex min-h-0 flex-1">
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {activeScreen === 'shell' && <WorkbenchScreen />}
        {activeScreen === 'query' && <SqlEditorScreen />}
        {activeScreen === 'grid' && <DataGridScreen />}
        {activeScreen === 'redis' && <RedisScreen />}
        {activeScreen === 'diff' && <SchemaDiffScreen />}

        {/* —— 全局弹层 —— */}
        {overlay?.kind === 'settings' && <SettingsModal onClose={closeOverlay} />}

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
                    const kind = p.kind ?? 'ssh';
                    return { kind, environment: 'dev', port: DEFAULT_PORT[kind], ...(p.group ? { group: p.group } : {}) };
                  })()
            }
            onClose={closeOverlay}
            onSaved={closeOverlay}
          />
        )}

        {/* 全屏浮层：传输向导 / SFTP 全屏 / AI 深度任务 */}
        {(overlay?.kind === 'transfer' || overlay?.kind === 'sftpfull' || overlay?.kind === 'aitask') && (
          <div className="absolute inset-0 z-40 flex flex-col bg-black/55 p-6">
            <div className="relative min-h-0 flex-1">
              <button
                onClick={closeOverlay}
                className="absolute -top-1 right-0 z-10 -translate-y-full rounded px-2 py-1 text-[11px] text-white/80 hover:text-white"
                title="关闭（Esc）"
              >
                ✕ 关闭
              </button>
              {overlay.kind === 'transfer' && <TransferScreen initialConnectionId={overlay.connectionId} />}
              {overlay.kind === 'sftpfull' && <SftpFullscreenScreen initialConnectionId={overlay.connectionId} />}
              {overlay.kind === 'aitask' && <AiTaskScreen />}
            </div>
          </div>
        )}
        </main>
      </div>
      <StatusBar />
      {/* 全局输入弹窗宿主（替代 Electron 不支持的 window.prompt） */}
      <PromptDialogHost />
      {/* SSH 二次验证弹窗宿主（keyboard-interactive / TOTP 动态码） */}
      <SshInputHost />
    </div>
  );
}
