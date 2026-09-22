import { useEffect, useRef, useState } from 'react';

/**
 * 应用内输入弹窗（替代 window.prompt）。
 *
 * Electron 渲染进程不支持 `window.prompt`（调用直接抛异常），因此所有需要用户
 * 输入名称的场景（SFTP 重命名 / 新建文件夹 / 新建文件、数据库新建库等）统一走
 * 这里的 `promptDialog()`：返回 Promise<string | null>，确认返回输入值、取消返回 null。
 *
 * 使用方式：
 * 1. 在应用根部挂载一次 `<PromptDialogHost />`；
 * 2. 任意处 `const name = await promptDialog({ title: '重命名为：', value: oldName })`。
 *
 * @since 0.1.0
 */

export interface PromptOptions {
  /** 弹窗标题 / 提示文案 */
  title: string;
  /** 输入框初始值 */
  value?: string;
  /** 输入框占位文本 */
  placeholder?: string;
  /** 确认按钮文案，默认「确定」 */
  okText?: string;
}

type Resolver = (v: string | null) => void;

/** 模块级单例转发：promptDialog() 把请求交给已挂载的 Host 渲染 */
let forward: ((opts: PromptOptions, resolve: Resolver) => void) | null = null;

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (forward) forward(opts, resolve);
    else resolve(null);
  });
}

/** 全局输入弹窗宿主：在应用根部挂载一次 */
export function PromptDialogHost() {
  const [cur, setCur] = useState<{ opts: PromptOptions; resolve: Resolver } | null>(null);
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    forward = (opts, resolve) => {
      setVal(opts.value ?? '');
      setCur({ opts, resolve });
    };
    return () => {
      forward = null;
    };
  }, []);

  // 弹出时聚焦并全选，方便直接输入覆盖
  useEffect(() => {
    if (cur) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [cur]);

  if (!cur) return null;

  const close = (v: string | null) => {
    cur.resolve(v);
    setCur(null);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={() => close(null)}>
      <div
        className="w-[320px] overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3.5 text-[13px] font-medium text-fg">{cur.opts.title}</div>
        <div className="px-4 pt-2.5">
          <input
            ref={inputRef}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') close(val.trim());
              if (e.key === 'Escape') close(null);
            }}
            placeholder={cur.opts.placeholder}
            spellCheck={false}
            className="h-8 w-full rounded border border-line bg-bg px-2 text-[12px] text-fg outline-none placeholder:text-dim2 focus:border-accent/60"
          />
        </div>
        <div className="flex justify-end gap-2 px-4 py-3">
          <button
            className="h-7 rounded border border-line2 px-3 text-[12px] text-dim hover:text-fg"
            onClick={() => close(null)}
          >
            取消
          </button>
          <button
            className="h-7 rounded bg-accent px-3 text-[12px] text-white hover:opacity-90 disabled:opacity-40"
            disabled={!val.trim()}
            onClick={() => close(val.trim())}
          >
            {cur.opts.okText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
