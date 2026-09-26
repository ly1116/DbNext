import { app, shell } from 'electron';
import { join } from 'node:path';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import type { DbScript } from '@shared/types';
import { createLogger } from '../logger';

/**
 * SQL 脚本文件存储（主进程侧）。
 *
 * 每个连接一个目录，每个脚本一个 .sql 纯文本文件，落盘在 OS 标准应用数据目录：
 *   Windows: %APPDATA%/DbNest/scripts/<connId>/<name>.sql
 *   macOS:   ~/Library/Application Support/DbNest/scripts/<connId>/<name>.sql
 *   Linux:   ~/.config/Dbnbest/scripts/<connId>/<name>.sql
 *
 * 与 localStorage 方案相比：脚本是真实可读的 .sql 文件，可被任意编辑器打开、
 * 备份、复制分享；按连接隔离、随应用关闭仍在。
 *
 * 文件名安全：剥离文件系统非法字符（\ / : * ? " < > | 及控制字符），并阻止
 * `..` / 绝对路径，避免路径穿越。脚本名统一以 .sql 结尾。
 *
 * @since 0.3.0
 */
const logger = createLogger('script-service');

const SCRIPTS_ROOT = join(app.getPath('userData'), 'scripts');

/** 清理脚本名 -> 安全文件名（不含 .sql 后缀） */
function safeBaseName(raw: string): string {
  const cleaned = (raw || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // 去掉文件系统非法字符
    .replace(/\.{2,}/g, '') // 去掉连续点（防 ..）
    .replace(/^\.+|\.+$/g, '') // 去掉首尾点
    .trim();
  return cleaned.slice(0, 120) || '未命名脚本';
}

function connDir(connId: string): string {
  // connId 由 store 生成（如 conn:xxx），本身安全，但再兜底一次
  const safe = connId.replace(/[^A-Za-z0-9_\-:.]/g, '_');
  return join(SCRIPTS_ROOT, safe);
}

function ensureConnDir(connId: string): string {
  const dir = connDir(connId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 列出某连接的全部脚本（按更新时间倒序） */
export function listScripts(connId: string): DbScript[] {
  const dir = connDir(connId);
  if (!existsSync(dir)) return [];
  const out: DbScript[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.sql')) continue;
    const base = f.slice(0, -4);
    try {
      const sql = readFileSync(join(dir, f), 'utf8');
      const mtime = statSync(join(dir, f)).mtimeMs;
      out.push({ id: base, name: base, sql, updatedAt: mtime });
    } catch (e) {
      logger.warn(`读取脚本失败 ${f}: ${(e as Error).message}`);
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** 新增 / 覆盖保存（同名覆盖内容），返回保存后的脚本元数据 */
export function saveScript(connId: string, name: string, sql: string): DbScript {
  const base = safeBaseName(name);
  const dir = ensureConnDir(connId);
  const file = join(dir, `${base}.sql`);
  writeFileSync(file, sql ?? '', 'utf8');
  const updatedAt = statSync(file).mtimeMs;
  return { id: base, name: base, sql: sql ?? '', updatedAt };
}

/** 删除脚本（按名），不存在也不报错 */
export function deleteScript(connId: string, name: string): void {
  const dir = connDir(connId);
  const file = join(dir, `${safeBaseName(name)}.sql`);
  if (existsSync(file)) unlinkSync(file);
}

/** 重命名脚本（旧名 -> 新名），旧文件内容搬到新文件后删除旧文件 */
export function renameScript(connId: string, oldName: string, newName: string): DbScript {
  const dir = ensureConnDir(connId);
  const oldFile = join(dir, `${safeBaseName(oldName)}.sql`);
  const next = saveScript(connId, newName, existsSync(oldFile) ? readFileSync(oldFile, 'utf8') : '');
  if (existsSync(oldFile)) unlinkSync(oldFile);
  return next;
}

/**
 * 在系统文件管理器中定位脚本文件（资源管理器打开并选中该 .sql）。
 * 文件不存在时打开其所在目录。
 */
export function revealScript(connId: string, name: string): void {
  const file = join(connDir(connId), `${safeBaseName(name)}.sql`);
  if (existsSync(file)) {
    shell.showItemInFolder(file);
  } else {
    void openScriptsDir(connId);
  }
}

/**
 * 在系统文件管理器中打开脚本目录（不选中任何文件）。
 * connId 缺省时打开脚本根目录（含各连接子目录）。目录不存在会自动创建。
 */
export async function openScriptsDir(connId?: string): Promise<void> {
  const dir = connId ? ensureConnDir(connId) : ensureDir(SCRIPTS_ROOT);
  const errMsg = await shell.openPath(dir);
  if (errMsg) logger.warn(`打开脚本目录失败 ${dir}: ${errMsg}`);
}

/** 确保目录存在（根目录用） */
function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
