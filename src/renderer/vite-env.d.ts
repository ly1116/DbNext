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
  DbColumnSpec,
  DbCreateOptions,
  DbCreateSpec,
  DbForeignKey,
  DbIndex,
  DbObjectDef,
  DbObjectMeta,
  DbSequenceInfo,
  DbTrigger,
  DbUser,
  DbUserPrivilege,
  DbUserPrivEdit,
  DbUserSpec,
  FileNode,
  GeneralPrefs,
  QueryResult,
  PagedSqlResult,
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
  /** Redis 按类型写回值（值编辑） */
  redisSet(connectionId: string, key: string, type: string, value: string): Promise<void>;
  /** Redis 删除 key */
  redisDel(connectionId: string, key: string): Promise<void>;
  /** Redis 重命名 key */
  redisRename(connectionId: string, key: string, newKey: string): Promise<void>;
  /** Redis 设置 TTL（秒；<0 = 永久） */
  redisExpire(connectionId: string, key: string, ttl: number): Promise<void>;
  /** Redis 切换数据库 */
  redisSelectDb(connectionId: string, dbIndex: number): Promise<void>;
  /** Redis 获取各 db 的 key 数量统计 */
  redisDbInfo(connectionId: string): Promise<Record<number, number>>;

  /** 执行 SQL（真实驱动） */
  runSql(connectionId: string, sql: string, db?: string): Promise<QueryResult>;
  /** SQL 分页执行（自动 COUNT 总数 + LIMIT/OFFSET 取当页） */
  runSqlPaged(connectionId: string, sql: string, offset: number, limit: number, db?: string): Promise<PagedSqlResult>;
  /** 拉取当前库/模式下所有表的列清单（SQL 编辑器智能提示数据源） */
  listSchemaColumns(connectionId: string, db?: string): Promise<Record<string, string[]>>;
  /** 列出数据库 */
  listDatabases(connectionId: string): Promise<string[]>;
  /** 新建数据库（方言化表单：MySQL=字符集/排序规则；PG=属主/编码/排序规则/模板/表空间/连接数上限） */
  createDatabase(connectionId: string, spec: DbCreateSpec): Promise<void>;
  /** 建库对话框下拉数据源（字符集/排序规则 or PG 角色/表空间/模板库/编码/排序规则清单） */
  dbCreateOptions(connectionId: string): Promise<DbCreateOptions>;
  /** 列出表（可指定 database/schema） */
  listTables(connectionId: string, database?: string): Promise<string[]>;
  /** 列出表字段（真实 information_schema 内省；PG：schema=模式、db=库名可跨库） */
  listColumns(connectionId: string, schema: string, table: string, db?: string): Promise<DbColumn[]>;
  /** 新增表字段（属性页「新增字段」→ ALTER TABLE ADD COLUMN；PG：schema=模式、db=库名可跨库） */
  addColumn(connectionId: string, schema: string | undefined, table: string, col: DbColumnSpec, db?: string): Promise<void>;
  /** 删除表字段（ALTER TABLE DROP COLUMN） */
  dropColumn(connectionId: string, schema: string | undefined, table: string, column: string, db?: string): Promise<void>;
  /** 列出表索引（表设计器「索引」子页） */
  listIndexes(connectionId: string, schema: string, table: string, db?: string): Promise<DbIndex[]>;
  /** 列出表外键（表设计器「外键」子页） */
  listForeignKeys(connectionId: string, schema: string, table: string, db?: string): Promise<DbForeignKey[]>;
  /** 列出表触发器（表设计器「触发器」子页） */
  listTriggers(connectionId: string, schema: string, table: string, db?: string): Promise<DbTrigger[]>;
  /** 获取视图/物化视图定义（视图/函数浏览器） */
  getViewDefinition(connectionId: string, kind: 'view' | 'mview', schema: string, name: string, db?: string): Promise<DbObjectDef>;
  /** 获取函数/存储过程定义（视图/函数浏览器） */
  getFunctionDefinition(connectionId: string, schema: string, name: string, db?: string): Promise<DbObjectDef>;
  /** 获取序列信息（序列浏览器） */
  getSequenceInfo(connectionId: string, schema: string, name: string, db?: string): Promise<DbSequenceInfo>;
  /** 列出用户/角色（用户与权限管理：PG 角色 / MySQL 用户 / Oracle 用户） */
  listUsers(connectionId: string): Promise<DbUser[]>;
  /** 获取用户权限/授权（用户与权限管理） */
  getUserPrivileges(connectionId: string, name: string, host?: string): Promise<DbUserPrivilege[]>;
  /** 修改用户权限（用户与权限管理：属性/成员角色/系统权限差量） */
  updateUserPrivileges(connectionId: string, name: string, host: string | undefined, edit: DbUserPrivEdit): Promise<void>;
  /** 新建用户（用户与权限管理） */
  createUser(connectionId: string, spec: DbUserSpec): Promise<void>;
  /** 删除用户（用户与权限管理） */
  dropUser(connectionId: string, name: string, host?: string): Promise<void>;

  /** 列出某连接的 SQL 脚本（.sql 文件） */
  listScripts(connId: string): Promise<DbScript[]>;
  /** 新增 / 覆盖保存脚本（同名覆盖内容），返回保存后的元数据 */
  saveScript(connId: string, name: string, sql: string): Promise<DbScript>;
  /** 删除脚本（按名） */
  deleteScript(connId: string, name: string): Promise<void>;
  /** 重命名脚本（旧名内容搬到新名文件，删除旧文件） */
  renameScript(connId: string, oldName: string, newName: string): Promise<DbScript>;
  /** 在系统文件管理器中定位并选中脚本文件（文件不存在时打开所在目录） */
  revealScript(connId: string, name: string): Promise<void>;
  /** 在系统文件管理器中打开脚本目录（connId 缺省打开脚本根目录） */
  openScriptsFolder(connId?: string): Promise<void>;
  /** 预览表数据（PG：schema=模式、db=库名可跨库） */
  tableData(connectionId: string, schema: string | undefined, table: string, limit?: number, db?: string, offset?: number, filter?: { where?: string; orderBy?: string }): Promise<QueryResult>;
  /** 列出库内模式（PG 专有层级：库 → 模式；MySQL 返回空数组；db 指定跨库目标） */
  listSchemas(connectionId: string, db?: string): Promise<string[]>;
  /** 按模式 + 类型列出对象（table/view/mview/sequence/function；db 指定跨库目标） */
  listObjects(connectionId: string, kind: 'table' | 'view' | 'mview' | 'sequence' | 'function', schema: string, db?: string): Promise<string[]>;
  /** 按模式 + 类型列出对象并附注释（表/视图清单页；db 指定跨库目标） */
  listObjectsMeta(connectionId: string, kind: 'table' | 'view' | 'mview', schema: string, db?: string): Promise<DbObjectMeta[]>;
  /** 删除对象（表/视图/物化视图/序列/函数） */
  dropObject(connectionId: string, kind: 'table' | 'view' | 'mview' | 'sequence' | 'function', schema: string, name: string, db?: string): Promise<void>;
  /** PG 库节点元数据分类（事件触发器/扩展/存储/角色/系统信息） */
  listPgMeta(connectionId: string, kind: 'event_trigger' | 'extension' | 'tablespace' | 'role' | 'sysinfo', db?: string): Promise<string[]>;

  /** 结构对比 */
  runDiff(leftId: string, rightId: string): Promise<SchemaDiffResult>;

  /** 读取 AI 设置（含模型列表） */
  getAiSettings(): Promise<AiSettings>;
  /** 保存 AI 设置（每条模型 apiKey 落盘前加密） */
  setAiSettings(s: AiSettings): Promise<AiSettings>;
  /** AI 流式对话；modelId 可选，不传则用默认模型。
   *  conn 传入当前连接上下文：SSH 连接可执行命令；数据库连接（mysql/postgres/oracle）可执行只读 SQL 查真实数据。返回完整文本 */
  aiAsk(history: AiMessage[], context?: string[], modelId?: string, conn?: { id: string; label: string; kind?: string }): Promise<string>;
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
