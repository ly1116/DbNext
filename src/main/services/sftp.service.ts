import type { FileNode } from '@shared/types';
import { createLogger } from '../logger';
import { getSsh } from '../clients/manager';

/**
 * SFTP 文件服务（真实实现）。
 *
 * 通过已建立 ssh2 连接的 sftp 子系统读取远端真实文件系统：
 * 列目录、stat、建目录、删除、重命名。无任何静态假数据。
 *
 * @since 0.1.0
 */
const logger = createLogger('sftp');

/** 把 ssh2 的 attrs 转为统一 FileNode */
function toNode(path: string, name: string, attrs: Record<string, unknown>): FileNode {
  const isDir = (attrs.isDirectory as () => boolean)?.call(attrs) ?? false;
  const mode = (attrs.permissions as number) ?? 0;
  const mtime = (attrs.mtime as number) ?? 0;
  return {
    path: path.endsWith('/') ? `${path}${name}` : `${path}/${name}`,
    name,
    type: isDir ? 'dir' : 'file',
    size: (attrs.size as number) ?? 0,
    mode: mode ? mode.toString(8).padStart(4, '0').slice(-4) : '0000',
    modifiedAt: mtime ? new Date(mtime * 1000).toISOString() : new Date().toISOString(),
  };
}

function getSftp(connectionId: string) {
  const ssh = getSsh(connectionId);
  if (!ssh) throw new Error('SFTP 所需 SSH 连接未建立');
  return new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
    ssh.sftp((err, sftp) => (err ? reject(new Error(`打开 SFTP 失败: ${err.message}`)) : resolve(sftp)));
  });
}

function promisify<T>(fn: (cb: (e: Error | undefined, r?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((e, r) => (e ? reject(new Error(e.message)) : resolve(r as T))));
}

/** 列出目录内容（真实远端读取） */
export async function listDir(connectionId: string, path: string): Promise<FileNode[]> {
  logger.debug(`listDir: ${path}`);
  const sftp = await getSftp(connectionId);
  try {
    const list = await promisify<Record<string, unknown>[]>((cb) => sftp.readdir(path, cb as never));
    return list
      .map((e) => toNode(path, e.filename as string, e.attrs as Record<string, unknown>))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  } finally {
    sftp.end();
  }
}

/** 获取单路径元信息（stat） */
export async function stat(connectionId: string, path: string): Promise<FileNode> {
  const sftp = await getSftp(connectionId);
  try {
    const attrs = await promisify<Record<string, unknown>>((cb) => sftp.stat(path, cb as never));
    const isDir = (attrs.isDirectory as () => boolean)?.call(attrs) ?? false;
    const mode = (attrs.permissions as number) ?? 0;
    return {
      path,
      name: path.split('/').filter(Boolean).pop() ?? path,
      type: isDir ? 'dir' : 'file',
      size: (attrs.size as number) ?? 0,
      mode: mode ? mode.toString(8).padStart(4, '0').slice(-4) : '0000',
      modifiedAt: ((attrs.mtime as number) ? new Date((attrs.mtime as number) * 1000).toISOString() : new Date().toISOString()),
    };
  } finally {
    sftp.end();
  }
}

/** 新建目录 */
export async function mkdir(connectionId: string, path: string): Promise<void> {
  const sftp = await getSftp(connectionId);
  try {
    await promisify<void>((cb) => sftp.mkdir(path, undefined, cb));
  } finally {
    sftp.end();
  }
}

/** 删除文件或目录（目录递归删除） */
export async function remove(connectionId: string, path: string, recursive = false): Promise<void> {
  const sftp = await getSftp(connectionId);
  try {
    const attrs = await promisify<Record<string, unknown>>((cb) => sftp.stat(path, cb as never)).catch(() => null);
    const isDir = attrs ? (attrs.isDirectory as () => boolean)?.call(attrs) ?? false : false;
    if (isDir) {
      if (!recursive) throw new Error('目标为目录，需开启递归删除');
      const list = await promisify<Record<string, unknown>[]>((cb) => sftp.readdir(path, cb as never));
      for (const e of list) {
        const child = `${path}/${e.filename as string}`;
        await remove(connectionId, child, true);
      }
      await promisify<void>((cb) => sftp.rmdir(path, cb as never));
    } else {
      await promisify<void>((cb) => sftp.unlink(path, cb as never));
    }
  } finally {
    sftp.end();
  }
}

/** 重命名 / 移动 */
export async function rename(connectionId: string, oldPath: string, newPath: string): Promise<void> {
  const sftp = await getSftp(connectionId);
  try {
    await promisify<void>((cb) => sftp.rename(oldPath, newPath, cb as never));
  } finally {
    sftp.end();
  }
}

/** 新建空文件（等价 touch；已存在则清空为 0 字节） */
export async function touch(connectionId: string, path: string): Promise<void> {
  const sftp = await getSftp(connectionId);
  try {
    const handle = await promisify<string>((cb) => sftp.open(path, 'w', cb as never));
    await promisify<void>((cb) => sftp.close(handle, cb));
  } finally {
    sftp.end();
  }
}
