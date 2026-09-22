/// <reference types="vite/client" />

/**
 * 渲染进程环境声明。
 * 声明 preload 注入的 `window.dbnest` 安全 API 白名单（真实实现，无 mock）。
 *
 * @since 0.1.0
 */
import type {
  AiMessage,
  AiSettings,
  ConnectionConfig,
  ConnectionFolder,
  ConnectionStatus,
  ConnectionSummary,
  DbColumn,
  FileNode,
  GeneralPrefs,
  QueryResult,
  RedisEntry,
  SchemaDiffResult,
  SshInputRequest,
  SyncConfigView,
  SyncResult,
  TransferProgress,
  TransferTask,
} from '@shared/types';

/** 渲染进程可见的主进程 API（经 contextBridge 暴露） */
export interface DbnestApi {
  /** 应用版本 */
  getVersion(): Promise<string>;
  /** 当前操作系统平台（darwin / win32 / linux，浏览器返回 'browser'） */
  getPlatform(): Promise<string>;
  /** 真实窗口控制：最小化 / 最大化-还原 / 关闭（自绘标题栏用） */
  windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  /** 连接列表（脱敏摘要，含运行时状态） */
  listConnections(): Promise<ConnectionSummary[]>;
  /** 保存连接（返回脱敏摘要） */
  saveConnection(cfg: ConnectionConfig): Promise<ConnectionSummary>;
  /** 删除连接 */
  deleteConnection(id: string): Promise<void>;
  /** 真实连通性测试 */
  testConnection(cfg: ConnectionConfig): Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  /** 建立真实连接 */
  connect(id: string): Promise<ConnectionSummary>;
  /** 断开连接 */
  disconnect(id: string): Promise<void>;
  /** 导出连接配置 profile（JSON 文本） */
  exportProfile(ids?: string[]): Promise<string>;
  /** 导入连接配置 profile */
  importProfile(json: string): Promise<ConnectionSummary[]>;

  /** 创建终端会话（真实 ssh2 shell） */
  terminalCreate(connectionId: string, opts?: { cols?: number; rows?: number; term?: string }): Promise<boolean>;
  /** 写入终端输入 */
  terminalWrite(connectionId: string, data: string): void;
  /** 改变终端尺寸 */
  terminalResize(connectionId: string, dims: { cols: number; rows: number }): void;
  /** 退出终端会话 */
  terminalExit(connectionId: string): void;
  /** 订阅终端输出（connectionId, data） */
  onTerminalData(cb: (connectionId: string, data: string) => void): () => void;

  /** SFTP 列目录 */
  listDir(connectionId: string, path: string): Promise<FileNode[]>;
  /** SFTP stat */
  stat(connectionId: string, path: string): Promise<FileNode>;
  /** SFTP 建目录 */
  mkdir(connectionId: string, path: string): Promise<void>;
  /** SFTP 删除 */
  remove(connectionId: string, path: string, recursive?: boolean): Promise<void>;
  /** SFTP 重命名 */
  rename(connectionId: string, oldPath: string, newPath: string): Promise<void>;
  /** SFTP 新建空文件（等价 touch） */
  touch(connectionId: string, path: string): Promise<void>;

  /** 上传文件 */
  upload(connectionId: string, localPath: string, remotePath: string): Promise<{ id: string; total: number }>;
  /** 下载文件 */
  download(connectionId: string, remotePath: string, localPath: string): Promise<{ id: string; total: number }>;
  /** 递归上传目录（自动逐级创建远端目录） */
  uploadDir(connectionId: string, localPath: string, remotePath: string): Promise<{ id: string; total: number }>;
  /** 递归下载目录 */
  downloadDir(connectionId: string, remotePath: string, localPath: string): Promise<{ id: string; total: number }>;
  /** 传输任务快照 */
  listTransfers(): Promise<TransferTask[]>;
  /** 订阅传输进度 */
  onTransferProgress(cb: (p: TransferProgress) => void): () => void;

  /** Redis key 列表（含类型/TTL） */
  redisKeys(connectionId: string, pattern: string): Promise<RedisEntry[]>;
  /** Redis 取值 */
  redisGet(connectionId: string, key: string): Promise<{ type: string; value: string }>;

  /** 执行 SQL（真实驱动） */
  runSql(connectionId: string, sql: string): Promise<QueryResult>;
  /** 列出数据库 */
  listDatabases(connectionId: string): Promise<string[]>;
  /** 新建数据库（数据库侧「创建目录」） */
  createDatabase(connectionId: string, name: string): Promise<void>;
  /** 列出表（可指定 database/schema） */
  listTables(connectionId: string, database?: string): Promise<string[]>;
  /** 列出表字段（真实 information_schema 内省；PG：schema=模式、db=库名可跨库） */
  listColumns(connectionId: string, schema: string, table: string, db?: string): Promise<DbColumn[]>;
  /** 预览表数据（PG：schema=模式、db=库名可跨库） */
  tableData(connectionId: string, schema: string | undefined, table: string, limit?: number, db?: string): Promise<QueryResult>;
  /** 列出库内模式（PG 专有层级：库 → 模式；MySQL 返回空数组；db 指定跨库目标） */
  listSchemas(connectionId: string, db?: string): Promise<string[]>;
  /** 按模式 + 类型列出对象（table/view/mview/sequence/function；db 指定跨库目标） */
  listObjects(connectionId: string, kind: 'table' | 'view' | 'mview' | 'sequence' | 'function', schema: string, db?: string): Promise<string[]>;

  /** 结构对比 */
  runDiff(leftId: string, rightId: string): Promise<SchemaDiffResult>;

  /** 读取 AI 设置（含模型列表） */
  getAiSettings(): Promise<AiSettings>;
  /** 保存 AI 设置（每条模型 apiKey 落盘前加密） */
  setAiSettings(s: AiSettings): Promise<AiSettings>;
  /** AI 流式对话；modelId 可选，不传则用默认模型。
   *  conn 传入当前 SSH 连接上下文时，AI 可调用工具在真实主机上执行命令。返回完整文本 */
  aiAsk(history: AiMessage[], context?: string[], modelId?: string, conn?: { id: string; label: string }): Promise<string>;
  /** 订阅 AI 增量 */
  onAiChunk(cb: (delta: string) => void): () => void;
  /** 订阅 AI 完成 */
  onAiDone(cb: () => void): () => void;

  /** 读取通用偏好（设置表单即时生效） */
  getGeneralPrefs(): Promise<GeneralPrefs>;
  /** 保存通用偏好 */
  setGeneralPrefs(p: GeneralPrefs): Promise<GeneralPrefs>;
  /** 读取连接树自定义文件夹 */
  getFolders(): Promise<ConnectionFolder[]>;
  /** 保存连接树自定义文件夹（全量覆盖） */
  setFolders(folders: ConnectionFolder[]): Promise<ConnectionFolder[]>;

  /** 读取云同步配置视图（敏感字段不回传） */
  getSyncConfig(): Promise<SyncConfigView>;
  /** 保存云同步配置（token / passphrase；空串表示沿用已存值） */
  setSyncConfig(token: string, passphrase: string): Promise<SyncConfigView>;
  /** 推送本地整库到 Gitee gist（可选覆盖 token/passphrase） */
  pushSync(token?: string, passphrase?: string): Promise<SyncResult>;
  /** 从 Gitee gist 拉取并合并到本地 */
  pullSync(token?: string, passphrase?: string): Promise<SyncResult>;

  /** 切换开发者工具 */
  toggleDevTools(): void;
  /** 订阅连接状态变化（id, status） */
  onConnectionStatus(cb: (id: string, status: ConnectionStatus) => void): () => void;
  /** 订阅窗口最大化状态变化（同步标题栏最大化/还原图标） */
  onMaximized(cb: (maximized: boolean) => void): () => void;

  /** 列出本地目录（真实 node:fs，用于 SFTP 本地栏 / 选择本地路径） */
  localList(dir: string): Promise<{ name: string; path: string; isDir: boolean; size: number; modifiedAt: string }[]>;
  /** 读取本地文本文件（云同步导入） */
  readFile(path: string): Promise<string>;
  /** 写入本地文本文件（云同步导出） */
  writeFile(path: string, content: string): Promise<void>;
  /** 系统文件选择对话框：kind=file|folder|save，返回选中路径或 null */
  openDialog(opts: { kind: 'file' | 'folder' | 'save'; title?: string; defaultPath?: string }): Promise<string | null>;
  /** 读取系统剪贴板文本（终端 Ctrl+V / 右键粘贴） */
  clipboardRead(): Promise<string>;
  /** 写入系统剪贴板文本（终端 Ctrl+C / 右键复制） */
  clipboardWrite(text: string): Promise<void>;
  /** 解析拖入 File 的本地绝对路径（Electron webUtils；浏览器预览返回空串） */
  pathForFile(file: File): string;

  /** 订阅 SSH 二次验证请求（keyboard-interactive / TOTP），收到后弹窗收集答案 */
  onSshInputRequest(cb: (req: SshInputRequest) => void): () => void;
  /** 回传二次验证答案（answers 为 null 表示取消 / 超时） */
  sshInputRespond(requestId: string, answers: string[] | null): Promise<void>;
}

declare global {
  interface Window {
    dbnest: DbnestApi;
  }
}
