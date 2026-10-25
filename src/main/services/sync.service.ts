import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs';
import type {
  AiSettings,
  ConnectionConfig,
  ConnectionFolder,
  GeneralPrefs,
  SyncAutoPush,
  SyncConfigView,
  SyncResult,
} from '@shared/types';
import { IPC } from '@shared/ipc-channels';
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
 * 云同步服务（基于 Gitee 代码片段 / gist，**分片段**存储）。
 *
 * 设计要点：
 * - 同步内容按域拆成**多个私有 gist 片段**：
 *   1. 连接与文件夹（主片段，含 sync-index 文件记录其它片段 id）；
 *   2. 通用偏好 / 主题设置；
 *   3. AI 模型与 Key 设置。
 * - 各域内容以**明文 JSON** 写入对应 gist —— 不做任何加密，跨机直接读取还原；
 * - 主片段额外带 `sync-index.json` 文件记录其余片段 id：换机恢复只需同一令牌 + 主片段 ID；
 * - 自动同步：定时上传（30m / 1h）、本地改动立即上传（监听配置文件变化防抖）、启动时自动拉取。
 *
 * 安全说明：按需求「不加密、明文同步」，gist 与本地配置均为明文，含数据库口令等凭据。
 * 请仅用**私有** gist，且 Gitee 令牌仅授予 gists 权限。
 *
 * @since 0.1.0
 */
const logger = createLogger('sync');

const GITEE_API = 'https://gitee.com/api/v5/gists';
/** 主片段文件：连接与文件夹 */
const CONN_FILE_NAME = 'connections.json';
/** 主片段索引文件：记录其余片段 id（换机恢复入口） */
const INDEX_FILE_NAME = 'sync-index.json';
/** 偏好 / AI 片段文件名 */
const PREFS_FILE_NAME = 'prefs.json';
const AI_FILE_NAME = 'ai-settings.json';
/** 旧版单片段整包文件名（拉取时向后兼容） */
const LEGACY_FILE_NAME = 'dataroost-sync.json';
const APP_TAG = 'dataroost';

const DATA_DIR = app.getPath('userData');
const CONFIG_FILE = join(DATA_DIR, 'sync-config.json');

/** 本地配置文件（改动即传模式监听这些文件） */
const WATCH_FILES = ['connections.json', 'folders.json', 'general-prefs.json', 'ai-settings.json'];

/** 旧版单 gist 整包载荷（向后兼容读取） */
interface LegacyPayload {
  app: string;
  connections: ConnectionConfig[];
  folders: ConnectionFolder[];
  aiSettings: AiSettings;
  prefs: GeneralPrefs;
}

/** 磁盘配置（明文：token 直接落盘，不做加密） */
interface DiskConfig {
  token: string;
  /** 主片段（连接与文件夹）gist id；兼容旧版单片段整包 gist */
  gistId: string;
  prefsGistId?: string;
  aiGistId?: string;
  autoPush?: SyncAutoPush;
  pullOnStartup?: boolean;
  syncedAt?: string;
}

// ——— 配置持久化（明文同步：令牌仅落盘为明文，不做加密）———

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function readDiskConfig(): DiskConfig {
  ensureDir();
  if (!existsSync(CONFIG_FILE)) return { token: '', gistId: '', autoPush: 'off', pullOnStartup: false };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Partial<DiskConfig>;
    return {
      token: raw.token ?? '',
      gistId: raw.gistId ?? '',
      prefsGistId: raw.prefsGistId ?? '',
      aiGistId: raw.aiGistId ?? '',
      autoPush: raw.autoPush ?? 'off',
      pullOnStartup: raw.pullOnStartup ?? false,
      syncedAt: raw.syncedAt,
    };
  } catch {
    return { token: '', gistId: '', autoPush: 'off', pullOnStartup: false };
  }
}

function writeDiskConfig(c: DiskConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf-8');
}

function resolveConfig(tokenOverride?: string): DiskConfig {
  const d = readDiskConfig();
  if (tokenOverride && tokenOverride.length) d.token = tokenOverride;
  return d;
}

// ——— 对外：渲染端可见的配置视图（绝不回传 token 明文）———

/** 读取同步配置视图（令牌仅以布尔标记） */
export function getSyncConfig(): SyncConfigView {
  const d = readDiskConfig();
  return {
    hasToken: !!d.token,
    gistId: d.gistId,
    gistIds: { connections: d.gistId, prefs: d.prefsGistId ?? '', ai: d.aiGistId ?? '' },
    autoPush: d.autoPush ?? 'off',
    pullOnStartup: d.pullOnStartup ?? false,
    syncedAt: d.syncedAt,
  };
}

/**
 * 保存配置。token / gistId 空字符串表示「沿用已存值」；autoPush / pullOnStartup 总是覆盖。
 * @returns 更新后的视图
 */
export function setSyncConfig(
  token: string,
  gistId?: string,
  autoPush?: SyncAutoPush,
  pullOnStartup?: boolean,
): SyncConfigView {
  const d = readDiskConfig();
  if (token && token.length) d.token = token;
  if (gistId && gistId.length) d.gistId = gistId.trim();
  if (autoPush) d.autoPush = autoPush;
  if (typeof pullOnStartup === 'boolean') d.pullOnStartup = pullOnStartup;
  writeDiskConfig(d);
  logger.info(`已保存云同步配置（autoPush=${d.autoPush}, pullOnStartup=${d.pullOnStartup}）`);
  applyAutoPush();
  return getSyncConfig();
}

/**
 * 重置本机同步配置：清空令牌 / 片段 ID / 同步时间，回到未配置状态。
 * 只影响本机（不删除云端 gist）；用于 gist 失效（404 等）或换号后重新初始化。
 * @returns 重置后的视图
 */
export function resetSyncConfig(): SyncConfigView {
  writeDiskConfig({ token: '', gistId: '', autoPush: 'off', pullOnStartup: false });
  applyAutoPush();
  logger.info('已重置云同步配置（令牌/片段 ID 已清空）');
  return getSyncConfig();
}

// ——— Gitee HTTP（多文件：一个 gist 可承载多个文件）———

type GiteeFiles = Record<string, { content: string }>;

async function giteeCreate(token: string, files: GiteeFiles, description: string): Promise<string> {
  const url = `${GITEE_API}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, public: false, files }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`创建 Gitee gist 失败（${res.status}）：${text.slice(0, 300) || res.statusText}`);
  }
  const data = (await res.json()) as { id: string };
  if (!data.id) throw new Error('创建 Gitee gist 成功但未返回 id');
  return data.id;
}

async function giteeUpdate(token: string, gistId: string, files: GiteeFiles, description: string): Promise<void> {
  const url = `${GITEE_API}/${encodeURIComponent(gistId)}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, files }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`更新 Gitee gist 失败（${res.status}）：${text.slice(0, 300) || res.statusText}`);
  }
}

async function giteeGetFiles(token: string, gistId: string): Promise<Record<string, string>> {
  const url = `${GITEE_API}/${encodeURIComponent(gistId)}?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Authorization: `token ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`读取 Gitee gist 失败（${res.status}）：${text.slice(0, 300) || res.statusText}`);
  }
  const data = (await res.json()) as { files?: Record<string, { content?: string }> };
  const out: Record<string, string> = {};
  for (const [name, f] of Object.entries(data.files ?? {})) {
    if (f?.content != null) out[name] = f.content;
  }
  return out;
}

// ——— 内部：各域打包 ———

function connectionsBlob(): string {
  return JSON.stringify({
    app: APP_TAG,
    version: 2,
    syncedAt: new Date().toISOString(),
    connections: getAllConnectionsRaw(),
    folders: loadFolders(),
  });
}

function prefsBlob(): string {
  return JSON.stringify({ app: APP_TAG, version: 2, syncedAt: new Date().toISOString(), prefs: loadGeneralPrefs() });
}

function aiBlob(): string {
  return JSON.stringify({ app: APP_TAG, version: 2, syncedAt: new Date().toISOString(), aiSettings: loadAiSettings() });
}

/** 创建或更新一个域的 gist；返回 gist id */
async function upsertGist(
  token: string,
  gistId: string,
  fileName: string,
  content: string,
  description: string,
): Promise<string> {
  if (gistId) {
    await giteeUpdate(token, gistId, { [fileName]: { content } }, description);
    return gistId;
  }
  return giteeCreate(token, { [fileName]: { content } }, description);
}

// ——— 对外：推送 / 拉取 ———

/** 推送本地到 Gitee（按域分片段；无片段则自动创建） */
export async function pushSync(tokenOverride?: string): Promise<SyncResult> {
  const cfg = resolveConfig(tokenOverride);
  if (!cfg.token) return { ok: false, message: '未配置 Gitee 私人令牌，请先在「同步」页填写并保存。' };

  const now = new Date().toISOString();
  try {
    // 1. 主片段：连接与文件夹 + sync-index（记录其余片段 id，换机恢复入口）
    const indexContent = JSON.stringify({
      app: APP_TAG,
      prefsGistId: cfg.prefsGistId ?? '',
      aiGistId: cfg.aiGistId ?? '',
    });
    const connFiles: GiteeFiles = { [CONN_FILE_NAME]: { content: connectionsBlob() } };
    if (cfg.gistId) {
      // 已有主片段：更新连接文件 + 索引文件
      await giteeUpdate(cfg.token, cfg.gistId, { ...connFiles, [INDEX_FILE_NAME]: { content: indexContent } }, 'DataRoost 同步片段：连接与文件夹（请勿手动编辑）');
    } else {
      connFiles[INDEX_FILE_NAME] = { content: indexContent };
      cfg.gistId = await giteeCreate(cfg.token, connFiles, 'DataRoost 同步片段：连接与文件夹（请勿手动编辑）');
    }

    // 2. 偏好 / 主题片段
    cfg.prefsGistId = await upsertGist(cfg.token, cfg.prefsGistId ?? '', PREFS_FILE_NAME, prefsBlob(), 'DataRoost 同步片段：主题与偏好设置（请勿手动编辑）');
    // 3. AI 设置片段
    cfg.aiGistId = await upsertGist(cfg.token, cfg.aiGistId ?? '', AI_FILE_NAME, aiBlob(), 'DataRoost 同步片段：AI 设置（请勿手动编辑）');

    cfg.syncedAt = now;
    writeDiskConfig(cfg);
    const n = getAllConnectionsRaw().length;
    logger.info(`已推送同步片段：主=${cfg.gistId} prefs=${cfg.prefsGistId} ai=${cfg.aiGistId}`);
    return {
      ok: true,
      message: `已推送 ${n} 个连接 / ${loadFolders().length} 个文件夹 / 主题偏好 / AI 设置（3 个片段）。`,
      syncedAt: now,
      counts: { connections: n, folders: loadFolders().length },
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** 合并旧版整包载荷（兼容 v1 单片段格式） */
function mergeLegacyPayload(payload: LegacyPayload): void {
  for (const c of payload.connections ?? []) saveConnection(c);
  saveFolders(payload.folders ?? []);
  if (payload.prefs) saveGeneralPrefs(payload.prefs);
  if (payload.aiSettings) saveAiSettings(payload.aiSettings);
}

/** 从 Gitee 拉取并合并到本地（逐片段拉取；兼容旧版单片段整包） */
export async function pullSync(tokenOverride?: string): Promise<SyncResult> {
  const cfg = resolveConfig(tokenOverride);
  if (!cfg.token) return { ok: false, message: '未配置 Gitee 私人令牌，请先在「同步」页填写并保存。' };
  if (!cfg.gistId) return { ok: false, message: '尚未初始化同步点（请先推送一次以创建片段）。' };

  const parts: string[] = [];
  try {
    // 1. 主片段：连接与文件夹 + 索引
    const files = await giteeGetFiles(cfg.token, cfg.gistId);
    if (files[CONN_FILE_NAME]) {
      const payload = JSON.parse(files[CONN_FILE_NAME]) as { app: string; connections: ConnectionConfig[]; folders: ConnectionFolder[] };
      if (payload.app !== APP_TAG) return { ok: false, message: '片段内容不属于 DataRoost，已拒绝导入。' };
      for (const c of payload.connections ?? []) saveConnection(c);
      saveFolders(payload.folders ?? []);
      parts.push(`${payload.connections?.length ?? 0} 个连接`);
    } else if (files[LEGACY_FILE_NAME]) {
      // 旧版单片段整包：整体合并，下次推送自动升级为分片格式
      const legacy = JSON.parse(files[LEGACY_FILE_NAME]) as LegacyPayload;
      if (legacy.app !== APP_TAG) return { ok: false, message: '片段内容不属于 DataRoost，已拒绝导入。' };
      mergeLegacyPayload(legacy);
      parts.push(`旧版整包（${legacy.connections?.length ?? 0} 个连接）`);
    } else {
      return { ok: false, message: '主片段中未找到连接数据（ gist 内容可能已被改动）。' };
    }

    // 2. 索引补全本地片段 id（他机恢复场景：本地只有主片段 id）
    if (files[INDEX_FILE_NAME]) {
      try {
        const idx = JSON.parse(files[INDEX_FILE_NAME]) as { prefsGistId?: string; aiGistId?: string };
        if (!cfg.prefsGistId && idx.prefsGistId) cfg.prefsGistId = idx.prefsGistId;
        if (!cfg.aiGistId && idx.aiGistId) cfg.aiGistId = idx.aiGistId;
      } catch {
        /* 索引损坏不影响主数据 */
      }
    }

    // 3. 偏好 / 主题片段
    if (cfg.prefsGistId) {
      const pf = await giteeGetFiles(cfg.token, cfg.prefsGistId);
      if (pf[PREFS_FILE_NAME]) {
        const payload = JSON.parse(pf[PREFS_FILE_NAME]) as { app: string; prefs: GeneralPrefs };
        if (payload.app === APP_TAG && payload.prefs) {
          saveGeneralPrefs(payload.prefs);
          parts.push('主题偏好');
        }
      }
    }
    // 4. AI 设置片段
    if (cfg.aiGistId) {
      const af = await giteeGetFiles(cfg.token, cfg.aiGistId);
      if (af[AI_FILE_NAME]) {
        const payload = JSON.parse(af[AI_FILE_NAME]) as { app: string; aiSettings: AiSettings };
        if (payload.app === APP_TAG && payload.aiSettings) {
          saveAiSettings(payload.aiSettings);
          parts.push('AI 设置');
        }
      }
    }

    cfg.syncedAt = new Date().toISOString();
    writeDiskConfig(cfg);
    logger.info(`已从片段拉取并合并：${parts.join(' / ')}`);
    return {
      ok: true,
      message: `已拉取并合并：${parts.join(' / ')}。`,
      syncedAt: cfg.syncedAt,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ——— 自动同步（定时上传 / 改动即传 / 启动拉取）———

let pushTimer: ReturnType<typeof setInterval> | null = null;
let changeWatchers: FSWatcher[] = [];
let changeDebounce: ReturnType<typeof setTimeout> | null = null;
let autoRunning = false;

/** 自动推送（防抖 + 防重入）：任何触发源统一走这里 */
function scheduleAutoPush(delayMs: number): void {
  if (changeDebounce) clearTimeout(changeDebounce);
  changeDebounce = setTimeout(() => {
    changeDebounce = null;
    if (autoRunning) return;
    autoRunning = true;
    void pushSync()
      .then((r) => logger.info(`自动上传：${r.ok ? r.message : r.message}`))
      .catch((e) => logger.warn(`自动上传异常：${(e as Error).message}`))
      .finally(() => {
        autoRunning = false;
      });
  }, delayMs);
}

/** 广播同步结果到所有窗口（渲染端据此刷新连接与偏好） */
function broadcast(result: SyncResult): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.SYNC_CHANGED, result);
  }
}

/**
 * 应用/重设自动同步（配置保存或启动时调用）：
 * - 定时上传：off 清理 / 30m / 1h 周期 pushSync；
 * - 改动即传：watch 本地配置文件（8s 防抖）；
 * - 启动拉取：仅由 startAutoSync 触发一次。
 */
export function applyAutoPush(): void {
  const cfg = readDiskConfig();
  // 清理旧状态
  if (pushTimer) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
  for (const w of changeWatchers) {
    try {
      w.close();
    } catch {
      /* 已关闭 */
    }
  }
  changeWatchers = [];
  if (!cfg.token) return;

  if (cfg.autoPush === '30m' || cfg.autoPush === '1h') {
    const ms = cfg.autoPush === '30m' ? 30 * 60_000 : 60 * 60_000;
    pushTimer = setInterval(() => scheduleAutoPush(0), ms);
    logger.info(`自动上传已启用：每 ${cfg.autoPush === '30m' ? '30 分钟' : '1 小时'}`);
  } else if (cfg.autoPush === 'onChange') {
    for (const name of WATCH_FILES) {
      const full = join(DATA_DIR, name);
      if (!existsSync(full)) continue;
      try {
        const w = watch(full, () => scheduleAutoPush(8_000));
        changeWatchers.push(w);
      } catch (e) {
        logger.warn(`监听 ${name} 失败：${(e as Error).message}`);
      }
    }
    logger.info('自动上传已启用：本地改动立即上传（8 秒防抖）');
  }
}

/** 应用启动时调用：按配置拉起自动同步 + 可选的启动拉取 */
export function startAutoSync(): void {
  const cfg = readDiskConfig();
  applyAutoPush();
  if (cfg.token && cfg.gistId && cfg.pullOnStartup) {
    // 延迟数秒：等窗口与连接初始化完成，避免启动瞬时网络请求堆积
    setTimeout(() => {
      void pullSync()
        .then((r) => {
          logger.info(`启动自动拉取：${r.message}`);
          if (r.ok) broadcast(r);
        })
        .catch((e) => logger.warn(`启动自动拉取异常：${(e as Error).message}`));
    }, 6_000);
  }
}
