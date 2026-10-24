import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';
import { createLogger } from './logger';
import { initConnectionStore, initOtpStore } from './services/connection-store';
import { onStatusChange } from './clients/manager';
import { disposeTerminal } from './ipc/terminal';
import { registerConnectionIpc } from './ipc/connection';
import { registerTerminalIpc } from './ipc/terminal';
import { registerSftpIpc } from './ipc/sftp';
import { registerTransferIpc } from './ipc/transfer';
import { registerRedisIpc } from './ipc/redis';
import { registerNacosIpc } from './ipc/nacos';
import { registerSqlIpc } from './ipc/sql';
import { registerAiIpc } from './ipc/ai';
import { registerMiscIpc } from './ipc/misc';

const logger = createLogger('ipc');

/**
 * IPC 路由注册中心（组合根）。
 *
 * 将 `shared/ipc-channels` 中声明的每个通道，绑定到主进程对应的「真实」service 实现。
 * 各领域通道的注册逻辑已下沉到 `./ipc/*` 子模块（每个文件只负责一个领域，
 * 单一职责、互不耦合）；本文件仅做编排：初始化存储、订阅连接状态、按顺序调用各 register。
 *
 * 渲染进程通过 preload 暴露的 `window.dataroost` 调用，类型两端一致。
 * 所有涉及真实服务器的动作都带 connectionId，由客户端管理器取已建立的连接。
 *
 * @since 0.1.0
 */
export function registerIpc(): void {
  initConnectionStore();
  initOtpStore();
  onStatusChange((id, status) => {
    // 连接状态变化时广播给所有窗口，渲染端据此刷新连接树
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC.CONNECTION_STATUS, { id, status });
    }
    // 连接断开：销毁其终端 shell，避免远端孤儿登录会话泄漏
    if (status === 'disconnected') disposeTerminal(id);
  });

  // 按领域注册各通道（实现见 ./ipc/*）
  registerConnectionIpc();
  registerTerminalIpc();
  registerSftpIpc();
  registerTransferIpc();
  registerRedisIpc();
  registerNacosIpc();
  registerSqlIpc();
  registerAiIpc();
  registerMiscIpc();

  logger.info('IPC 通道已注册（真实实现）');
}

/** 反注册（测试/热重载用） */
export function unregisterIpc(): void {
  Object.values(IPC).forEach((ch) => ipcMain.removeHandler(ch));
}
