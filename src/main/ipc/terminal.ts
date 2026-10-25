import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import { createTerminalSession, type TerminalSession } from '../services/ssh.service';

/**
 * SSH 终端 IPC 通道（真实 ssh2 shell）。
 *
 * **会话粒度 = 连接 + sessionKey**：同一主机可以开多个终端标签，每个标签一个独立
 * shell 会话（互不干扰、各自 resize / 独立回收）。渲染端每次挂载终端都会生成一个
 * 唯一 sessionKey（`p<序号>`），因此 StrictMode 双挂载 / 重连也自然隔离。
 *
 * 终端会话表与回收逻辑内聚于此，ipc.ts 仅在本模块导出 disposeTerminal 供连接断开时清理。
 */

export interface TermSubscriber {
  send: (data: string) => void;
}
export interface TermEntry {
  promise: Promise<TerminalSession>;
  sess?: TerminalSession;
  /** 所属连接 id（断开时按它批量清理该连接的所有会话） */
  connectionId: string;
  /** 订阅者（按渲染端 sessionKey 区分；本实现下一会话一订阅者，保留 Map 以兼容未来扇出） */
  subscribers: Map<string, TermSubscriber>;
  /** 是否已为 shell 注册数据监听（只注册一次） */
  fanned: boolean;
  /** 无订阅者后的延迟回收定时器 */
  closingTimer?: ReturnType<typeof setTimeout>;
}
/** 键 = `${connectionId}::${sessionKey}` */
const terminals = new Map<string, TermEntry>();

const termKey = (connectionId: string, sessionKey: string) => `${connectionId}::${sessionKey}`;

/** 销毁某连接的**所有**终端会话（连接断开时由 ipc.ts 的 onStatusChange 调用） */
export function disposeTerminal(connectionId: string) {
  for (const [key, entry] of [...terminals]) {
    if (entry.connectionId !== connectionId) continue;
    if (entry.closingTimer) clearTimeout(entry.closingTimer);
    entry.subscribers.clear();
    entry.promise.then((s) => s.dispose()).catch(() => {});
    terminals.delete(key);
  }
}

export function registerTerminalIpc(): void {
  handle(IPC.TERMINAL_CREATE, async (e, connectionId: string, opts, sessionKey = '0') => {
    // 每个 (连接, sessionKey) 一个独立 shell：多标签 = 多会话
    const key = termKey(connectionId, sessionKey);
    let entry = terminals.get(key);
    if (!entry) {
      entry = {
        promise: createTerminalSession(connectionId, opts ?? {}),
        connectionId,
        subscribers: new Map(),
        fanned: false,
      };
      terminals.set(key, entry);
    }
    // 重连间隙：取消即将执行的延迟回收，复用同一 shell
    if (entry.closingTimer) {
      clearTimeout(entry.closingTimer);
      entry.closingTimer = undefined;
    }
    const sess = await entry.promise;
    entry.sess = sess;
    // 仅注册一次数据监听：本会话的输出只推给本会话的订阅者
    if (!entry.fanned) {
      entry.fanned = true;
      sess.onData((chunk) => {
        const t = terminals.get(key);
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

  handle(IPC.TERMINAL_WRITE, (_e, connectionId: string, data: string, sessionKey = '0') => {
    // 按 sessionKey 精确路由：多标签同时输入不会串台
    terminals.get(termKey(connectionId, sessionKey))?.sess?.write(data);
  });

  handle(IPC.TERMINAL_RESIZE, (_e, connectionId: string, dims: { cols: number; rows: number }, sessionKey = '0') => {
    terminals.get(termKey(connectionId, sessionKey))?.sess?.resize(dims.cols, dims.rows);
  });

  handle(IPC.TERMINAL_EXIT, (_e, connectionId: string, sessionKey = '0') => {
    const key = termKey(connectionId, sessionKey);
    const entry = terminals.get(key);
    if (!entry) return;
    entry.subscribers.delete(sessionKey);
    // 无订阅者：延迟回收（覆盖 StrictMode 双挂载间隙），期间有新订阅者接入则取消
    if (entry.subscribers.size === 0) {
      entry.closingTimer = setTimeout(() => {
        const t = terminals.get(key);
        if (!t || t.subscribers.size > 0) return;
        t.promise.then((s) => s.dispose()).catch(() => {});
        terminals.delete(key);
      }, 400);
    }
  });
}
