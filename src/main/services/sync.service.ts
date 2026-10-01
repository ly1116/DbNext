import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { AiSettings, ConnectionConfig, ConnectionFolder, GeneralPrefs, SyncConfigView, SyncResult } from '@shared/types';
import { createLogger } from '../logger';
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
 * - 同步载体 = 一个**私有** Gitee gist（`dataroost-sync.json` 单文件）；
 * - 同步内容（连接含明文凭据、文件夹、AI 模型与 Key、通用偏好 / 主题）整体以
 *   **明文 JSON** 写入 gist —— 不做任何加密，跨机直接读取还原；
 * - Gitee 私人令牌（token）明文落盘于 userData/sync-config.json，渲染端只拿到布尔标记；
 * - 推送：本地整库打包为 JSON → 新建/更新 gist；拉取：读 gist → 合并写回本地。
 *
 * 安全说明：按需求「不加密、明文同步」，gist 与本地配置均为明文，含数据库口令等凭据。
 * 请仅用**私有** gist，且 Gitee 令牌仅授予 gists 权限；跨机恢复只需同一令牌。
 *
 * @since 0.1.0
 */
const logger = createLogger('sync');

const GITEE_API = 'https://gitee.com/api/v5/gists';
const FILE_NAME = 'dataroost-sync.json';
const APP_TAG = 'dataroost';

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

/** 磁盘配置（明文：token 直接落盘，不做加密） */
interface DiskConfig {
  token: string;
  gistId: string;
  syncedAt?: string;
}

// ——— 配置持久化（明文同步：令牌仅落盘为明文，不做加密）———

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readDiskConfig(): DiskConfig {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) return { token: '', gistId: '' };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Partial<DiskConfig>;
    return { token: raw.token ?? '', gistId: raw.gistId ?? '', syncedAt: raw.syncedAt };
  } catch {
    return { token: '', gistId: '' };
  }
}

function writeDiskConfig(c: DiskConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf-8');
}

/** 内存配置（仅主进程） */
interface ResolvedConfig {
  token: string;
  gistId: string;
  syncedAt?: string;
}

function resolveConfig(tokenOverride?: string): ResolvedConfig {
  const d = readDiskConfig();
  return {
    token: tokenOverride && tokenOverride.length ? tokenOverride : d.token,
    gistId: d.gistId,
    syncedAt: d.syncedAt,
  };
}

// ——— 对外：渲染端可见的配置视图（绝不回传 token 明文）———

/** 读取同步配置视图（令牌仅以布尔标记） */
export function getSyncConfig(): SyncConfigView {
  const d = readDiskConfig();
  return {
    hasToken: !!d.token,
    gistId: d.gistId,
    syncedAt: d.syncedAt,
  };
}

/**
 * 保存配置。空字符串表示「沿用已存值」。
 * @returns 更新后的视图
 */
export function setSyncConfig(token: string, gistId?: string): SyncConfigView {
  const d = readDiskConfig();
  if (token && token.length) d.token = token;
  if (gistId && gistId.length) d.gistId = gistId.trim();
  writeDiskConfig(d);
  logger.info('已保存云同步配置（Gitee 令牌明文落盘）');
  return getSyncConfig();
}

// ——— Gitee HTTP ———

async function giteeCreate(token: string, content: string): Promise<string> {
  const url = `${GITEE_API}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: 'DataRoost 同步配置（请勿手动编辑）',
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
      description: 'DataRoost 同步配置（请勿手动编辑）',
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
export async function pushSync(tokenOverride?: string): Promise<SyncResult> {
  const cfg = resolveConfig(tokenOverride);
  if (!cfg.token) return { ok: false, message: '未配置 Gitee 私人令牌，请先在「同步」页填写并保存。' };

  const payload: SyncPayload = {
    app: APP_TAG,
    version: 1,
    syncedAt: new Date().toISOString(),
    connections: getAllConnectionsRaw(),
    folders: loadFolders(),
    aiSettings: loadAiSettings(),
    prefs: loadGeneralPrefs(),
  };
  const blob = JSON.stringify(payload);

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
export async function pullSync(tokenOverride?: string): Promise<SyncResult> {
  const cfg = resolveConfig(tokenOverride);
  if (!cfg.token) return { ok: false, message: '未配置 Gitee 私人令牌，请先在「同步」页填写并保存。' };
  if (!cfg.gistId) return { ok: false, message: '尚未初始化同步点（请先推送一次以创建 gist）。' };

  try {
    const blob = await giteeGet(cfg.token, cfg.gistId);
    let payload: SyncPayload;
    try {
      payload = JSON.parse(blob) as SyncPayload;
    } catch {
      return { ok: false, message: '解析失败：云上同步内容不是合法 JSON，或内容已损坏。' };
    }
    if (payload.app !== APP_TAG) return { ok: false, message: 'gist 内容不属于 DataRoost，已拒绝导入。' };

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
