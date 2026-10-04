import type { ReactNode } from 'react';
import { useAppStore } from '@renderer/store/appStore';

/**
 * 全屏页头部条（结构对比 / 数据传输 / SFTP 全屏 / AI 深度任务共用）。
 *
 * 这些屏以「全屏接管」方式打开（fixed inset-0，无遮罩无卡片边框），
 * 因此关闭入口必须由每屏自己提供 —— 本组件把「标题 + 竖条 + 副标题 + 右侧操作 + 关闭」
 * 收成一处，保证四屏头部形态一致，且右侧为关闭按钮预留 `pr-` 让位。
 */
export function FullScreenHeader({
  title,
  subtitle,
  accent = 'accent2',
  actions,
}: {
  title: string;
  subtitle?: string;
  /** 标题左侧竖条与 AI 标识色 */
  accent?: 'accent2' | 'ai';
  /** 头部右侧操作区（关闭按钮左侧） */
  actions?: ReactNode;
}) {
  const closeOverlay = useAppStore((s) => s.closeOverlay);
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel2/70 px-4">
      <span className={`h-4 w-1 shrink-0 rounded-full ${accent === 'ai' ? 'bg-ai' : 'bg-accent2'}`} />
      <span className="shrink-0 text-[13px] font-semibold text-fg">{title}</span>
      {subtitle && <span className="truncate text-[11px] text-dim2">{subtitle}</span>}
      {actions && <div className="ml-auto flex min-w-0 items-center gap-2">{actions}</div>}
      <button
        onClick={closeOverlay}
        className={`${actions ? '' : 'ml-auto '}flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line2 bg-panel2 pl-2.5 pr-2 text-[11px] text-dim transition-colors hover:bg-panel3 hover:text-fg`}
        title="关闭（Esc）"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
        关闭
      </button>
    </div>
  );
}
