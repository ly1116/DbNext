import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { AiSettings, ConnectionConfig, ConnectionFolder, ConnectionSummary, GeneralPrefs } from '@shared/types';
import { DEFAULT_PREFS } from '@shared/types';
import { createLogger } from '../logger';
import { isEncrypted, seal, unseal } from '../security/vault';

/**
 * 连接持久化存储（主进程侧）。
 *
 * 按「正常桌面软件」的方式把连接配置存到 OS 标准应用数据目录：
 *   Windows: %APPDATA%/DbNest/connections.json
 *   macOS:   ~/Library/Application Support/DbNest/connections.json
 *   Linux:   ~/.config/Dbnbest/connections.json
 *
 * 敏感字段（password / privateKey / passphrase）落盘前经 vault 加密，
 * 内存里是明文（仅主进程），渲染端只拿到脱敏后的 {@link ConnectionSummary}。
 *
 * @since 0.1.0
 */
const logger = createLogger('connection-store');

const DATA_DIR = app.getPath('userData');
const CONN_FILE = join(DATA_DIR, 'connections.json');
const AI_FILE = join(DATA_DIR, 'ai-settings.json');
const PREFS_FILE = join(DATA_DIR, 'general-prefs.json');
const FOLDERS_FILE = join(DATA_DIR, 'folders.json');

/** 内存中的全量连接（含明文凭据，仅主进程可见） */
const store = new Map<string, ConnectionConfig>();

/** 需要加密落盘的敏感字段 */
const SECRET_KEYS: (keyof ConnectionConfig)[] = ['password', 'privateKey', 'passphrase'];

/** 确保数据目录存在 */
function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

/** 读取磁盘上的连接记录（敏感字段为密文） */
function readDisk(): Record<string, unknown>[] {
  ensureDir();
  if (!existsSync(CONN_FILE)) return [];
  try {
    const raw = readFileSync(CONN_FILE, 'utf-8');
    const arr = JSON.parse(raw) as Record<string, unknown>[];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    logger.error(`读取连接文件失败: ${(err as Error).message}`);
    return [];
  }
}

/** 把内存中的连接写回磁盘（敏感字段加密） */
function flush(): void {
  ensureDir();
  const records = [...store.values()].map((cfg) => {
    const rec: Record<string, unknown> = { ...cfg };
    for (const k of SECRET_KEYS) {
      const v = rec[k] as string | undefined;
      if (v) rec[k] = seal(v);
    }
    return rec;
  });
  // 文件权限受限（Windows 下依赖 ACL，这里至少保证目录存在）
  writeFileSync(CONN_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

/** 初始化：从磁盘加载到内存（密文还原为明文） */
export function initConnectionStore(): void {
  const records = readDisk();
  for (const rec of records) {
    const cfg = rec as unknown as ConnectionConfig;
    for (const k of SECRET_KEYS) {
      const v = rec[k] as string | undefined;
      if (v) (cfg as unknown as Record<string, unknown>)[k] = unseal(v);
    }
    store.set(cfg.id, cfg);
  }
  logger.info(`已从磁盘加载 ${store.size} 个连接（加密存储=${isEncrypted()}）`);
}

/** 列出全部连接（脱敏，带运行时状态） */
export function listConnections(statusOf: (id: string) => ConnectionSummary['status']): ConnectionSummary[] {
  return [...store.values()].map((c) => summarize(c, statusOf(c.id)));
}

/** 取完整配置（主进程内部用，含明文凭据） */
export function getConnection(id: string): ConnectionConfig | undefined {
  return store.get(id);
}

/** 取全部连接完整配置（主进程内部用，含明文凭据；云同步打包整库时使用） */
export function getAllConnectionsRaw(): ConnectionConfig[] {
  return [...store.values()];
}

/** 保存（新增或更新）连接，返回脱敏摘要 */
export function saveConnection(cfg: ConnectionConfig): ConnectionSummary {
  const existing = cfg.id ? store.get(cfg.id) : undefined;
  const next: ConnectionConfig = { ...cfg };
  if (!next.id) next.id = `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 编辑既有连接时，若本次未重新填写口令/私钥/私钥口令，则沿用已存储的密文，
  // 避免「打开编辑」就清空凭据（凭据永不经渲染端明文往返）。
  if (existing) {
    for (const k of SECRET_KEYS) {
      const incoming = next[k] as string | undefined;
      if (!incoming) (next as unknown as Record<string, unknown>)[k] = existing[k];
    }
  }
  store.set(next.id, next);
  flush();
  logger.info(`保存连接: ${next.name} (${next.id})`);
  return summarize(next, 'disconnected');
}

/** 删除连接 */
export function deleteConnection(id: string): void {
  store.delete(id);
  flush();
  logger.info(`删除连接: ${id}`);
}

/** 脱敏为渲染端可见摘要 */
function summarize(c: ConnectionConfig, status: ConnectionSummary['status']): ConnectionSummary {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    host: c.host,
    port: c.port,
    username: c.username,
    environment: c.environment,
    group: c.group,
    useTunnel: c.useTunnel,
    tunnelId: c.tunnelId,
    remark: c.remark,
    status,
  };
}

// ——— AI 设置（独立文件；每条模型的 apiKey 单独加密）———

const DEFAULT_AI: AiSettings = {
  enabled: false,
  models: [],
};

/** 读取 AI 设置（每条模型的 apiKey 解密） */
export function loadAiSettings(): AiSettings {
  ensureDir();
  if (!existsSync(AI_FILE)) return { ...DEFAULT_AI };
  try {
    const raw = JSON.parse(readFileSync(AI_FILE, 'utf-8')) as Partial<AiSettings>;
    const models = (raw.models ?? []).map((m) => ({
      ...m,
      apiKey: m.apiKey ? unseal(m.apiKey) : '',
    }));
    return { ...DEFAULT_AI, ...raw, models };
  } catch {
    return { ...DEFAULT_AI };
  }
}

/** 保存 AI 设置（每条模型的 apiKey 加密落盘） */
export function saveAiSettings(s: AiSettings): void {
  ensureDir();
  const toWrite = {
    enabled: s.enabled,
    models: s.models.map((m) => ({ ...m, apiKey: m.apiKey ? seal(m.apiKey) : '' })),
  };
  writeFileSync(AI_FILE, JSON.stringify(toWrite, null, 2), 'utf-8');
}

// ——— 配置导出/导入（云同步的本地载体）———

/**
 * 导出连接配置为可移植的 profile JSON（敏感字段以密文形式随附）。
 * 说明：密文依赖本机 vault 密钥，跨机导入需同机；跨机迁移应走带口令的导出（后续扩展）。
 */
export function exportProfile(ids?: string[]): string {
  const all = [...store.values()];
  const picked = ids && ids.length ? all.filter((c) => ids.includes(c.id)) : all;
  const records = picked.map((cfg) => {
    const rec: Record<string, unknown> = { ...cfg };
    for (const k of SECRET_KEYS) {
      const v = rec[k] as string | undefined;
      if (v) rec[k] = seal(v);
    }
    return rec;
  });
  return JSON.stringify({ app: 'DbNest', version: 1, connections: records }, null, 2);
}

/** 导入 profile（合并；已存在同 id 则覆盖） */
export function importProfile(json: string): ConnectionSummary[] {
  const parsed = JSON.parse(json) as { connections?: Record<string, unknown>[] };
  const records = parsed.connections ?? [];
  for (const rec of records) {
    const cfg = rec as unknown as ConnectionConfig;
    for (const k of SECRET_KEYS) {
      const v = rec[k] as string | undefined;
      if (v) (cfg as unknown as Record<string, unknown>)[k] = unseal(v);
    }
    store.set(cfg.id, cfg);
  }
  flush();
  logger.info(`导入了 ${records.length} 个连接`);
  return listConnections(() => 'disconnected');
}

// ——— 通用偏好（plain 明文字段，直接读写）———

/** 读取通用偏好（缺字段用默认值补齐） */
export function loadGeneralPrefs(): GeneralPrefs {
  ensureDir();
  if (!existsSync(PREFS_FILE)) return { ...DEFAULT_PREFS };
  try {
    const raw = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')) as Partial<GeneralPrefs>;
    return { ...DEFAULT_PREFS, ...raw };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** 保存通用偏好 */
export function saveGeneralPrefs(p: GeneralPrefs): GeneralPrefs {
  ensureDir();
  writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2), 'utf-8');
  logger.info('已保存通用偏好');
  return p;
}

// ——— 连接树自定义文件夹（plain 明文，直接读写）———

/** 读取自定义文件夹列表 */
export function loadFolders(): ConnectionFolder[] {
  ensureDir();
  if (!existsSync(FOLDERS_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(FOLDERS_FILE, 'utf-8')) as unknown;
    return Array.isArray(raw) ? (raw as ConnectionFolder[]) : [];
  } catch {
    return [];
  }
}

/** 保存自定义文件夹列表（全量覆盖） */
export function saveFolders(folders: ConnectionFolder[]): ConnectionFolder[] {
  ensureDir();
  writeFileSync(FOLDERS_FILE, JSON.stringify(folders, null, 2), 'utf-8');
  logger.info(`已保存自定义文件夹（${folders.length} 个）`);
  return folders;
}
