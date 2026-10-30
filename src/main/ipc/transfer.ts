import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type { TransferTask } from '@shared/types';
import { upload, download, uploadDir, downloadDir } from '../services/transfer.service';

/**
 * 文件/目录传输 IPC 通道（真实 sftp，带进度推送）。
 * 传输任务表内聚于此，供 TRANSFER_LIST 快照读取。
 */

/** 传输任务表（用于 transfer:list 快照） */
const transfers = new Map<string, TransferTask>();

export function registerTransferIpc(): void {
  /** 通用任务登记 + 进度推送（文件/目录上传下载共用） */
  let transferSeq = 0;
  const trackTransfer = (
    e: Electron.IpcMainInvokeEvent,
    _direction: 'upload' | 'download',
    remotePath: string,
    localPath: string,
    run: (onProgress: (transferred: number, total: number) => void) => Promise<{ id: string; total: number }>,
  ) => {
    // id 在任务开始前就生成：并行多任务时进度事件各自携带稳定 id，前端才能逐条展示
    const id = `xf-${Date.now().toString(36)}-${++transferSeq}`;
    const t: TransferTask = { id, remotePath, localPath, direction: _direction, total: 0, transferred: 0, status: 'active' };
    return run((transferred, total) => {
      t.total = total;
      t.transferred = transferred;
      t.status = transferred >= total ? 'done' : 'active';
      transfers.set(id, t);
      e.sender.send(IPC.TRANSFER_PROGRESS, {
        id,
        localPath: t.localPath,
        remotePath: t.remotePath,
        direction: t.direction,
        transferred,
        total,
        status: t.status,
      });
    })
      .then((r) => {
        t.total = r.total;
        t.transferred = r.total;
        t.status = 'done';
        transfers.set(id, t);
        return r;
      })
      .catch((err) => {
        t.status = 'error';
        t.error = (err as Error).message;
        throw err;
      });
  };
  handle(IPC.TRANSFER_UPLOAD, (e, connectionId: string, localPath: string, remotePath: string) =>
    trackTransfer(e, 'upload', remotePath, localPath, (onProgress) => upload(connectionId, localPath, remotePath, onProgress)));
  handle(IPC.TRANSFER_DOWNLOAD, (e, connectionId: string, remotePath: string, localPath: string) =>
    trackTransfer(e, 'download', remotePath, localPath, (onProgress) => download(connectionId, remotePath, localPath, onProgress)));
  handle(IPC.TRANSFER_UPLOAD_DIR, (e, connectionId: string, localPath: string, remotePath: string) =>
    trackTransfer(e, 'upload', remotePath, localPath, (onProgress) => uploadDir(connectionId, localPath, remotePath, onProgress)));
  handle(IPC.TRANSFER_DOWNLOAD_DIR, (e, connectionId: string, remotePath: string, localPath: string) =>
    trackTransfer(e, 'download', remotePath, localPath, (onProgress) => downloadDir(connectionId, remotePath, localPath, onProgress)));
  handle(IPC.TRANSFER_LIST, (): TransferTask[] => [...transfers.values()]);
}
