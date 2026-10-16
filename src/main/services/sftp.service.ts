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

/** 修改权限（chmod）：modeOctal 为 3~4 位八进制字符串，如 '644' / '0755' */
export async function chmod(connectionId: string, path: string, modeOctal: string): Promise<void> {
  const sftp = await getSftp(connectionId);
  try {
    const mode = parseInt(modeOctal.replace(/^0/, '') || '0', 8);
    if (Number.isNaN(mode) || mode < 0 || mode > 0o7777) throw new Error(`权限值不合法：${modeOctal}`);
    // ssh2 类型未声明 setstat，实际运行时存在（SFTP SETSTAT 协议操作）
    const setstat = (sftp as unknown as { setstat: (p: string, attrs: Record<string, unknown>, cb: (e?: Error) => void) => void }).setstat.bind(sftp);
    await promisify<void>((cb) => setstat(path, { mode }, cb));
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

/** 编辑器可打开的文本文件大小上限（超过则拒绝，避免拉爆内存） */
export const MAX_EDIT_BYTES = 4 * 1024 * 1024;

/**
 * ssh2 的 SFTPWrapper 类型未声明 readFile / write / 带 attrs 的 open，
 * 但运行时确实存在（见 ssh2/lib/protocol/SFTP.js），这里局部断言取出（与 setstat 同做法）。
 */
type SftpExtra = {
  readFile: (p: string, cb: (e: Error | undefined, data?: Buffer) => void) => void;
  write: (h: string, buf: Buffer, off: number, len: number, pos: number, cb: (e?: Error) => void) => void;
  open: (p: string, flags: string, attrs: { mode: number } | undefined, cb: (e: Error | undefined, handle?: string) => void) => void;
};
const sftpX = (sftp: import('ssh2').SFTPWrapper) => sftp as unknown as SftpExtra;

/**
 * 读取远端文本文件内容（供内置编辑器使用）。
 * 超过 MAX_EDIT_BYTES 直接抛错，避免大文件（如日志、tar 包）拉进内存。
 */
export async function readTextFile(connectionId: string, path: string): Promise<{ content: string; size: number }> {
  const sftp = await getSftp(connectionId);
  try {
    const attrs = await promisify<Record<string, unknown>>((cb) => sftp.stat(path, cb as never));
    const size = (attrs.size as number) ?? 0;
    if (size > MAX_EDIT_BYTES) {
      throw new Error(`文件过大（${(size / 1024 / 1024).toFixed(1)} MB），超过编辑器 ${MAX_EDIT_BYTES / 1024 / 1024} MB 上限`);
    }
    const buf = await promisify<Buffer>((cb) => sftpX(sftp).readFile(path, cb));
    return { content: buf.toString('utf-8'), size };
  } finally {
    sftp.end();
  }
}

/**
 * 写回远端文本文件。
 * 策略分层：
 * 1. 原子写入（首选）：写临时文件 → posix-rename / unlink+rename 替换（保留原权限）；
 * 2. 直写兜底：堡垒机（JumpServer）等代理型 SFTP 常禁 rename/unlink，此时退回
 *    open(path,'w') 直接覆写原文件（不带 attrs，最大兼容；权限自然不变）。
 * 每步失败带步骤名，便于日志定位。
 */
export async function writeTextFile(connectionId: string, path: string, content: string): Promise<void> {
  const data = Buffer.from(content, 'utf-8');
  if (data.byteLength > MAX_EDIT_BYTES) {
    throw new Error(`内容过大（${(data.byteLength / 1024 / 1024).toFixed(1)} MB），超过编辑器上限`);
  }
  const sftp = await getSftp(connectionId);
  const x = sftpX(sftp);
  const tmp = `${path}.dbr-edit-${Date.now().toString(36)}.tmp`;
  const stepErr = (step: string, e: unknown): Error => new Error(`[SFTP ${step}] ${(e as Error)?.message ?? String(e)}`);
  try {
    // 保留原权限（不存在则用 0644）
    const attrs = await promisify<Record<string, unknown>>((cb) => sftp.stat(path, cb as never)).catch(() => null);
    const mode = ((attrs?.permissions as number) ?? 0o644) & 0o777;

    // 直写兜底：open 原文件 'w'（truncate + write），不依赖 rename
    const writeDirect = async (): Promise<void> => {
      let handle: string;
      try {
        handle = await promisify<string>((cb) => x.open(path, 'w', undefined, cb));
      } catch (e) {
        throw stepErr('open(直写)', e);
      }
      try {
        try {
          await promisify<void>((cb) => x.write(handle, data, 0, data.byteLength, 0, cb));
        } catch (e) {
          throw stepErr('write(直写)', e);
        }
      } finally {
        await promisify<void>((cb) => sftp.close(handle, cb)).catch((e) => logger.warn(`close(直写) 失败: ${(e as Error).message}`));
      }
    };

    // 原子写入：临时文件 + rename
    try {
      let handle: string;
      try {
        handle = await promisify<string>((cb) => x.open(tmp, 'w', { mode }, cb));
      } catch (e) {
        throw stepErr('open(tmp)', e);
      }
      try {
        try {
          await promisify<void>((cb) => x.write(handle, data, 0, data.byteLength, 0, cb));
        } catch (e) {
          throw stepErr('write(tmp)', e);
        }
      } finally {
        await promisify<void>((cb) => sftp.close(handle, cb)).catch((e) => logger.warn(`close(tmp) 失败: ${(e as Error).message}`));
      }
      // SFTP v3 标准 RENAME 不允许覆盖已存在目标（否则 SSH_FX_FAILURE）。
      // 优先走 posix-rename@openssh.com 原子覆盖扩展；服务器不支持时降级为先删旧文件再 rename。
      const posixRename = (sftp as unknown as { ext_openssh_rename?: (src: string, dest: string, cb: (e?: Error) => void) => void }).ext_openssh_rename;
      if (typeof posixRename === 'function') {
        try {
          await promisify<void>((cb) => posixRename.call(sftp, tmp, path, cb as never));
        } catch (e) {
          throw stepErr('posix-rename', e);
        }
      } else {
        await promisify<void>((cb) => sftp.unlink(path, cb as never)).catch(() => undefined);
        try {
          await promisify<void>((cb) => sftp.rename(tmp, path, cb as never));
        } catch (e) {
          throw stepErr('rename', e);
        }
      }
    } catch (e) {
      logger.warn(`原子写入失败（${(e as Error).message}），降级为直接覆写原文件`);
      await writeDirect();
      // 直写成功后清理临时文件（若已创建）
      await promisify<void>((cb) => sftp.unlink(tmp, cb as never)).catch(() => undefined);
    }
  } catch (e) {
    logger.warn(`writeTextFile 失败: ${path}: ${(e as Error).message}`);
    // 失败清理临时文件，避免远端留垃圾
    await promisify<void>((cb) => sftp.unlink(tmp, cb as never)).catch(() => undefined);
    throw e;
  } finally {
    sftp.end();
  }
}
