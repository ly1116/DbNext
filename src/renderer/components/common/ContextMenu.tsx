import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 通用右键菜单（桌面应用标配交互）。
 *
 * 在光标处浮出菜单项，点击菜单项 / 空白处 / Esc 关闭。
 * 越界时自动向内收（避免贴屏幕边缘溢出）。
 * 支持 `children` 二级子菜单（悬停展开，如「移动到文件夹 ▸」）。
 *
 * 用法：由调用方自行管理 `{ x, y } | null` 状态，`onContextMenu` 里
 * `e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY })`。
 *
 * @since 0.1.0
 */
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** 分隔线（忽略 label） */
  separator?: boolean;
  /** 二级子菜单（悬停展开） */
  children?: MenuItem[];
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** 当前展开子菜单的主菜单项下标（null = 无） */
  const [sub, setSub] = useState<number | null>(null);

  // 点击菜单外 / Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 防止贴边溢出
  const W = 176;
  const H = items.reduce((h, it) => h + (it.separator ? 11 : 26), 8);
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[100] min-w-[176px] overflow-visible rounded-lg border border-line2 bg-panel py-1 shadow-2xl"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={() => setSub(null)}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : it.children ? (
          /* 带子菜单的项：悬停展开二级面板 */
          <div key={i} className="relative" onMouseEnter={() => setSub(i)}>
            <button
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] ${
                it.disabled ? 'cursor-not-allowed text-dim2' : it.danger ? 'text-prod hover:bg-panel3' : 'text-fg hover:bg-panel3'
              }`}
              disabled={it.disabled}
            >
              {it.icon && <span className="flex w-4 shrink-0 justify-center opacity-80">{it.icon}</span>}
              {it.label}
              <ChevronRight />
            </button>
            {sub === i && (
              <div className="absolute left-[calc(100%+2px)] top-[-4px] z-[101] min-w-[150px] overflow-hidden rounded-lg border border-line2 bg-panel py-1 shadow-2xl">
                {it.children.map((child, j) =>
                  child.separator ? (
                    <div key={j} className="my-1 h-px bg-line" />
                  ) : (
                    <button
                      key={j}
                      disabled={child.disabled}
                      onClick={() => {
                        onClose();
                        child.onClick?.();
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] ${
                        child.disabled
                          ? 'cursor-not-allowed text-dim2'
                          : child.danger
                            ? 'text-prod hover:bg-panel3'
                            : 'text-fg hover:bg-panel3'
                      }`}
                    >
                      {child.icon && <span className="flex w-4 shrink-0 justify-center opacity-80">{child.icon}</span>}
                      {child.label}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ) : (
          <button
            key={i}
            disabled={it.disabled}
            onMouseEnter={() => setSub(null)}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
            className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] ${
              it.disabled
                ? 'cursor-not-allowed text-dim2'
                : it.danger
                  ? 'text-prod hover:bg-panel3'
                  : 'text-fg hover:bg-panel3'
            }`}
          >
            {it.icon && <span className="flex w-4 shrink-0 justify-center opacity-80">{it.icon}</span>}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

function ChevronRight() {
  return (
    <svg className="ml-auto h-3 w-3 text-dim2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
