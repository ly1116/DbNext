import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { DataroostApi } from '../renderer/vite-env';
import type { SshInputRequest } from '@shared/types';

/**
 * 预加载脚本（Preload）。
 *
 * 通过 `contextBridge` 仅暴露白名单 API 到 `window.dataroost`，
 * 渲染进程无法直接访问 Node / electron 内部对象，满足安全最小权限原则。
 *
 * 所有方法均为异步（Promise），与 `ipcMain.handle` 一一对应；
 * 流式/进度类通过 `ipcRenderer.on` 订阅并暴露退订函数。
 *
 * @since 0.1.0
 */
const api: DataroostApi = {
  getVersion: () => ipcRenderer.invoke(IPC.APP_VERSION),
  getPlatform: () => ipcRenderer.invoke(IPC.APP_PLATFORM),
  windowControl: (action) => ipcRenderer.invoke(IPC.WINDOW_CONTROL, action),
  listConnections: () => ipcRenderer.invoke(IPC.CONNECTION_LIST),
  saveConnection: (cfg) => ipcRenderer.invoke(IPC.CONNECTION_SAVE, cfg),
  deleteConnection: (id) => ipcRenderer.invoke(IPC.CONNECTION_DELETE, id),
  testConnection: (cfg) => ipcRenderer.invoke(IPC.CONNECTION_TEST, cfg),
  connect: (id) => ipcRenderer.invoke(IPC.CONNECTION_CONNECT, id),
  disconnect: (id) => ipcRenderer.invoke(IPC.CONNECTION_DISCONNECT, id),
  exportProfile: (ids) => ipcRenderer.invoke(IPC.CONNECTION_EXPORT, ids),
  importProfile: (json) => ipcRenderer.invoke(IPC.CONNECTION_IMPORT, json),

  terminalCreate: (connectionId, opts, sessionKey) => ipcRenderer.invoke(IPC.TERMINAL_CREATE, connectionId, opts, sessionKey),
  terminalWrite: (connectionId, data, sessionKey) => void ipcRenderer.invoke(IPC.TERMINAL_WRITE, connectionId, data, sessionKey),
  terminalResize: (connectionId, dims, sessionKey) => void ipcRenderer.invoke(IPC.TERMINAL_RESIZE, connectionId, dims, sessionKey),
  terminalExit: (connectionId, sessionKey) => void ipcRenderer.invoke(IPC.TERMINAL_EXIT, connectionId, sessionKey),
  onTerminalData: (cb) => {
    const l = (_e: unknown, p: { connectionId: string; sessionKey?: string; data: string }) => cb(p.connectionId, p.sessionKey ?? '0', p.data);
    ipcRenderer.on(IPC.TERMINAL_DATA, l);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, l);
  },

  listDir: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_LIST, connectionId, path),
  stat: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_STAT, connectionId, path),
  mkdir: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_MKDIR, connectionId, path),
  remove: (connectionId, path, recursive) => ipcRenderer.invoke(IPC.SFTP_REMOVE, connectionId, path, recursive),
  rename: (connectionId, oldPath, newPath) => ipcRenderer.invoke(IPC.SFTP_RENAME, connectionId, oldPath, newPath),
  chmod: (connectionId, path, modeOctal) => ipcRenderer.invoke(IPC.SFTP_CHMOD, connectionId, path, modeOctal),
  touch: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_TOUCH, connectionId, path),
  readTextFile: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_READ_TEXT, connectionId, path),
  writeTextFile: (connectionId, path, content) => ipcRenderer.invoke(IPC.SFTP_WRITE_TEXT, connectionId, path, content),

  upload: (connectionId, localPath, remotePath) => ipcRenderer.invoke(IPC.TRANSFER_UPLOAD, connectionId, localPath, remotePath),
  download: (connectionId, remotePath, localPath) => ipcRenderer.invoke(IPC.TRANSFER_DOWNLOAD, connectionId, remotePath, localPath),
  uploadDir: (connectionId, localPath, remotePath) => ipcRenderer.invoke(IPC.TRANSFER_UPLOAD_DIR, connectionId, localPath, remotePath),
  downloadDir: (connectionId, remotePath, localPath) => ipcRenderer.invoke(IPC.TRANSFER_DOWNLOAD_DIR, connectionId, remotePath, localPath),
  listTransfers: () => ipcRenderer.invoke(IPC.TRANSFER_LIST),
  onTransferProgress: (cb) => {
    const l = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IPC.TRANSFER_PROGRESS, l);
    return () => ipcRenderer.removeListener(IPC.TRANSFER_PROGRESS, l);
  },

  redisKeys: (connectionId, pattern) => ipcRenderer.invoke(IPC.REDIS_KEYS, connectionId, pattern),
  redisGet: (connectionId, key) => ipcRenderer.invoke(IPC.REDIS_GET, connectionId, key),
  redisSet: (connectionId, key, type, value) => ipcRenderer.invoke(IPC.REDIS_SET, connectionId, key, type, value),
  redisDel: (connectionId, key) => ipcRenderer.invoke(IPC.REDIS_DEL, connectionId, key),
  redisRename: (connectionId, key, newKey) => ipcRenderer.invoke(IPC.REDIS_RENAME, connectionId, key, newKey),
  redisExpire: (connectionId, key, ttl) => ipcRenderer.invoke(IPC.REDIS_EXPIRE, connectionId, key, ttl),
  redisSelectDb: (connectionId, dbIndex) => ipcRenderer.invoke(IPC.REDIS_SELECT_DB, connectionId, dbIndex),
  redisDbInfo: (connectionId) => ipcRenderer.invoke(IPC.REDIS_DB_INFO, connectionId),

  runSql: (connectionId, sql, db) => ipcRenderer.invoke(IPC.SQL_RUN, connectionId, sql, db),
  runSqlPaged: (connectionId, sql, offset, limit, db) => ipcRenderer.invoke(IPC.SQL_RUN_PAGED, connectionId, sql, offset, limit, db),
  runScript: (connectionId, script, db) => ipcRenderer.invoke(IPC.SQL_SCRIPT, connectionId, script, db),
  listSchemaColumns: (connectionId, db) => ipcRenderer.invoke(IPC.SQL_SCHEMA_COLUMNS, connectionId, db),
  listDatabases: (connectionId) => ipcRenderer.invoke(IPC.SQL_DATABASES, connectionId),
  createDatabase: (connectionId, spec) => ipcRenderer.invoke(IPC.SQL_CREATE_DB, connectionId, spec),
  dbCreateOptions: (connectionId) => ipcRenderer.invoke(IPC.SQL_DB_CREATE_OPTIONS, connectionId),
  listTables: (connectionId, database, pgDb) => ipcRenderer.invoke(IPC.SQL_TABLES, connectionId, database, pgDb),
  listColumns: (connectionId, database, table, db) => ipcRenderer.invoke(IPC.SQL_COLUMNS, connectionId, database, table, db),
  tableData: (connectionId, database, table, limit, db, offset, filter) => ipcRenderer.invoke(IPC.SQL_TABLE_DATA, connectionId, database, table, limit, db, offset, filter),
  listSchemas: (connectionId, db) => ipcRenderer.invoke(IPC.SQL_SCHEMAS, connectionId, db),
  listObjects: (connectionId, kind, schema, db) => ipcRenderer.invoke(IPC.SQL_OBJECTS, connectionId, kind, schema, db),
  listObjectsMeta: (connectionId, kind, schema, db) => ipcRenderer.invoke(IPC.SQL_OBJECTS_META, connectionId, kind, schema, db),
  dropObject: (connectionId, kind, schema, name, db) => ipcRenderer.invoke(IPC.SQL_DROP_OBJECT, connectionId, kind, schema, name, db),
  renameObject: (connectionId, kind, schema, name, newName, db) => ipcRenderer.invoke(IPC.SQL_RENAME_OBJECT, connectionId, kind, schema, name, newName, db),
  listPgMeta: (connectionId, kind, db) => ipcRenderer.invoke(IPC.SQL_PG_META, connectionId, kind, db),
  addColumn: (connectionId, schema, table, col, db) => ipcRenderer.invoke(IPC.SQL_ADD_COLUMN, connectionId, schema, table, col, db),
  dropColumn: (connectionId, schema, table, column, db) => ipcRenderer.invoke(IPC.SQL_DROP_COLUMN, connectionId, schema, table, column, db),
  alterColumn: (connectionId, schema, table, column, spec, db) => ipcRenderer.invoke(IPC.SQL_ALTER_COLUMN, connectionId, schema, table, column, spec, db),
  listIndexes: (connectionId, schema, table, db) => ipcRenderer.invoke(IPC.SQL_INDEXES, connectionId, schema, table, db),
  listForeignKeys: (connectionId, schema, table, db) => ipcRenderer.invoke(IPC.SQL_FOREIGN_KEYS, connectionId, schema, table, db),
  listTriggers: (connectionId, schema, table, db) => ipcRenderer.invoke(IPC.SQL_TRIGGERS, connectionId, schema, table, db),
  getViewDefinition: (connectionId, kind, schema, name, db) => ipcRenderer.invoke(IPC.SQL_VIEW_DEF, connectionId, kind, schema, name, db),
  getFunctionDefinition: (connectionId, schema, name, db) => ipcRenderer.invoke(IPC.SQL_FUNCTION_DEF, connectionId, schema, name, db),
  getRoutineParams: (connectionId, schema, name, db) => ipcRenderer.invoke(IPC.SQL_ROUTINE_PARAMS, connectionId, schema, name, db),
  execRoutine: (req) => ipcRenderer.invoke(IPC.SQL_ROUTINE_EXEC, req),
  debugStart: (connectionId, schema, name, args) => ipcRenderer.invoke(IPC.SQL_DEBUG_START, connectionId, schema, name, args),
  debugStep: (debugId, action) => ipcRenderer.invoke(IPC.SQL_DEBUG_STEP, debugId, action),
  debugStop: (debugId) => ipcRenderer.invoke(IPC.SQL_DEBUG_STOP, debugId),
  getSequenceInfo: (connectionId, schema, name, db) => ipcRenderer.invoke(IPC.SQL_SEQUENCE_INFO, connectionId, schema, name, db),
  listUsers: (connectionId) => ipcRenderer.invoke(IPC.SQL_USERS, connectionId),
  getUserPrivileges: (connectionId, name, host) => ipcRenderer.invoke(IPC.SQL_USER_PRIVS, connectionId, name, host),
  updateUserPrivileges: (connectionId, name, host, edit) => ipcRenderer.invoke(IPC.SQL_USER_PRIVS_UPDATE, connectionId, name, host, edit),
  createUser: (connectionId, spec) => ipcRenderer.invoke(IPC.SQL_USER_CREATE, connectionId, spec),
  dropUser: (connectionId, name, host) => ipcRenderer.invoke(IPC.SQL_USER_DROP, connectionId, name, host),
  cancelQuery: (connectionId, db) => ipcRenderer.invoke(IPC.SQL_CANCEL, connectionId, db),

  listScripts: (connId) => ipcRenderer.invoke(IPC.SCRIPT_LIST, connId),
  saveScript: (connId, name, sql) => ipcRenderer.invoke(IPC.SCRIPT_SAVE, connId, name, sql),
  deleteScript: (connId, name) => ipcRenderer.invoke(IPC.SCRIPT_DELETE, connId, name),
  renameScript: (connId, oldName, newName) => ipcRenderer.invoke(IPC.SCRIPT_RENAME, connId, oldName, newName),
  revealScript: (connId, name) => ipcRenderer.invoke(IPC.SCRIPT_REVEAL, connId, name),
  openScriptsFolder: (connId) => ipcRenderer.invoke(IPC.SCRIPT_OPEN_FOLDER, connId),

  runDiff: (leftId, rightId, leftOpts, rightOpts) => ipcRenderer.invoke(IPC.DIFF_RUN, leftId, rightId, leftOpts, rightOpts),

  dataTransferRun: (spec, taskId) => ipcRenderer.invoke(IPC.DATA_TRANSFER_RUN, spec, taskId),
  dataTransferCancel: (taskId) => ipcRenderer.invoke(IPC.DATA_TRANSFER_CANCEL, taskId),
  onDataTransferProgress: (cb) => {
    const l = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IPC.DATA_TRANSFER_PROGRESS, l);
    return () => ipcRenderer.removeListener(IPC.DATA_TRANSFER_PROGRESS, l);
  },

  getAiSettings: () => ipcRenderer.invoke(IPC.AI_GET_SETTINGS),
  setAiSettings: (s) => ipcRenderer.invoke(IPC.AI_SET_SETTINGS, s),
  aiAsk: (history, context, modelId, conn) => ipcRenderer.invoke(IPC.AI_ASK, history, context, modelId, conn),
  getGeneralPrefs: () => ipcRenderer.invoke(IPC.PREFS_GET),
  setGeneralPrefs: (p) => ipcRenderer.invoke(IPC.PREFS_SET, p),
  getFolders: () => ipcRenderer.invoke(IPC.FOLDERS_GET),
  setFolders: (f) => ipcRenderer.invoke(IPC.FOLDERS_SET, f),
  getSyncConfig: () => ipcRenderer.invoke(IPC.SYNC_GET_CONFIG),
  setSyncConfig: (token, gistId) => ipcRenderer.invoke(IPC.SYNC_SET_CONFIG, token, gistId),
  resetSyncConfig: () => ipcRenderer.invoke(IPC.SYNC_RESET),
  setZoomFactor: (factor: number) => {
    webFrame.setZoomFactor(Math.min(1.5, Math.max(0.5, factor)));
  },
  pushSync: (token) => ipcRenderer.invoke(IPC.SYNC_PUSH, token),
  pullSync: (token) => ipcRenderer.invoke(IPC.SYNC_PULL, token),
  onAiChunk: (cb) => {
    const l = (_e: unknown, p: { requestId: string; delta: string }) => cb(p.delta);
    ipcRenderer.on(IPC.AI_CHUNK, l);
    return () => ipcRenderer.removeListener(IPC.AI_CHUNK, l);
  },
  onAiDone: (cb) => {
    const l = (_e: unknown, _p: { requestId: string }) => cb();
    ipcRenderer.on(IPC.AI_DONE, l);
    return () => ipcRenderer.removeListener(IPC.AI_DONE, l);
  },

  toggleDevTools: () => ipcRenderer.send(IPC.APP_TOGGLE_DEVTOOLS),
  onConnectionStatus: (cb) => {
    const l = (_e: unknown, p: { id: string; status: Parameters<typeof cb>[1] }) => cb(p.id, p.status);
    ipcRenderer.on(IPC.CONNECTION_STATUS, l);
    return () => ipcRenderer.removeListener(IPC.CONNECTION_STATUS, l);
  },

  onMaximized: (cb) => {
    const l = (_e: unknown, max: boolean) => cb(max);
    ipcRenderer.on(IPC.WINDOW_MAXIMIZED, l);
    return () => ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZED, l);
  },

  localList: (dir) => ipcRenderer.invoke(IPC.FS_LOCAL_LIST, dir),
  readFile: (path) => ipcRenderer.invoke(IPC.FS_READ, path),
  writeFile: (path, content) => ipcRenderer.invoke(IPC.FS_WRITE, path, content),
  openDialog: (opts) => ipcRenderer.invoke(IPC.DIALOG_OPEN, opts),

  clipboardRead: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ),
  clipboardWrite: (text) => ipcRenderer.invoke(IPC.CLIPBOARD_WRITE, text),
  // 拖拽上传：解析拖入 File 的本地绝对路径（同步，走 Electron webUtils）
  pathForFile: (file) => webUtils.getPathForFile(file),
  // 原生窗口背景色跟随主题（frameless 窗口在 HTML 加载前的底色）
  setNativeBackgroundColor: (color: string) => {
    if (/^#[0-9a-fA-F]{6}$/.test(color)) ipcRenderer.invoke(IPC.WINDOW_SET_BG, color);
  },

  onSshInputRequest: (cb) => {
    const l = (_e: unknown, p: SshInputRequest) => cb(p);
    ipcRenderer.on(IPC.SSH_INPUT_REQUEST, l);
    return () => ipcRenderer.removeListener(IPC.SSH_INPUT_REQUEST, l);
  },
  sshInputRespond: (requestId, answers) => ipcRenderer.invoke(IPC.SSH_INPUT_RESPONSE, requestId, answers),

  otpList: () => ipcRenderer.invoke(IPC.OTP_LIST),
  otpSave: (entry) => ipcRenderer.invoke(IPC.OTP_SAVE, entry),
  otpDelete: (id) => ipcRenderer.invoke(IPC.OTP_DELETE, id),
  otpPreview: (target) => ipcRenderer.invoke(IPC.OTP_PREVIEW, target),

  checkUpdate: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  onUpdateStatus: (cb) => {
    const l = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on(IPC.UPDATE_STATUS, l);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, l);
  },
};

// 注入到渲染进程全局，仅暴露以上白名单
contextBridge.exposeInMainWorld('dataroost', api);
