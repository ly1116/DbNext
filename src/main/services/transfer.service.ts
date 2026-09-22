import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSsh } from '../clients/manager';

/**
 * 文件传输服务（真实实现）。
 *
 * 经已建立的 ssh2 连接做真实的上传/下载，ssh2 的 fastPut/fastGet 自带进度回调，
 * 每收到一个分片即回调 onProgress（主进程由此推送 TRANSFER_PROGRESS）。
 *
 * @since 0.1.0
 */

function getSftp(connectionId: string) {
  const ssh = getSsh(connectionId);
  if (!ssh) throw new Error('传输所需 SSH 连接未建立');
  return new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
    ssh.sftp((err, sftp) => (err ? reject(new Error(`打开 SFTP 失败: ${err.message}`)) : resolve(sftp)));
  });
}

/**
 * 上传本地文件到远端。
 * @returns 任务 { id, total }
 */
export async function upload(
  connectionId: string,
  localPath: string,
  remotePath: string,
  onProgress: (transferred: number, total: number) => void,
): Promise<{ id: string; total: number }> {
  const id = `up-${Date.now().toString(36)}`;
  const total = statSync(localPath).size;
  const sftp = await getSftp(connectionId);
  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, { step: (t: number) => onProgress(t, total) } as never, (err?: Error) =>
        err ? reject(new Error(`上传失败: ${err.message}`)) : resolve(),
      );
    });
    onProgress(total, total);
    return { id, total };
  } finally {
    sftp.end();
  }
}

/** 下载远端文件到本地 */
export async function download(
  connectionId: string,
  remotePath: string,
  localPath: string,
  onProgress: (transferred: number, total: number) => void,
): Promise<{ id: string; total: number }> {
  const id = `dl-${Date.now().toString(36)}`;
  const sftp = await getSftp(connectionId);
  try {
    // 先 stat 拿大小
    const attrs = await new Promise<Record<string, unknown>>((resolve, reject) =>
      sftp.stat(remotePath, (e, a) => (e ? reject(new Error(e.message)) : resolve(a as Record<string, unknown>))),
    );
    const total = (attrs.size as number) ?? 0;
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, { step: (t: number) => onProgress(t, total) } as never, (err?: Error) =>
        err ? reject(new Error(`下载失败: ${err.message}`)) : resolve(),
      );
    });
    onProgress(total, total);
    return { id, total };
  } finally {
    sftp.end();
  }
}

/** 远端 mkdir -p：逐级创建，已存在时忽略错误 */
async function mkdirp(sftp: import('ssh2').SFTPWrapper, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    await new Promise<void>((resolve) => sftp.mkdir(cur, undefined, () => resolve()));
  }
}

/**
 * 递归上传本地目录到远端 remotePath（自动逐级创建远端目录）。
 * 进度按所有文件总字节聚合。
 */
export async function uploadDir(
  connectionId: string,
  localPath: string,
  remotePath: string,
  onProgress: (transferred: number, total: number) => void,
): Promise<{ id: string; total: number }> {
  const id = `updir-${Date.now().toString(36)}`;
  // 先遍历本地收集文件清单与总字节
  const files: { local: string; rel: string; size: number }[] = [];
  let total = 0;
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else {
        const size = statSync(join(dir, e.name)).size;
        files.push({ local: join(dir, e.name), rel: r, size });
        total += size;
      }
    }
  };
  walk(localPath, '');
  if (!total) total = 1;

  const sftp = await getSftp(connectionId);
  let done = 0;
  try {
    await mkdirp(sftp, remotePath);
    for (const f of files) {
      const remote = `${remotePath}/${f.rel}`;
      const parent = remote.slice(0, remote.lastIndexOf('/'));
      if (parent) await mkdirp(sftp, parent);
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(f.local, remote, { step: (t: number) => onProgress(done + t, total) } as never, (err?: Error) =>
          err ? reject(new Error(`上传失败: ${err.message}`)) : resolve(),
        );
      });
      done += f.size;
      onProgress(done, total);
    }
    return { id, total };
  } finally {
    sftp.end();
  }
}

/** 递归下载远端目录到本地 localPath（进度按总字节聚合） */
export async function downloadDir(
  connectionId: string,
  remotePath: string,
  localPath: string,
  onProgress: (transferred: number, total: number) => void,
): Promise<{ id: string; total: number }> {
  const id = `dldir-${Date.now().toString(36)}`;
  const sftp = await getSftp(connectionId);
  try {
    // 先递归收集远端文件与总字节
    const files: { remote: string; rel: string; size: number }[] = [];
    let total = 0;
    const walk = async (rd: string, rel: string): Promise<void> => {
      const list = await new Promise<Array<{ filename: string; attrs: Record<string, unknown> }>>((resolve, reject) =>
        sftp.readdir(rd, (e, l) => (e ? reject(new Error(e.message)) : resolve(l as never))),
      );
      for (const e of list) {
        const r = rel ? `${rel}/${e.filename}` : e.filename;
        if ((e.attrs.isDirectory as (() => boolean) | undefined)?.()) await walk(`${rd}/${e.filename}`, r);
        else {
          const size = (e.attrs.size as number) ?? 0;
          files.push({ remote: `${rd}/${e.filename}`, rel: r, size });
          total += size;
        }
      }
    };
    await walk(remotePath, '');
    if (!total) total = 1;

    mkdirSync(localPath, { recursive: true });
    let done = 0;
    for (const f of files) {
      const local = join(localPath, ...f.rel.split('/'));
      mkdirSync(dirname(local), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(f.remote, local, { step: (t: number) => onProgress(done + t, total) } as never, (err?: Error) =>
          err ? reject(new Error(`下载失败: ${err.message}`)) : resolve(),
        );
      });
      done += f.size;
      onProgress(done, total);
    }
    return { id, total };
  } finally {
    sftp.end();
  }
}
