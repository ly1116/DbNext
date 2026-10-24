import type { ReactNode, RefObject } from 'react';
import { Icon } from '@renderer/components/common/icons';

/**
 * 统一页头（shadcn/ui 规范）：细边框图标片 + 标题 + 副标题行 + 右侧搜索框 / 动作按钮区。
 * 用户与权限管理 / 对象清单 / 序列 / 函数等页面共用。
 */
export function PageHeaderCard({
  icon,
  title,
  subtitle,
  search,
  actions,
}: {
  /** 图标片内的 SVG（16-18px 线性图标） */
  icon: ReactNode;
  /** 主标题（一行，溢出省略） */
  title: ReactNode;
  /** 副标题行：方言徽标 / 统计摘要等 */
  subtitle?: ReactNode;
  /** 搜索框（提供即显示；value 受控） */
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    /** Ctrl+F 聚焦用 */
    inputRef?: RefObject<HTMLInputElement>;
  };
  /** 右侧动作按钮（shadcn Button） */
  actions?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-sm">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold leading-none text-foreground">{title}</div>
        {subtitle != null && (
          <div className="mt-1.5 flex items-center gap-2 text-[13px] leading-none text-muted-foreground">{subtitle}</div>
        )}
      </div>
      {search && (
        <div className="relative flex h-9 w-60 shrink-0 items-center">
          <Icon name="search" className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            ref={search.inputRef}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder}
            spellCheck={false}
            className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          {search.value && (
            <button
              onClick={() => search?.onChange('')}
              className="absolute right-2 text-muted-foreground transition-colors hover:text-foreground"
              title="清空搜索"
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      {actions}
    </div>
  );
}
