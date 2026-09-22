import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import type { SshInputRequest } from '@shared/types';

/**
 * SSH 二次验证弹窗宿主（keyboard-interactive / TOTP）。
 *
 * 远端 sshd 启用多因子认证（如 PAM + Google Authenticator）时，主进程在握手阶段
 * 通过 `ssh:inputRequest` 推送一组提示，这里弹窗收集用户动态码并回传；取消 / 超时则
 * 回传 null，主进程中止该次连接（与 Termius / VS Code 行为一致）。
 *
 * 在应用根部挂载一次 `<SshInputHost />`：渲染端弹窗即为全局入口，与「谁发起连接」
 * 解耦——无论是手动点连接、AI 触发自愈重连、还是数据库经跳板隧道，都会自动弹窗。
 *
 * @since 0.1.0
 */
export function SshInputHost() {
  const [req, setReq] = useState<SshInputRequest | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [reveal, setReveal] = useState<boolean[]>([]);
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);

  // 订阅主进程下发的二次验证请求（全局，仅挂载一次）
  useEffect(() => {
    const off = api.onSshInputRequest((r) => {
      setReq(r);
      setValues(r.prompts.map(() => ''));
      // echo=true 由服务端要求明文显示（如用户名）；否则掩码（动态码 / 口令）
      setReveal(r.prompts.map((p) => p.echo));
    });
    return off;
  }, []);

  // 弹出时聚焦第一个输入框
  useEffect(() => {
    if (req) {
      requestAnimationFrame(() => inputsRef.current[0]?.focus());
    }
  }, [req]);

  if (!req) return null;

  const allFilled = values.every((v) => v.trim().length > 0);

  const respond = (answers: string[] | null) => {
    const id = req.requestId;
    setReq(null);
    void api.sshInputRespond(id, answers);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      respond(null);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!values[i]?.trim()) return;
      if (i < req.prompts.length - 1) {
        inputsRef.current[i + 1]?.focus();
      } else if (allFilled) {
        respond(values.map((v) => v.trim()));
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50" onMouseDown={() => respond(null)}>
      <div
        className="w-[360px] overflow-hidden rounded-lg border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3.5 text-[13px] font-medium text-fg">二次验证 · {req.connectionName}</div>
        {req.instructions ? (
          <div className="px-4 pt-2 text-[11px] leading-relaxed text-dim2">{req.instructions}</div>
        ) : null}
        <div className="px-4 pt-3">
          {req.prompts.map((p, i) => (
            <div key={i} className="mb-2.5">
              <div className="mb-1 text-[11px] text-dim">{p.prompt}</div>
              <div className="relative">
                <input
                  ref={(el) => {
                    inputsRef.current[i] = el;
                  }}
                  type={reveal[i] ? 'text' : 'password'}
                  value={values[i] ?? ''}
                  onChange={(e) => {
                    const next = [...values];
                    next[i] = e.target.value;
                    setValues(next);
                  }}
                  onKeyDown={(e) => onKeyDown(e, i)}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 w-full rounded border border-line bg-bg px-2 text-[12px] tracking-wider text-fg outline-none placeholder:text-dim2 focus:border-accent/60"
                />
                {!reveal[i] && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = [...reveal];
                      next[i] = true;
                      setReveal(next);
                      inputsRef.current[i]?.focus();
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-dim hover:text-fg"
                    title="显示输入内容"
                  >
                    显示
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3">
          <button
            className="h-7 rounded border border-line2 px-3 text-[12px] text-dim hover:text-fg"
            onClick={() => respond(null)}
          >
            取消
          </button>
          <button
            className="h-7 rounded bg-accent px-3 text-[12px] text-white hover:opacity-90 disabled:opacity-40"
            disabled={!allFilled}
            onClick={() => respond(values.map((v) => v.trim()))}
          >
            验证并连接
          </button>
        </div>
      </div>
    </div>
  );
}
