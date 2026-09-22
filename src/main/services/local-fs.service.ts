import os from 'node:os';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger';

/**
 * 本地文件系统浏览（只读）。
 *
 * 供渲染端的 SFTP 本地栏、传输任务的本地路径选择使用——
 * 真实读取本机目录，绝不编造文件列表。仅暴露列表，不暴露写入/删除，
 * 本地写操作由 electron 的 `dialog` 选中的路径交给主进程真实执行。
 *
 * @since 0.1.0
 */
const logger = createLogger('local-fs');

export interface LocalNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
}

/** 列出某目录下的条目（真实读取） */
export async function listLocal(dir: string): Promise<LocalNode[]> {
  const base = dir && dir.trim() ? dir : os.homedir();
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取目录 ${base}: ${(err as Error).message}`);
  }
  const nodes: LocalNode[] = [];
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    const full = join(base, e.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = await fs.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      /* 符号链接断裂等情况忽略 stat */
    }
    nodes.push({
      name: e.name,
      path: full,
      isDir: e.isDirectory(),
      size,
      modifiedAt: mtime ? new Date(mtime).toISOString() : new Date().toISOString(),
    });
  }
  nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  logger.debug(`listLocal: ${base} -> ${nodes.length} 项`);
  return nodes;
}

/** 读取文本文件（云同步导入 profile 用） */
export async function readText(path: string): Promise<string> {
  return fs.readFile(path, 'utf-8');
}

/** 写入文本文件（云同步导出 profile 用） */
export async function writeText(path: string, content: string): Promise<void> {
  await fs.writeFile(path, content, 'utf-8');
}
