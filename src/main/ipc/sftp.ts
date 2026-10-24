import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type { FileNode } from '@shared/types';
import { listDir, stat, mkdir, remove, rename, touch, chmod, readTextFile, writeTextFile } from '../services/sftp.service';

/** SFTP 文件系统 IPC 通道（列目录/增删改/读写文本）。 */
export function registerSftpIpc(): void {
  handle(IPC.SFTP_LIST, (_e, connectionId: string, path: string): Promise<FileNode[]> => listDir(connectionId, path));
  handle(IPC.SFTP_STAT, (_e, connectionId: string, path: string): Promise<FileNode> => stat(connectionId, path));
  handle(IPC.SFTP_MKDIR, (_e, connectionId: string, path: string) => mkdir(connectionId, path));
  handle(IPC.SFTP_REMOVE, (_e, connectionId: string, path: string, recursive?: boolean) => remove(connectionId, path, recursive));
  handle(IPC.SFTP_RENAME, (_e, connectionId: string, oldPath: string, newPath: string) => rename(connectionId, oldPath, newPath));
  handle(IPC.SFTP_TOUCH, (_e, connectionId: string, path: string) => touch(connectionId, path));
  handle(IPC.SFTP_CHMOD, (_e, connectionId: string, path: string, modeOctal: string) => chmod(connectionId, path, modeOctal));
  handle(IPC.SFTP_READ_TEXT, (_e, connectionId: string, path: string) => readTextFile(connectionId, path));
  handle(IPC.SFTP_WRITE_TEXT, (_e, connectionId: string, path: string, content: string) => writeTextFile(connectionId, path, content));
}
