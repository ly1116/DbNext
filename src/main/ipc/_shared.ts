import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createLogger } from '../logger';

const logger = createLogger('ipc');

/**
 * 统一 IPC 错误处理：包裹 ipcMain.handle，handler 抛错时记录结构化日志（含通道名与堆栈），
 * 仍向渲染端 reject 以便调用方 .catch 兜底。避免任意 handler 遗漏 try/catch 导致线上无日志可查。
 *
 * 各 ipc/* 子模块统一通过本函数注册通道，保证错误处理与日志口径一致。
 */
export function handle<T = unknown>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await listener(event, ...args);
    } catch (err) {
      const e = err as Error;
      logger.error(`[IPC ${channel}] ${e?.stack ?? e?.message ?? String(err)}`);
      throw err;
    }
  });
}
