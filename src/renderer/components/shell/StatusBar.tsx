import { useAppStore } from '@renderer/store/appStore';

/**
 * 底部状态栏。
 *
 * 展示当前活跃连接、延迟、录制状态、SFTP 跟随、AI 就绪等运行时状态。
 * 数据来自 `appStore.status`，由各屏幕按需更新。
 *
 * @since 0.1.0
 */
export function StatusBar() {
  const status = useAppStore((s) => s.status);

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel2 px-3 text-[11px] text-dim">
      {/* 活跃连接 */}
      {status.activeConnection && (
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" />
          <span className="text-fg">{status.activeConnection}</span>
        </div>
      )}
      <Divider />
      <span>延迟 {status.latencyMs ?? '--'}ms</span>

      {/* 录制中 */}
      {status.recording && (
        <>
          <Divider />
          <span className="flex items-center gap-1.5 text-prod">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-prod" />
            录制 00:03:21
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-4">
        {status.sftpFollowing && (
          <span className="flex items-center gap-1.5 text-ok">
            <CheckIcon />
            SFTP 跟随中
          </span>
        )}
        {status.aiReady && (
          <span className="flex items-center gap-1.5 text-ai2">
            <span className="h-1.5 w-1.5 rounded-full bg-ai2" />
            AI 就绪
          </span>
        )}
      </div>
    </div>
  );
}

function Divider() {
  return <div className="h-3 w-px bg-line2" />;
}
function CheckIcon() {
  return (
    <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
