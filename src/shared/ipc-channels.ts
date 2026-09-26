/**
 * IPC 通道常量（单一来源）。
 *
 * 主进程与渲染进程通过 `contextBridge` 暴露的方法名一一对应，
 * 这里集中声明，避免拼写漂移。
 *
 * 命名约定：`领域:动作`
 *
 * 真实实现要点：
 * - 凡涉及「连接某台真实服务器」的动作，均带 `connectionId`，
 *   主进程从客户端管理器取已建立的真实连接（ssh2 / mysql2 / pg / ioredis）。
 * - 流式/进度类（终端输出、传输进度、AI 增量）通过主进程 `sender.send` 推送，
 *   渲染端用 `onXxx` 订阅，断开时移除监听。
 *
 * @since 0.1.0
 */
export const IPC = {
  /** 连接管理 */
  CONNECTION_LIST: 'connection:list',
  CONNECTION_SAVE: 'connection:save',
  CONNECTION_DELETE: 'connection:delete',
  CONNECTION_TEST: 'connection:test',
  /** 建立/断开真实连接（主进程维护客户端生命周期） */
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  /** 连接配置导出/导入（云同步的本地载体） */
  CONNECTION_EXPORT: 'connection:export',
  CONNECTION_IMPORT: 'connection:import',

  /** SSH 终端（真实 ssh2 shell 流） */
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_EXIT: 'terminal:exit',
  /** 主进程 -> 渲染端：终端增量输出 */
  TERMINAL_DATA: 'terminal:data',

  /** SFTP 文件树（真实 ssh2 sftp 子系统） */
  SFTP_LIST: 'sftp:list',
  SFTP_STAT: 'sftp:stat',
  SFTP_MKDIR: 'sftp:mkdir',
  SFTP_REMOVE: 'sftp:remove',
  SFTP_RENAME: 'sftp:rename',
  /** 新建空文件（touch） */
  SFTP_TOUCH: 'sftp:touch',

  /** 传输队列（真实 sftp 上传/下载，带进度推送） */
  TRANSFER_UPLOAD: 'transfer:upload',
  TRANSFER_DOWNLOAD: 'transfer:download',
  /** 递归目录上传/下载（自动创建远端/本地目录） */
  TRANSFER_UPLOAD_DIR: 'transfer:uploadDir',
  TRANSFER_DOWNLOAD_DIR: 'transfer:downloadDir',
  TRANSFER_LIST: 'transfer:list',
  /** 主进程 -> 渲染端：传输进度 */
  TRANSFER_PROGRESS: 'transfer:progress',

  /** Redis（真实 ioredis） */
  REDIS_KEYS: 'redis:keys',
  REDIS_GET: 'redis:get',
  /** 按类型写回值（值编辑） */
  REDIS_SET: 'redis:set',
  /** 删除 key */
  REDIS_DEL: 'redis:del',
  /** 重命名 key */
  REDIS_RENAME: 'redis:rename',
  /** 设置 TTL（秒，<0 表示永久） */
  REDIS_EXPIRE: 'redis:expire',
  /** Redis 切换数据库 */
  REDIS_SELECT_DB: 'redis:selectDb',
  /** Redis 获取各 db 的 key 数量统计 */
  REDIS_DB_INFO: 'redis:dbInfo',

  /** SQL 执行（真实驱动：mysql2 / pg） */
  SQL_RUN: 'sql:run',
  /** SQL 分页执行（自动 COUNT 总数 + LIMIT/OFFSET 取当页） */
  SQL_RUN_PAGED: 'sql:runPaged',
  /** 拉取当前库/模式下所有表的列清单（SQL 编辑器智能提示数据源） */
  SQL_SCHEMA_COLUMNS: 'sql:schemaColumns',
  /** 列出数据库 */
  SQL_DATABASES: 'sql:databases',
  /** 新建数据库（数据库侧「创建目录」） */
  SQL_CREATE_DB: 'sql:createDatabase',
  /** 建库对话框下拉数据源（字符集/排序规则 or PG 角色/表空间/模板库/编码） */
  SQL_DB_CREATE_OPTIONS: 'sql:dbCreateOptions',
  /** 列出库内表（可带 database 参数） */
  SQL_TABLES: 'sql:tables',
  /** 列出表字段 */
  SQL_COLUMNS: 'sql:columns',
  /** 预览单表数据（可带 database 参数） */
  SQL_TABLE_DATA: 'sql:tableData',
  /** 列出库内模式（PG：库 → 模式层级） */
  SQL_SCHEMAS: 'sql:schemas',
  /** 按模式 + 类型列出对象（table/view/mview/sequence/function） */
  SQL_OBJECTS: 'sql:objects',
  /** PG 库节点元数据分类（event_trigger/extension/tablespace/role/sysinfo） */
  SQL_PG_META: 'sql:pgMeta',
  /** 按模式 + 类型列出对象并带注释（表清单页，DBeaver 风格） */
  SQL_OBJECTS_META: 'sql:objectsMeta',
  /** 删除对象（表/视图/物化视图/序列/函数） */
  SQL_DROP_OBJECT: 'sql:dropObject',
  /** 新增表字段（属性页「新增字段」→ ALTER TABLE ADD COLUMN） */
  SQL_ADD_COLUMN: 'sql:addColumn',
  /** 删除表字段（属性页行内删除 → ALTER TABLE DROP COLUMN） */
  SQL_DROP_COLUMN: 'sql:dropColumn',
  /** 列出表索引（表设计器「索引」子页） */
  SQL_INDEXES: 'sql:indexes',
  /** 列出表外键（表设计器「外键」子页） */
  SQL_FOREIGN_KEYS: 'sql:foreignKeys',
  /** 列出表触发器（表设计器「触发器」子页） */
  SQL_TRIGGERS: 'sql:triggers',
  /** 获取视图/物化视图定义（视图/函数浏览器） */
  SQL_VIEW_DEF: 'sql:viewDef',
  /** 获取函数/存储过程定义（视图/函数浏览器） */
  SQL_FUNCTION_DEF: 'sql:functionDef',
  /** 获取序列信息（序列浏览器） */
  SQL_SEQUENCE_INFO: 'sql:sequenceInfo',
  /** 列出用户/角色（用户与权限管理：PG 角色 / MySQL 用户 / Oracle 用户） */
  SQL_USERS: 'sql:users',
  /** 获取用户权限/授权（用户与权限管理） */
  SQL_USER_PRIVS: 'sql:userPrivileges',
  /** 修改用户权限（用户与权限管理：属性/成员角色/系统权限差量） */
  SQL_USER_PRIVS_UPDATE: 'sql:userPrivilegesUpdate',
  /** 新建用户（用户与权限管理） */
  SQL_USER_CREATE: 'sql:createUser',
  /** 删除用户（用户与权限管理） */
  SQL_USER_DROP: 'sql:dropUser',

  /** 结构对比（真实库内省） */
  DIFF_RUN: 'diff:run',

  /** AI 助手（OpenAI 兼容，流式） */
  AI_GET_SETTINGS: 'ai:settings:get',
  AI_SET_SETTINGS: 'ai:settings',
  AI_ASK: 'ai:ask',
  /** 主进程 -> 渲染端：AI 增量 / 完成 */
  AI_CHUNK: 'ai:chunk',
  AI_DONE: 'ai:done',

  /** 主进程 -> 渲染端：连接状态变化（广播） */
  CONNECTION_STATUS: 'connection:status',

  /** SQL 脚本（落盘为 userData/scripts/<connId>/*.sql 纯文本文件） */
  SCRIPT_LIST: 'script:list',
  /** 新增 / 覆盖保存（同名覆盖内容） */
  SCRIPT_SAVE: 'script:save',
  /** 删除脚本 */
  SCRIPT_DELETE: 'script:delete',
  /** 重命名脚本（旧名文件内容搬到新名文件，删除旧文件） */
  SCRIPT_RENAME: 'script:rename',
  /** 在系统文件管理器中定位脚本文件（右侧选中高亮） */
  SCRIPT_REVEAL: 'script:reveal',
  /** 在系统文件管理器中打开脚本目录（connId 可选，缺省打开脚本根目录） */
  SCRIPT_OPEN_FOLDER: 'script:openFolder',

  /** 本地文件系统（渲染端只读浏览，用于 SFTP 本地栏 / 传输选择本地路径） */
  FS_LOCAL_LIST: 'fs:localList',
  /** 读取本地文本文件（云同步导入） */
  FS_READ: 'fs:read',
  /** 写入本地文本文件（云同步导出） */
  FS_WRITE: 'fs:write',
  /** 系统文件选择对话框（打开文件 / 文件夹 / 保存） */
  DIALOG_OPEN: 'dialog:open',

  /** 应用级 */
  APP_VERSION: 'app:version',
  APP_TOGGLE_DEVTOOLS: 'app:toggle-devtools',
  /** 当前操作系统平台（渲染端据此决定原生/自绘窗口控制按钮） */
  APP_PLATFORM: 'app:platform',
  /** 通用偏好（设置表单即时生效） */
  PREFS_GET: 'prefs:get',
  PREFS_SET: 'prefs:set',
  /** 连接树自定义文件夹（持久化于 userData/folders.json） */
  FOLDERS_GET: 'folders:get',
  FOLDERS_SET: 'folders:set',
  /** 云同步（Gitee gist 代码片段）：读取/保存配置、推送、拉取 */
  SYNC_GET_CONFIG: 'sync:getConfig',
  SYNC_SET_CONFIG: 'sync:setConfig',
  SYNC_PUSH: 'sync:push',
  SYNC_PULL: 'sync:pull',
  /** 窗口控制（minimize|maximize|close，真实操作 BrowserWindow） */
  WINDOW_CONTROL: 'window:control',
  /** 主进程 -> 渲染端：窗口最大化状态变化（同步标题栏按钮图标） */
  WINDOW_MAXIMIZED: 'window:maximized',
  /** 系统剪贴板：读取（终端 Ctrl+V / 右键粘贴用，走主进程 electron.clipboard 最稳） */
  CLIPBOARD_READ: 'clipboard:read',
  /** 系统剪贴板：写入（终端 Ctrl+C / 右键复制用） */
  CLIPBOARD_WRITE: 'clipboard:write',

  /** SSH 二次验证（keyboard-interactive / TOTP）：主进程 -> 渲染端 推送输入请求 */
  SSH_INPUT_REQUEST: 'ssh:inputRequest',
  /** 渲染端 -> 主进程：回传二次验证答案（answers=null 表示取消 / 超时） */
  SSH_INPUT_RESPONSE: 'ssh:inputResponse',
} as const;

/** IPC 通道类型（字符串字面量联合），用于类型守卫 */
export type IpcChannel = (typeof IPC)[keyof typeof IPC];
