import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { DbnestApi } from '../renderer/vite-env';
import type { SshInputRequest } from '@shared/types';

/**
 * 预加载脚本（Preload）。
 *
 * 通过 `contextBridge` 仅暴露白名单 API 到 `window.dbnest`，
 * 渲染进程无法直接访问 Node / electron 内部对象，满足安全最小权限原则。
 *
 * 所有方法均为异步（Promise），与 `ipcMain.handle` 一一对应；
 * 流式/进度类通过 `ipcRenderer.on` 订阅并暴露退订函数。
 *
 * @since 0.1.0
 */
const api: DbnestApi = {
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

  terminalCreate: (connectionId, opts) => ipcRenderer.invoke(IPC.TERMINAL_CREATE, connectionId, opts),
  terminalWrite: (connectionId, data) => void ipcRenderer.invoke(IPC.TERMINAL_WRITE, connectionId, data),
  terminalResize: (connectionId, dims) => void ipcRenderer.invoke(IPC.TERMINAL_RESIZE, connectionId, dims),
  terminalExit: (connectionId) => void ipcRenderer.invoke(IPC.TERMINAL_EXIT, connectionId),
  onTerminalData: (cb) => {
    const l = (_e: unknown, p: { connectionId: string; data: string }) => cb(p.connectionId, p.data);
    ipcRenderer.on(IPC.TERMINAL_DATA, l);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_DATA, l);
  },

  listDir: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_LIST, connectionId, path),
  stat: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_STAT, connectionId, path),
  mkdir: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_MKDIR, connectionId, path),
  remove: (connectionId, path, recursive) => ipcRenderer.invoke(IPC.SFTP_REMOVE, connectionId, path, recursive),
  rename: (connectionId, oldPath, newPath) => ipcRenderer.invoke(IPC.SFTP_RENAME, connectionId, oldPath, newPath),
  touch: (connectionId, path) => ipcRenderer.invoke(IPC.SFTP_TOUCH, connectionId, path),

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
  listSchemaColumns: (connectionId, db) => ipcRenderer.invoke(IPC.SQL_SCHEMA_COLUMNS, connectionId, db),
  listDatabases: (connectionId) => ipcRenderer.invoke(IPC.SQL_DATABASES, connectionId),
  createDatabase: (connectionId, spec) => ipcRenderer.invoke(IPC.SQL_CREATE_DB, connectionId, spec),
  dbCreateOptions: (connectionId) => ipcRenderer.invoke(IPC.SQL_DB_CREATE_OPTIONS, connectionId),
  listTables: (connectionId, database) => ipcRenderer.invoke(IPC.SQL_TABLES, connectionId, database),
  listColumns: (connectionId, database, table, db) => ipcRenderer.invoke(IPC.SQL_COLUMNS, connectionId, database, table, db),
  tableData: (connectionId, database, table, limit, db, offset, filter) => ipcRenderer.invoke(IPC.SQL_TABLE_DATA, connectionId, database, table, limit, db, offset, filter),
  listSchemas: (connectionId, db) => ipcRenderer.invoke(IPC.SQL_SCHEMAS, connectionId, db),
  listObjects: (connectionId, kind, schema, db) => ipcRenderer.invoke(IPC.SQL_OBJECTS, connectionId, kind, schema, db),
  listObjectsMeta: (connectionId, kind, schema, db) => ipcRenderer.invoke(IPC.SQL_OBJECTS_META, connectionId, kind, schema, db),
  dropObject: (connectionId, kind, schema, name, db) => ipcRenderer.invoke(IPC.SQL_DROP_OBJECT, connectionId, kind, schema, name, db),
  listPgMeta: (connectionId, kind, db) => ipcRenderer.invoke(IPC.SQL_PG_META, connectionId, kind, db),
  addColumn: (connectionId, schema, table, col, db) => ipcRenderer.invoke(IPC.SQL_ADD_COLUMN, connectionId, schema, table, col, db),
  dropColumn: (connectionId, schema, table, column, db) => ipcRenderer.invoke(IPC.SQL_DROP_COLUMN, connectionId, schema, table, column, db),
  listIndexes: (connectionId, schema, table, db) => ipcRenderer.invoke(IPC.SQL_INDEXES, connectionId, schema, table, db),
  listForeignKeys: (connectionId, schema, table, db) => ipcRenderer.invoke(IPC.SQL_FOREIGN_KEYS, connectionId, schema, table, db),
  listTriggers: (connectionId, schema, table, db) => ipcRenderer.invoke(IPC.SQL_TRIGGERS, connectionId, schema, table, db),
  getViewDefinition: (connectionId, kind, schema, name, db) => ipcRenderer.invoke(IPC.SQL_VIEW_DEF, connectionId, kind, schema, name, db),
  getFunctionDefinition: (connectionId, schema, name, db) => ipcRenderer.invoke(IPC.SQL_FUNCTION_DEF, connectionId, schema, name, db),
  getSequenceInfo: (connectionId, schema, name, db) => ipcRenderer.invoke(IPC.SQL_SEQUENCE_INFO, connectionId, schema, name, db),
  listUsers: (connectionId) => ipcRenderer.invoke(IPC.SQL_USERS, connectionId),
  getUserPrivileges: (connectionId, name, host) => ipcRenderer.invoke(IPC.SQL_USER_PRIVS, connectionId, name, host),
  updateUserPrivileges: (connectionId, name, host, edit) => ipcRenderer.invoke(IPC.SQL_USER_PRIVS_UPDATE, connectionId, name, host, edit),
  createUser: (connectionId, spec) => ipcRenderer.invoke(IPC.SQL_USER_CREATE, connectionId, spec),
  dropUser: (connectionId, name, host) => ipcRenderer.invoke(IPC.SQL_USER_DROP, connectionId, name, host),

  listScripts: (connId) => ipcRenderer.invoke(IPC.SCRIPT_LIST, connId),
  saveScript: (connId, name, sql) => ipcRenderer.invoke(IPC.SCRIPT_SAVE, connId, name, sql),
  deleteScript: (connId, name) => ipcRenderer.invoke(IPC.SCRIPT_DELETE, connId, name),
  renameScript: (connId, oldName, newName) => ipcRenderer.invoke(IPC.SCRIPT_RENAME, connId, oldName, newName),
  revealScript: (connId, name) => ipcRenderer.invoke(IPC.SCRIPT_REVEAL, connId, name),
  openScriptsFolder: (connId) => ipcRenderer.invoke(IPC.SCRIPT_OPEN_FOLDER, connId),

  runDiff: (leftId, rightId) => ipcRenderer.invoke(IPC.DIFF_RUN, leftId, rightId),

  getAiSettings: () => ipcRenderer.invoke(IPC.AI_GET_SETTINGS),
  setAiSettings: (s) => ipcRenderer.invoke(IPC.AI_SET_SETTINGS, s),
  aiAsk: (history, context, modelId, conn) => ipcRenderer.invoke(IPC.AI_ASK, history, context, modelId, conn),
  getGeneralPrefs: () => ipcRenderer.invoke(IPC.PREFS_GET),
  setGeneralPrefs: (p) => ipcRenderer.invoke(IPC.PREFS_SET, p),
  getFolders: () => ipcRenderer.invoke(IPC.FOLDERS_GET),
  setFolders: (f) => ipcRenderer.invoke(IPC.FOLDERS_SET, f),
  getSyncConfig: () => ipcRenderer.invoke(IPC.SYNC_GET_CONFIG),
  setSyncConfig: (token, passphrase) => ipcRenderer.invoke(IPC.SYNC_SET_CONFIG, token, passphrase),
  pushSync: (token, passphrase) => ipcRenderer.invoke(IPC.SYNC_PUSH, token, passphrase),
  pullSync: (token, passphrase) => ipcRenderer.invoke(IPC.SYNC_PULL, token, passphrase),
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

  onSshInputRequest: (cb) => {
    const l = (_e: unknown, p: SshInputRequest) => cb(p);
    ipcRenderer.on(IPC.SSH_INPUT_REQUEST, l);
    return () => ipcRenderer.removeListener(IPC.SSH_INPUT_REQUEST, l);
  },
  sshInputRespond: (requestId, answers) => ipcRenderer.invoke(IPC.SSH_INPUT_RESPONSE, requestId, answers),
};

// 注入到渲染进程全局，仅暴露以上白名单
contextBridge.exposeInMainWorld('dbnest', api);
