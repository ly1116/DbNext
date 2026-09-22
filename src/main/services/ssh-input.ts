import { BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from '../logger';
import type { SshInputRequest } from '@shared/types';

/**
 * SSH 二次验证（keyboard-interactive）请求/响应桥。
 *
 * 主进程的 `openSsh` 在握手阶段若收到服务端的 `keyboard-interactive` 事件
 * （多因子认证，如动态令牌 / TOTP），调用 {@link requestSshInput} 把一个请求推给
 * 渲染端弹窗；用户填写后，渲染端经 `ssh:inputResponse` 调用 {@link resolveSshInput}
 * 把答案回传，Promise 据此 resolve。answers 为 null 表示取消 / 超时，调用方应中止连接。
 *
 * 动态码只在本次连接会话的内存中流动，绝不落盘。
 *
 * @since 0.1.0
 */
const logger = createLogger('ssh-input');

interface Pending {
  resolve: (answers: string[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/** 二次验证等待超时（毫秒）：给用户充足时间找动态码 / 看 Authenticator */
const TIMEOUT_MS = 180_000;

/**
 * 向渲染端请求二次验证输入，返回用户填写的答案数组。
 *
 * @throws 当无可用窗口、用户取消、或超时时
 */
export function requestSshInput(base: Omit<SshInputRequest, 'requestId'>): Promise<string[]> {
  const requestId = `ssh2fa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise<string[]>((resolve, reject) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) {
      return reject(new Error('无可用窗口接收二次验证'));
    }
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('二次验证超时（>3 分钟），请重试连接'));
    }, TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timer });

    const payload: SshInputRequest = { ...base, requestId };
    win.webContents.send(IPC.SSH_INPUT_REQUEST, payload);
    logger.info(`请求二次验证输入: ${base.connectionName}`);
  });
}

/** 渲染端回传答案（null = 取消） */
export function resolveSshInput(requestId: string, answers: string[] | null): void {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  if (answers === null) p.reject(new Error('已取消二次验证'));
  else p.resolve(answers);
}
