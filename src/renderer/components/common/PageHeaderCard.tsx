import type { ReactNode, RefObject } from 'react';

/**
 * 统一页头卡（用户与权限管理 / 对象清单 / 序列 / 函数等页面共用）：
 * 渐变主题色图标片 + 标题 + 副标题徽标行 + 右侧搜索框 / 动作按钮区。
 * 与 UsersTab 页头同款视觉：rounded-[10px] 卡片、from-accent to-purple 渐变图标。
 */
export function PageHeaderCard({
  icon,
  title,
  subtitle,
  search,
  actions,
}: {
  /** 渐变图标片内的 SVG（16-18px 线性图标，白色） */
  icon: ReactNode;
  /** 主标题（一行，溢出省略） */
  title: ReactNode;
  /** 副标题行：方言徽标 / 统计摘要等 */
  subtitle?: ReactNode;
  /** 搜索框（提供即显示；value 受控） */
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    /** Ctrl+F 聚焦用 */
    inputRef?: RefObject<HTMLInputElement>;
  };
  /** 右侧动作按钮（btn / btn-primary） */
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 rounded-[10px] border border-line bg-panel px-4 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-accent to-purple text-white">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-fg">{title}</div>
        {subtitle != null && (
          <div className="mt-0.5 flex items-center gap-2 text-[length:calc(var(--pref-fs)*0.786)] text-dim">{subtitle}</div>
        )}
      </div>
      {search && (
        <div className="flex h-[30px] w-52 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel2 px-2.5 transition-colors focus-within:border-accent">
          <svg className="h-3.5 w-3.5 shrink-0 text-dim2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={search.inputRef}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? '搜索…'}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2"
          />
          {search.value && (
            <button onClick={() => search?.onChange('')} className="shrink-0 text-dim2 hover:text-fg" title="清空搜索">
              <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
      )}
      {actions}
    </div>
  );
}
