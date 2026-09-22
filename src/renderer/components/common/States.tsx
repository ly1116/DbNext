import type { ReactNode } from 'react';
import type { ConnectionStatus } from '@shared/types';

/**
 * 通用界面状态组件：加载中 / 出错 / 空数据 / 轻提示。
 * 所有真实屏幕统一用它们表达「正在连服务器 / 连不上 / 没数据」，绝不编造内容。
 */

/** 加载中 */
export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-dim">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-line2 border-t-accent" />
      <span className="text-[12px]">{text}</span>
    </div>
  );
}

/** 出错 */
export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-prod/15 text-prod">
        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M12 9v4M12 17h.01" />
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      </div>
      <span className="max-w-[420px] text-[12px] leading-relaxed text-fg">{message}</span>
      {onRetry && (
        <button onClick={onRetry} className="rounded border border-line2 px-3 py-1.5 text-[12px] text-dim hover:text-fg">
          重试
        </button>
      )}
    </div>
  );
}

/** 空数据 / 提示 */
export function Empty({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-panel3 text-dim2">
        <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 24 24">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      </div>
      <span className="max-w-[420px] text-[12px] text-dim">{text}</span>
      {children}
    </div>
  );
}

/** 状态圆点（连接状态）：已连=绿，连接中=黄，未连/失败=红 */
export function StatusDot({ status }: { status: ConnectionStatus }) {
  const color =
    status === 'connected' ? 'bg-ok' : status === 'connecting' ? 'bg-warn' : 'bg-prod';
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}
