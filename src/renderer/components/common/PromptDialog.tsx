import { Fragment, useEffect, useRef, useState } from 'react';

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

// —— 权限（chmod）九宫格弹窗：所有者/属组/其他 × 读/写/执行 勾选，实时合成八进制值 ——

export interface ChmodOptions {
  /** 弹窗标题（如「修改权限：bin（当前 644）」） */
  title: string;
  /** 初始权限：3~4 位八进制字符串（取后 3 位解析，特殊位不进九宫格） */
  mode: string;
  /** 确认按钮文案，默认「应用」 */
  okText?: string;
}

type ChmodResolver = (v: string | null) => void;

let chmodForward: ((opts: ChmodOptions, resolve: ChmodResolver) => void) | null = null;

/** 九宫格权限弹窗：确认返回 3 位八进制字符串，取消返回 null */
export function chmodDialog(opts: ChmodOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (chmodForward) chmodForward(opts, resolve);
    else resolve(null);
  });
}

/** 9 位开关状态：[所有者, 属组, 其他] × [读, 写, 执行]，值为 2^bit */
const PERM_BITS = [
  [4, 2, 1],
  [4, 2, 1],
  [4, 2, 1],
];

/** 全局权限弹窗宿主：在应用根部挂载一次（与 PromptDialogHost 并列） */
export function ChmodDialogHost() {
  const [cur, setCur] = useState<{ opts: ChmodOptions; resolve: ChmodResolver } | null>(null);
  // checked[who][bit]：who 0=所有者 1=属组 2=其他；bit 0=读 1=写 2=执行
  const [checked, setChecked] = useState<boolean[][]>(() => PERM_BITS.map(() => [false, false, false]));

  useEffect(() => {
    chmodForward = (opts, resolve) => {
      const n = parseInt((opts.mode.replace(/^0/, '') || '0').slice(-3), 8);
      const m = Number.isNaN(n) ? 0o644 : n;
      setChecked([0, 1, 2].map((who) => [0, 1, 2].map((bit) => (m & PERM_BITS[who][bit]) !== 0)));
      setCur({ opts, resolve });
    };
    return () => {
      chmodForward = null;
    };
  }, []);

  if (!cur) return null;

  const close = (v: string | null) => {
    cur.resolve(v);
    setCur(null);
  };

  const octal = checked.map((row) => row.reduce((acc, on, bit) => acc + (on ? PERM_BITS[0][bit] : 0), 0)).join('');
  const triad = (row: boolean[]) => `${row[0] ? 'r' : '-'}${row[1] ? 'w' : '-'}${row[2] ? 'x' : '-'}`;
  const perms = `${triad(checked[0])} ${triad(checked[1])} ${triad(checked[2])}`;

  const heads = ['读', '写', '执行'];
  const rows = ['所有者', '属组', '其他'];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={() => close(null)}>
      <div
        className="w-[300px] overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3.5 text-[13px] font-medium text-fg">{cur.opts.title}</div>

        {/* 九宫格：行=身份，列=读/写/执行 */}
        <div className="px-4 pt-3">
          <div className="grid grid-cols-[64px_repeat(3,1fr)] gap-y-1.5">
            <span />
            {heads.map((h) => (
              <span key={h} className="text-center text-[11px] text-dim2">{h}</span>
            ))}
            {rows.map((label, who) => (
              <Fragment key={label}>
                <span className="flex items-center text-[11px] text-dim">{label}</span>
                {[0, 1, 2].map((bit) => {
                  const on = checked[who][bit];
                  return (
                    <button
                      key={bit}
                      onClick={() => setChecked((c) => c.map((r, i) => (i === who ? r.map((v, j) => (j === bit ? !v : v)) : r)))}
                      className={`mx-auto flex h-7 w-9 items-center justify-center rounded border text-[12px] transition-colors ${
                        on
                          ? 'border-accent bg-accent/15 text-accent'
                          : 'border-line bg-bg text-dim2 hover:border-line2 hover:text-dim'
                      }`}
                      title={`${label}·${heads[bit]}（${PERM_BITS[0][bit]}）`}
                    >
                      {on ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-3.5 w-3.5">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        '—'
                      )}
                    </button>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>

        {/* 实时预览：rwxrwxrwx (755) */}
        <div className="mt-3 flex items-center justify-center gap-2 border-t border-line/60 px-4 pt-2.5">
          <code className="rounded bg-bg px-2 py-0.5 font-mono text-[12px] tracking-wider text-fg">{perms}</code>
          <code className="font-mono text-[12px] font-semibold text-accent">({octal})</code>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3">
          <button
            className="h-7 rounded border border-line2 px-3 text-[12px] text-dim hover:text-fg"
            onClick={() => close(null)}
          >
            取消
          </button>
          <button
            className="h-7 rounded bg-accent px-3 text-[12px] text-white hover:opacity-90"
            onClick={() => close(octal)}
          >
            {cur.opts.okText ?? '应用'}
          </button>
        </div>
      </div>
    </div>
  );
}
