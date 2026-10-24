import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import { createTerminalSession, type TerminalSession } from '../services/ssh.service';

/**
 * SSH 终端 IPC 通道（真实 ssh2 shell；每条连接一个 shell，sessionKey 区分渲染端订阅者）。
 * 终端会话表与回收逻辑内聚于此，ipc.ts 仅在本模块导出 disposeTerminal 供连接断开时清理。
 */

export interface TermSubscriber {
  send: (data: string) => void;
}
export interface TermEntry {
  promise: Promise<TerminalSession>;
  sess?: TerminalSession;
  /** 订阅者（按渲染端 sessionKey 区分）：shell 输出扇出给所有活跃订阅者 */
  subscribers: Map<string, TermSubscriber>;
  /** 是否已为 shell 注册「扇出」监听（只注册一次） */
  fanned: boolean;
  /** 无订阅者后的延迟回收定时器 */
  closingTimer?: ReturnType<typeof setTimeout>;
}
const terminals = new Map<string, TermEntry>();

/** 销毁某连接的终端 shell 并清理表项（连接断开时由 ipc.ts 的 onStatusChange 调用） */
export function disposeTerminal(connectionId: string) {
  const entry = terminals.get(connectionId);
  if (!entry) return;
  if (entry.closingTimer) clearTimeout(entry.closingTimer);
  entry.subscribers.clear();
  entry.promise.then((s) => s.dispose()).catch(() => {});
  terminals.delete(connectionId);
}

export function registerTerminalIpc(): void {
  handle(IPC.TERMINAL_CREATE, async (e, connectionId: string, opts, sessionKey = '0') => {
    // 复用或新建该连接的唯一 shell
    let entry = terminals.get(connectionId);
    if (!entry) {
      entry = { promise: createTerminalSession(connectionId, opts ?? {}), subscribers: new Map(), fanned: false };
      terminals.set(connectionId, entry);
    }
    // StrictMode 双挂载 / 重连间隙：取消即将执行的延迟回收，复用同一 shell
    if (entry.closingTimer) {
      clearTimeout(entry.closingTimer);
      entry.closingTimer = undefined;
    }
    const sess = await entry.promise;
    entry.sess = sess;
    // 仅注册一次扇出监听：shell 输出分发给所有活跃订阅者
    if (!entry.fanned) {
      entry.fanned = true;
      sess.onData((chunk) => {
        const t = terminals.get(connectionId);
        if (!t) return;
        for (const sub of t.subscribers.values()) sub.send(chunk);
      });
    }
    // 注册本订阅者，并回放首屏缓冲（哪怕订阅晚于首屏到达也补齐）
    const sub: TermSubscriber = {
      send: (data) => e.sender.send(IPC.TERMINAL_DATA, { connectionId, sessionKey, data }),
    };
    entry.subscribers.set(sessionKey, sub);
    sess.replay((backlog) => sub.send(backlog));
    return true;
  });

  handle(IPC.TERMINAL_WRITE, (_e, connectionId: string, data: string) => {
    terminals.get(connectionId)?.sess?.write(data);
  });

  handle(IPC.TERMINAL_RESIZE, (_e, connectionId: string, dims: { cols: number; rows: number }) => {
    terminals.get(connectionId)?.sess?.resize(dims.cols, dims.rows);
  });

  handle(IPC.TERMINAL_EXIT, (_e, connectionId: string, sessionKey = '0') => {
    const entry = terminals.get(connectionId);
    if (!entry) return;
    entry.subscribers.delete(sessionKey);
    // 无订阅者：延迟回收（覆盖 StrictMode 双挂载间隙），期间有新订阅者接入则取消
    if (entry.subscribers.size === 0) {
      entry.closingTimer = setTimeout(() => disposeTerminal(connectionId), 400);
    }
  });
}
