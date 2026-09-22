/**
 * 跨进程共享类型定义（单一来源）。
 *
 * 这些类型同时被 Electron 主进程、预加载脚本与 React 渲染进程引用，
 * 保证 IPC 通信两端类型一致，避免运行期数据结构漂移。
 *
 * 设计原则：
 * - 凭据（password / privateKey / passphrase / apiKey）仅在主进程内存中存在，
 *   由 `electron.safeStorage` 加密落盘，永不以明文经 IPC 传给渲染进程。
 * - 渲染进程只拿到「脱敏」后的连接元信息（见 `ConnectionSummary`）。
 *
 * @since 0.1.0
 */

/** 连接类型枚举 */
export type ConnectionKind = 'ssh' | 'mysql' | 'postgres' | 'redis' | 'bastion';

/** 认证方式 */
export type AuthType = 'password' | 'privateKey';

/** 连接在线状态（运行时，由主进程客户端管理器维护） */
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

/** 环境分组（用于左侧连接树归类） */
export type EnvironmentTag = 'prod' | 'staging' | 'dev' | 'bastion';

/**
 * 连接配置（持久化对象）。
 *
 * 凭据字段（password / privateKey / passphrase）在「保存」时由主进程加密，
 * 「加载」时解密回内存；经 IPC 暴露给渲染端的是脱敏后的 {@link ConnectionSummary}。
 */
export interface ConnectionConfig {
  /** 唯一 ID（保存时由主进程生成，若为空则新建） */
  id: string;
  /** 展示名称 */
  name: string;
  /** 连接类型 */
  kind: ConnectionKind;
  /** 主机地址 */
  host: string;
  /** 端口 */
  port: number;
  /** 登录用户名 */
  username: string;
  /** 认证方式（默认口令） */
  authType?: AuthType;
  /** 登录口令（仅主进程内存；落盘加密） */
  password?: string;
  /** 私钥内容（PEM 文本；仅主进程内存；落盘加密） */
  privateKey?: string;
  /** 私钥口令（仅主进程内存；落盘加密） */
  passphrase?: string;
  /** 目标数据库名（mysql / postgres 用） */
  database?: string;
  /** 环境标签 */
  environment: EnvironmentTag;
  /** 连接分组（UI 树节点） */
  group?: string;
  /** 是否启用 SSH 跳板隧道（mysql/postgres/redis 经 ssh 端口转发） */
  useTunnel?: boolean;
  /** 跳板机连接 ID（引用 ConnectionConfig.id，指向一条 kind=ssh 的连接） */
  tunnelId?: string;
  /** 备注 */
  remark?: string;
}

/**
 * 脱敏后的连接摘要（渲染端可见）。
 * 不含任何凭据字段，避免敏感信息泄露到渲染进程。
 */
export interface ConnectionSummary {
  id: string;
  name: string;
  kind: ConnectionKind;
  host: string;
  port: number;
  username: string;
  environment: EnvironmentTag;
  group?: string;
  useTunnel?: boolean;
  tunnelId?: string;
  remark?: string;
  /** 运行时状态（主进程推送，未连接时为 disconnected） */
  status: ConnectionStatus;
}

/** SFTP 文件节点类型 */
export type FileNodeType = 'file' | 'dir';

/** SFTP 文件/目录条目 */
export interface FileNode {
  /** 绝对路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 节点类型 */
  type: FileNodeType;
  /** 字节大小 */
  size: number;
  /** 权限字符串，如 0755 / 0600 */
  mode: string;
  /** 最后修改时间（ISO 字符串） */
  modifiedAt: string;
}

/** 传输任务方向 */
export type TransferDirection = 'upload' | 'download';

/** 传输任务状态 */
export type TransferStatus = 'queued' | 'active' | 'done' | 'error' | 'paused';

/** 单个文件传输任务（渲染端展示用，不含本地流） */
export interface TransferTask {
  id: string;
  /** 远端路径 */
  remotePath: string;
  /** 本地路径 */
  localPath: string;
  /** 方向：上传/下载 */
  direction: TransferDirection;
  total: number;
  transferred: number;
  status: TransferStatus;
  /** 错误信息（status=error 时） */
  error?: string;
}

/** 传输进度事件（主进程 -> 渲染端，实时推送） */
export interface TransferProgress {
  id: string;
  transferred: number;
  total: number;
  status: TransferStatus;
  error?: string;
}

/** SQL 查询结果集 */
export interface QueryResult {
  /** 列定义 */
  columns: QueryColumn[];
  /** 行数据 */
  rows: Record<string, unknown>[];
  /** 影响/返回行数 */
  rowCount: number;
  /** 执行耗时（毫秒） */
  elapsedMs: number;
  /** 执行的 SQL（回显） */
  sql: string;
  /** 影响的行数（写操作） */
  affectedRows?: number;
}

/** 结果集列定义 */
export interface QueryColumn {
  name: string;
  /** 是否为主键（UI 显示钥匙图标） */
  primaryKey?: boolean;
  /** 是否可空 */
  nullable?: boolean;
  /** 数据类型（驱动提供） */
  dataType?: string;
}

/** 数据库对象浏览器字段（information_schema 真实内省） */
export interface DbColumn {
  /** 字段名 */
  name: string;
  /** 数据类型 */
  dataType: string;
  /** 是否可空 */
  nullable: boolean;
  /** 键类型：PRI / UNI / MUL（MySQL）；PG 通常为空 */
  key?: string;
  /** 列序号（表内第几列，从 1 起） */
  ordinal?: number;
  /** 完整类型定义（MySQL column_type，如 varchar(255)；PG 含长度） */
  fullType?: string;
  /** 默认值表达式（CURRENT_TIMESTAMP / nextval(...) 等） */
  defaultValue?: string;
  /** 额外属性（MySQL extra，如 auto_increment） */
  extra?: string;
  /** 列注释（MySQL column_comment / PG pg_description） */
  comment?: string;
}

/** Redis 键值条目（带类型，真实 type 命令返回） */
export interface RedisEntry {
  key: string;
  /** Redis 类型：string / hash / list / set / zset / stream / none */
  type: string;
  /** 概要值（用于列表预览，真实读取） */
  preview?: string;
  /** 元素数量（hash/list/set/zset） */
  size?: number;
  /** TTL（秒，-1 永久，-2 不存在） */
  ttl?: number;
}

/** AI 消息角色 */
export type AiRole = 'user' | 'assistant';

/** AI 对话单条消息 */
export interface AiMessage {
  id: string;
  role: AiRole;
  content: string;
  /** 助手侧引用的上下文（文件/路径/SQL） */
  context?: string[];
  /** 时间戳 */
  ts: number;
}

/** AI 单个自定义模型配置（持久化；apiKey 加密落盘） */
export interface AiModelConfig {
  /** 模型配置唯一 ID */
  id: string;
  /** 展示名称，如「GPT-4o」「自建 Qwen-32B」 */
  name: string;
  /** 接口地址（OpenAI 兼容，含 /v1），如 https://api.openai.com/v1 或自建网关 */
  baseURL: string;
  /** 模型 ID，如 gpt-4o-mini / qwen2.5-32b-instruct */
  model: string;
  /** API Key（仅主进程内存；落盘加密） */
  apiKey: string;
  /** 是否默认（AI 对话默认使用该模型；列表中至多一个为 true） */
  isDefault: boolean;
}

/** AI 设置（持久化；每条模型的 apiKey 单独加密落盘） */
export interface AiSettings {
  /** 是否启用 AI 功能 */
  enabled: boolean;
  /** 自定义模型列表（可多条，类似 WorkBuddy 的「增加自定义模型」） */
  models: AiModelConfig[];
}

/** 终端着色方案（配色下拉选项） */
export type ThemeName = 'darcula' | 'dracula' | 'nord' | 'monokai' | 'gruvbox';

/**
 * 通用偏好（主进程持久化，设置表单即时生效）。
 *
 * 渲染端修改后通过 `PREFS_SET` 写回；终端字号、默认模型等被 UI 直接消费。
 * 敏感字段不存在于此（凭据一律走连接配置加密存储）。
 */
export interface GeneralPrefs {
  /** 默认终端类型（ssh 会话协议） */
  defaultShell: 'bash' | 'zsh' | 'sh' | 'powershell';
  /** 启动时是否确认连接会话 */
  confirmOnStartup: boolean;
  /** 默认 SFTP 根目录（SSH/SFTP 会话初始路径） */
  defaultSftpDir: string;
  /** 默认命令目录（终端启动时 cd 到） */
  defaultCmdDir: string;
  /** 终端字体大小（px） */
  fontSize: number;
  /** 配色方案 */
  theme: ThemeName;
  /** 默认 AI 模型 ID（引用 AiModelConfig.id；空则用模型列表中的 isDefault） */
  defaultModelId: string;
  /** 自动保存间隔（秒；0 = 关闭） */
  autoSaveIntervalSec: number;
  /** 会话保留时长（分钟；0 = 关闭即清除） */
  sessionRetentionMin: number;
}

/** 通用偏好默认值 */
export const DEFAULT_PREFS: GeneralPrefs = {
  defaultShell: 'bash',
  confirmOnStartup: true,
  defaultSftpDir: '/root',
  defaultCmdDir: '/',
  fontSize: 14,
  theme: 'darcula',
  defaultModelId: '',
  autoSaveIntervalSec: 30,
  sessionRetentionMin: 0,
};

/**
 * SSH 二次验证请求（keyboard-interactive，如 TOTP / 动态令牌）。
 *
 * 当远端 sshd 启用多因子认证（如 PAM + Google Authenticator），ssh2 在握手阶段
 * 触发 `keyboard-interactive` 事件，主进程把一组提示转发给渲染端弹窗，用户填写后回传。
 * 凭据只在主进程内存存在，动态码不落盘（与 Termius / VS Code 行为一致）。
 */
export interface SshInputRequest {
  /** 请求唯一 ID（渲染端回传时用它对应 pending） */
  requestId: string;
  /** 连接 ID */
  connectionId: string;
  /** 连接展示名（弹窗标题用） */
  connectionName: string;
  /** 服务端认证名称（可能为空），如 'Password authentication' */
  name: string;
  /** 服务端下发说明（可能为空），如「请输入 Authenticator 中的 6 位动态码」 */
  instructions: string;
  /** 一组输入提示（2FA 通常 1 个动态码；也可能先密码后动态码共 2 个） */
  prompts: Array<{ prompt: string; echo: boolean }>;
}

/** 连接树自定义文件夹（持久化；连接通过 group 字段归属某个文件夹名） */
export interface ConnectionFolder {
  /** 文件夹唯一 ID */
  id: string;
  /** 文件夹名（同名为同一文件夹；连接的 group 字段存此名称） */
  name: string;
  /**
   * 所属侧栏作用域：SSH 连接树 / 数据库树各自独立，互不串门。
   * - 'ssh'：SSH / 堡垒机侧栏的文件夹；
   * - 'db'：数据库侧栏的文件夹。
   * 历史遗留无 scope 的文件夹（scope 缺省）→ 归入 'ssh'，等价于旧版默认行为。
   */
  scope?: 'ssh' | 'db';
}

/** 取文件夹实际作用域（缺省按 'ssh' 处理） */
export function folderScope(f: ConnectionFolder): 'ssh' | 'db' {
  return f.scope ?? 'ssh';
}

/** 云同步配置（渲染端可见的部分；token / passphrase 等敏感字段不传出渲染进程） */
export interface SyncConfigView {
  /** 是否已配置 Gitee 私人令牌 */
  hasToken: boolean;
  /** 是否已配置同步加密口令 */
  hasPassphrase: boolean;
  /** 绑定的 Gitee gist id（空表示尚未初始化同步点） */
  gistId: string;
  /** 上次成功同步时间（ISO 字符串） */
  syncedAt?: string;
}

/** 云同步单次操作结果 */
export interface SyncResult {
  /** 是否成功 */
  ok: boolean;
  /** 结果说明（成功/失败原因） */
  message: string;
  /** 成功时返回本次同步时间 */
  syncedAt?: string;
  /** 成功时返回同步对象数量 */
  counts?: { connections: number; folders: number };
}

/** 统一应用错误（主进程抛出，渲染进程捕获） */
export interface AppErrorShape {
  code: string;
  message: string;
}

/** 结构对比：单表/对象的差异 */
export interface SchemaDiffItem {
  /** 对象名（表/视图） */
  name: string;
  /** 是否存在于左库 */
  inLeft: boolean;
  /** 是否存在于右库 */
  inRight: boolean;
  /** 差异说明（列增删改、类型变化等） */
  changes: string[];
}

/** 结构对比结果 */
export interface SchemaDiffResult {
  items: SchemaDiffItem[];
}
