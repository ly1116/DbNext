import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import type { AiSettings, ConnectionConfig, ConnectionFolder, GeneralPrefs, SyncConfigView, SyncResult } from '@shared/types';
import { createLogger } from '../logger';
import { isEncrypted, seal, unseal } from '../security/vault';
import {
  getAllConnectionsRaw,
  loadAiSettings,
  loadFolders,
  loadGeneralPrefs,
  saveAiSettings,
  saveConnection,
  saveFolders,
  saveGeneralPrefs,
} from './connection-store';

/**
 * 云同步服务（基于 Gitee 代码片段 / gist）。
 *
 * 设计要点：
 * - 同步载体 = 一个**私有** Gitee gist（`dbnest-sync.json` 单文件）；
 * - 同步内容（连接含明文凭据、文件夹、AI 模型与 Key、通用偏好）整体经 **用户同步口令**
 *   做 AES-256-GCM 加密后再写入 gist —— 因此口令即「跨机解密的钥匙」，Gitee 侧只存密文；
 * - Gitee 私人令牌（token）与同步口令均经 `electron.safeStorage` 加密落盘，渲染端拿不到明文；
 * - 推送：本地整库打包加密 → 新建/更新 gist；拉取：读 gist → 解密 → 合并写回本地。
 *
 * 安全模型：跨机迁移时，目标机用「同一同步口令」即可解密并恢复含凭据的全部配置，
 * 无需复用本机 vault 密钥（区别于普通导出 profile 的机器绑定密文）。
 *
 * @since 0.1.0
 */
const logger = createLogger('sync');

const GITEE_API = 'https://gitee.com/api/v5/gists';
const FILE_NAME = 'dbnest-sync.json';
const APP_TAG = 'dbnest';

const DATA_DIR = app.getPath('userData');
const CONFIG_FILE = join(DATA_DIR, 'sync-config.json');

/** gist 中存储的同步载荷（明文结构，写盘前整体加密） */
interface SyncPayload {
  app: string;
  version: number;
  syncedAt: string;
  connections: ConnectionConfig[];
  folders: ConnectionFolder[];
  aiSettings: AiSettings;
  prefs: GeneralPrefs;
}

/** 磁盘配置（敏感字段经 vault 加密） */
interface DiskConfig {
  token: string;
  passphrase: string;
  gistId: string;
  syncedAt?: string;
}

// ——— 口令加密（AES-256-GCM，密钥由同步口令 scrypt 派生）———

const ALGO = 'aes-256-gcm';

function encryptPayload(plain: string, pass: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pass, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

function decryptPayload(b64: string, pass: string): string {
  const buf = Buffer.from(b64, 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const enc = buf.subarray(44);
  const key = scryptSync(pass, salt, 32);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ——— 配置持久化 ———

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readDiskConfig(): DiskConfig {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) return { token: '', passphrase: '', gistId: '' };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Partial<DiskConfig>;
    return { token: raw.token ?? '', passphrase: raw.passphrase ?? '', gistId: raw.gistId ?? '', syncedAt: raw.syncedAt };
  } catch {
    return { token: '', passphrase: '', gistId: '' };
  }
}

function writeDiskConfig(c: DiskConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf-8');
}

/** 解密后的内存配置（仅主进程） */
interface ResolvedConfig {
  token: string;
  passphrase: string;
  gistId: string;
  syncedAt?: string;
}

function resolveConfig(tokenOverride?: string, passOverride?: string): ResolvedConfig {
  const d = readDiskConfig();
  return {
    token: tokenOverride && tokenOverride.length ? tokenOverride : unseal(d.token),
    passphrase: passOverride && passOverride.length ? passOverride : unseal(d.passphrase),
    gistId: d.gistId,
    syncedAt: d.syncedAt,
  };
}

// ——— 对外：渲染端可见的配置视图（绝不回传 token/passphrase 明文）———

/** 读取同步配置视图（敏感字段仅以布尔标记） */
export function getSyncConfig(): SyncConfigView {
  const d = readDiskConfig();
  return {
    hasToken: !!(d.token && (isEncrypted() ? unseal(d.token) : d.token)),
    hasPassphrase: !!(d.passphrase && (isEncrypted() ? unseal(d.passphrase) : d.passphrase)),
    gistId: d.gistId,
    syncedAt: d.syncedAt,
  };
}

/**
 * 保存配置（合并写）。空字符串表示「沿用已存值」——便于只更新其中一项而不清空另一项。
 * @returns 更新后的视图
 */
export function setSyncConfig(token: string, passphrase: string): SyncConfigView {
  const d = readDiskConfig();
  if (token && token.length) d.token = seal(token);
  if (passphrase && passphrase.length) d.passphrase = seal(passphrase);
  writeDiskConfig(d);
  logger.info('已保存云同步配置（Gitee 令牌/口令已加密落盘）');
  return getSyncConfig();
}

// ——— Gitee HTTP ———

async function giteeCreate(token: string, content: string): Promise<string> {
  const url = `${GITEE_API}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'DbNest 同步配置（请勿手动编辑）',
      public: false,
      files: { [FILE_NAME]: { content } },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`创建 Gitee gist 失败（${res.status}）：${text.slice(0, 300) || res.statusText}`);
  }
  const data = (await res.json()) as { id: string };
  if (!data.id) throw new Error('创建 Gitee gist 成功但未返回 id');
  return data.id;
}

async function giteeUpdate(token: string, gistId: string, content: string): Promise<void> {
  const url = `${GITEE_API}/${encodeURIComponent(gistId)}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'DbNest 同步配置（请勿手动编辑）',
      files: { [FILE_NAME]: { content } },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`更新 Gitee gist 失败（${res.status}）：${text.slice(0, 300) || res.statusText}`);
  }
}

async function giteeGet(token: string, gistId: string): Promise<string> {
  const url = `${GITEE_API}/${encodeURIComponent(gistId)}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Authorization: `token ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`读取 Gitee gist 失败（${res.status}）：${text.slice(0, 300) || res.statusText}`);
  }
  const data = (await res.json()) as { files?: Record<string, { content?: string }> };
  const content = data.files?.[FILE_NAME]?.content;
  if (content == null) throw new Error(`gist 中未找到 ${FILE_NAME}`);
  return content;
}

// ——— 对外：推送 / 拉取 ———

/** 推送本地整库到 Gitee（无 gist 则先创建） */
export async function pushSync(tokenOverride?: string, passOverride?: string): Promise<SyncResult> {
  const cfg = resolveConfig(tokenOverride, passOverride);
  if (!cfg.token) return { ok: false, message: '未配置 Gitee 私人令牌，请先在「同步」页填写并保存。' };
  if (!cfg.passphrase) return { ok: false, message: '未配置同步口令，密文无法生成。' };

  const payload: SyncPayload = {
    app: APP_TAG,
    version: 1,
    syncedAt: new Date().toISOString(),
    connections: getAllConnectionsRaw(),
    folders: loadFolders(),
    aiSettings: loadAiSettings(),
    prefs: loadGeneralPrefs(),
  };
  const blob = encryptPayload(JSON.stringify(payload), cfg.passphrase);

  try {
    if (!cfg.gistId) {
      const id = await giteeCreate(cfg.token, blob);
      const d = readDiskConfig();
      d.gistId = id;
      d.syncedAt = payload.syncedAt;
      writeDiskConfig(d);
      logger.info(`已创建同步 gist 并推送：${id}`);
      return {
        ok: true,
        message: `已创建同步点并推送 ${payload.connections.length} 个连接 / ${payload.folders.length} 个文件夹。`,
        syncedAt: payload.syncedAt,
        counts: { connections: payload.connections.length, folders: payload.folders.length },
      };
    }
    await giteeUpdate(cfg.token, cfg.gistId, blob);
    const d = readDiskConfig();
    d.syncedAt = payload.syncedAt;
    writeDiskConfig(d);
    logger.info(`已推送到同步 gist：${cfg.gistId}`);
    return {
      ok: true,
      message: `已推送 ${payload.connections.length} 个连接 / ${payload.folders.length} 个文件夹。`,
      syncedAt: payload.syncedAt,
      counts: { connections: payload.connections.length, folders: payload.folders.length },
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** 从 Gitee 拉取并合并到本地 */
export async function pullSync(tokenOverride?: string, passOverride?: string): Promise<SyncResult> {
  const cfg = resolveConfig(tokenOverride, passOverride);
  if (!cfg.token) return { ok: false, message: '未配置 Gitee 私人令牌，请先在「同步」页填写并保存。' };
  if (!cfg.gistId) return { ok: false, message: '尚未初始化同步点（请先推送一次以创建 gist）。' };
  if (!cfg.passphrase) return { ok: false, message: '未配置同步口令，无法解密云上内容。' };

  try {
    const blob = await giteeGet(cfg.token, cfg.gistId);
    let payload: SyncPayload;
    try {
      payload = JSON.parse(decryptPayload(blob, cfg.passphrase)) as SyncPayload;
    } catch {
      return { ok: false, message: '解密失败：同步口令与云上内容不匹配，或内容已损坏。' };
    }
    if (payload.app !== APP_TAG) return { ok: false, message: 'gist 内容不属于 DbNest，已拒绝导入。' };

    // 合并写回（连接按 id 覆盖；凭据经 saveConnection 重新加密落盘）
    for (const c of payload.connections) saveConnection(c);
    saveFolders(payload.folders ?? []);
    saveAiSettings(payload.aiSettings ?? { enabled: false, models: [] });
    saveGeneralPrefs(payload.prefs ?? (await loadGeneralPrefs()));

    const d = readDiskConfig();
    d.syncedAt = new Date().toISOString();
    writeDiskConfig(d);
    logger.info(`已从 gist 拉取并合并：${payload.connections.length} 个连接`);
    return {
      ok: true,
      message: `已拉取并合并 ${payload.connections.length} 个连接 / ${payload.folders?.length ?? 0} 个文件夹。`,
      syncedAt: d.syncedAt,
      counts: { connections: payload.connections.length, folders: payload.folders?.length ?? 0 },
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
