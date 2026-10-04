import { app, clipboard, dialog, ipcMain, BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  AiMessage,
  ConnectionConfig,
  ConnectionSummary,
  DbColumn,
  DbScript,
  DbColumnSpec,
  DbColumnAlterSpec,
  DbCreateOptions,
  DbCreateSpec,
  DbForeignKey,
  DbIndex,
  DbObjectDef,
  DbObjectMeta,
  DbSequenceInfo,
  DbTrigger,
  DbUser,
  DbUserPrivEdit,
  DbUserPrivilege,
  DbUserSpec,
  DataTransferSpec,
  DataTransferProgress,
  FileNode,
  OtpEntry,
  OtpPreview,
  QueryResult,
  RoutineDebugState,
  RoutineExecRequest,
  RoutineExecResult,
  RoutineParam,
  PagedSqlResult,
  ScriptResult,
  RedisEntry,
  SchemaDiffResult,
  TransferTask,
} from '@shared/types';
import { createLogger } from './logger';
import {
  deleteConnection,
  exportProfile,
  importProfile,
  initConnectionStore,
  initOtpStore,
  listConnections,
  saveConnection,
  loadAiSettings,
  loadGeneralPrefs,
  saveGeneralPrefs,
  loadFolders,
  saveFolders,
  listOtpEntryViews,
  saveOtpEntry,
  deleteOtpEntry,
  getOtpEntry,
} from './services/connection-store';
import { totp } from './services/totp';
import { getSyncConfig, setSyncConfig, resetSyncConfig, pushSync, pullSync } from './services/sync.service';
import {
  connect,
  disconnect,
  onStatusChange,
  statusOf,
  testConnection,
  cancelActiveQuery,
} from './clients/manager';
import { createTerminalSession, type TerminalSession } from './services/ssh.service';
import { listScripts, saveScript, deleteScript, renameScript, revealScript, openScriptsDir } from './services/script.service';
import { resolveSshInput } from './services/ssh-input';
import { listDir, stat, mkdir, remove, rename, touch, chmod, readTextFile, writeTextFile } from './services/sftp.service';
import { upload, download, uploadDir, downloadDir } from './services/transfer.service';
import { keys as redisKeys, get as redisGet, setVal as redisSet, del as redisDel, rename as redisRename, expire as redisExpire, selectDb as redisSelectDb, dbInfo as redisDbInfo } from './services/redis.service';
import { runSql, runSqlPaged, runScript, listSchemaColumns, listDatabases, listTables, listColumns, tableData, createDatabase, listSchemas, listObjects, listObjectsMeta, listPgMeta, listDbCreateOptions, addColumn, dropColumn, alterColumn, dropObject, renameObject, listIndexes, listForeignKeys, listTriggers, getViewDefinition, getFunctionDefinition, getSequenceInfo, listUsers, getUserPrivileges, updateUserPrivileges, createUser, dropUser, type DbObjKind, type DbMetaKind, type PgMetaKind } from './services/sql.service';
import { runDiff, type DiffSideOptions } from './services/diff.service';
import { runDataTransfer, cancelDataTransfer } from './services/data-transfer.service';
import { ask as aiAsk, updateSettings } from './services/ai.service';
import { listLocal, readText, writeText } from './services/local-fs.service';
import { oraGetRoutineParams, oraExecRoutine, oraDebugStart, oraDebugStep, oraDebugStop } from './services/oracle.service';
import { getOracle } from './clients/manager';
import { checkForUpdates, downloadUpdate, installUpdate } from './auto-update';

/** 该连接是否为已建立的 Oracle 连接（存储过程执行/调试目前只支持 Oracle） */
function isOracleConn(connectionId: string): boolean {
  return !!getOracle(connectionId);
}

/**
 * IPC 路由注册中心。
 *
 * 将 `shared/ipc-channels` 中声明的每个通道，绑定到主进程对应的「真实」service 实现。
 * 渲染进程通过 preload 暴露的 `window.dataroost` 调用，类型两端一致。
 *
 * 所有涉及真实服务器的动作都带 connectionId，由客户端管理器取已建立的连接。
 *
 * @since 0.1.0
 */
const logger = createLogger('ipc');

/**
 * 统一 IPC 错误处理：包裹 ipcMain.handle，handler 抛错时记录结构化日志（含通道名与堆栈），
 * 仍向渲染端 reject 以便调用方 .catch 兜底。避免任意 handler 遗漏 try/catch 导致线上无日志可查。
 */
function handle<T = unknown>(channel: string, listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await listener(event, ...args);
    } catch (err) {
      const e = err as Error;
      logger.error(`[IPC ${channel}] ${e?.stack ?? e?.message ?? String(err)}`);
      throw err;
    }
  });
}

/**
 * 终端会话表：connectionId -> entry（每条连接只保留一个真实 ssh shell）。
 *
 * 设计要点（彻底解决「首屏空白 / 孤儿 shell」两类问题）：
 * 1. 单 shell 复用：React StrictMode 下 effect 会挂载两遍，第一遍开的 shell 吞掉首屏
 *    （Last login / MOTD / 提示符）后立刻被清理，第二遍新开的 shell 在同一条 TCP 连接上
 *    往往不再打印首屏，于是界面全空。改为「每条连接一个 shell」，第二遍复用第一遍的 shell，
 *    并把首屏缓冲回放给新订阅者，banner 不丢。
 * 2. 缓冲回放：shell 自打开以来所有远端输出存入 backlog，新订阅者接入时一次性回放；
 *    哪怕渲染端订阅晚于首屏到达，也不会留白屏。
 * 3. 优雅回收：无订阅者时并不立即销毁，而是延迟 400ms（覆盖 StrictMode 双挂载的间隙），
 *    期间若有新订阅者接入则取消回收并复用；真正关闭才 dispose，避免孤儿登录会话泄漏。
 * 4. 连接断开即销毁：连接状态变为 disconnected 时同步销毁其 shell。
 */
interface TermSubscriber {
  send: (data: string) => void;
}
interface TermEntry {
  promise: Promise<TerminalSession>;
  sess?: TerminalSession;
  /** 订阅者（按渲染端 sessionKey 区分）：shell 输出扇出给所有活跃订阅者 */
  subscribers: Map<string, TermSubscriber>;
  /** 是否已为 shell 注册「扇出」监听（只注册一次） */
  fanned: boolean;
  /** 无订阅者后的延迟回收定时器 */
  closingTimer?: ReturnType<typeof setTimeout>;
}
const terminals = new Map<string, TermEntry>();
/** 销毁某连接的终端 shell 并清理表项 */
function disposeTerminal(connectionId: string) {
  const entry = terminals.get(connectionId);
  if (!entry) return;
  if (entry.closingTimer) clearTimeout(entry.closingTimer);
  entry.subscribers.clear();
  entry.promise.then((s) => s.dispose()).catch(() => {});
  terminals.delete(connectionId);
}

/** 传输任务表（用于 transfer:list 快照） */
const transfers = new Map<string, TransferTask>();

/** 注册所有 IPC 处理器 */
export function registerIpc(): void {
  initConnectionStore();
  initOtpStore();
  onStatusChange((id, status) => {
    // 连接状态变化时广播给所有窗口，渲染端据此刷新连接树
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC.CONNECTION_STATUS, { id, status });
    }
    // 连接断开：销毁其终端 shell，避免远端孤儿登录会话泄漏
    if (status === 'disconnected') disposeTerminal(id);
  });

  // —— 连接管理 ——
  handle(IPC.CONNECTION_LIST, (): ConnectionSummary[] => listConnections(statusOf));
  handle(IPC.CONNECTION_SAVE, (_e, cfg: ConnectionConfig): ConnectionSummary => saveConnection(cfg));
  handle(IPC.CONNECTION_DELETE, (_e, id: string) => deleteConnection(id));
  handle(IPC.CONNECTION_TEST, (_e, cfg: ConnectionConfig) => testConnection(cfg));
  handle(IPC.CONNECTION_CONNECT, (_e, id: string): Promise<ConnectionSummary> => connect(id));
  handle(IPC.CONNECTION_DISCONNECT, (_e, id: string) => disconnect(id));
  handle(IPC.CONNECTION_EXPORT, (_e, ids?: string[]) => exportProfile(ids));
  handle(IPC.CONNECTION_IMPORT, (_e, profile: string): ConnectionSummary[] => importProfile(profile));

  // —— SSH 终端（真实 ssh2 shell；每条连接一个 shell，sessionKey 区分渲染端订阅者）——
  handle(IPC.TERMINAL_CREATE, async (e, connectionId: string, opts, sessionKey = '0') => {
    // 复用或新建该连接的唯一 shell
    let entry = terminals.get(connectionId);
    if (!entry) {
      entry = { promise: createTerminalSession(connectionId, opts ?? {}), subscribers: new Map(), fanned: false };
      terminals.set(connectionId, entry);
    }
    // StrictMode 双挂载 / 重连间隙：取消即将执行的延迟回收，复用同一 shell
    if (entry.closingTimer) {
      clearTimeout(entry.closingTimer);
      entry.closingTimer = undefined;
    }
    const sess = await entry.promise;
    entry.sess = sess;
    // 仅注册一次扇出监听：shell 输出分发给所有活跃订阅者
    if (!entry.fanned) {
      entry.fanned = true;
      sess.onData((chunk) => {
        const t = terminals.get(connectionId);
        if (!t) return;
        for (const sub of t.subscribers.values()) sub.send(chunk);
      });
    }
    // 注册本订阅者，并回放首屏缓冲（哪怕订阅晚于首屏到达也补齐）
    const sub: TermSubscriber = {
      send: (data) => e.sender.send(IPC.TERMINAL_DATA, { connectionId, sessionKey, data }),
    };
    entry.subscribers.set(sessionKey, sub);
    sess.replay((backlog) => sub.send(backlog));
    return true;
  });
  handle(IPC.TERMINAL_WRITE, (_e, connectionId: string, data: string) => {
    terminals.get(connectionId)?.sess?.write(data);
  });
  handle(IPC.TERMINAL_RESIZE, (_e, connectionId: string, dims: { cols: number; rows: number }) => {
    terminals.get(connectionId)?.sess?.resize(dims.cols, dims.rows);
  });
  handle(IPC.TERMINAL_EXIT, (_e, connectionId: string, sessionKey = '0') => {
    const entry = terminals.get(connectionId);
    if (!entry) return;
    entry.subscribers.delete(sessionKey);
    // 无订阅者：延迟回收（覆盖 StrictMode 双挂载间隙），期间有新订阅者接入则取消
    if (entry.subscribers.size === 0) {
      entry.closingTimer = setTimeout(() => disposeTerminal(connectionId), 400);
    }
  });

  // —— SFTP ——
  handle(IPC.SFTP_LIST, (_e, connectionId: string, path: string): Promise<FileNode[]> => listDir(connectionId, path));
  handle(IPC.SFTP_STAT, (_e, connectionId: string, path: string): Promise<FileNode> => stat(connectionId, path));
  handle(IPC.SFTP_MKDIR, (_e, connectionId: string, path: string) => mkdir(connectionId, path));
  handle(IPC.SFTP_REMOVE, (_e, connectionId: string, path: string, recursive?: boolean) => remove(connectionId, path, recursive));
  handle(IPC.SFTP_RENAME, (_e, connectionId: string, oldPath: string, newPath: string) => rename(connectionId, oldPath, newPath));
  handle(IPC.SFTP_TOUCH, (_e, connectionId: string, path: string) => touch(connectionId, path));
  handle(IPC.SFTP_CHMOD, (_e, connectionId: string, path: string, modeOctal: string) => chmod(connectionId, path, modeOctal));
  handle(IPC.SFTP_READ_TEXT, (_e, connectionId: string, path: string) => readTextFile(connectionId, path));
  handle(IPC.SFTP_WRITE_TEXT, (_e, connectionId: string, path: string, content: string) => writeTextFile(connectionId, path, content));

  // —— 传输（真实 sftp，带进度推送）——
  /** 通用任务登记 + 进度推送（文件/目录上传下载共用） */
  const trackTransfer = (
    e: Electron.IpcMainInvokeEvent,
    direction: 'upload' | 'download',
    remotePath: string,
    localPath: string,
    run: (onProgress: (transferred: number, total: number) => void) => Promise<{ id: string; total: number }>,
  ) => {
    const t: TransferTask = { id: '', remotePath, localPath, direction, total: 0, transferred: 0, status: 'active' };
    return run((transferred, total) => {
      t.total = total;
      t.transferred = transferred;
      t.status = transferred >= total ? 'done' : 'active';
      transfers.set(t.id || `${direction}`, t);
      e.sender.send(IPC.TRANSFER_PROGRESS, { id: t.id, transferred, total, status: t.status });
    })
      .then((r) => {
        t.id = r.id;
        t.total = r.total;
        t.transferred = r.total;
        t.status = 'done';
        transfers.set(r.id, t);
        return r;
      })
      .catch((err) => {
        t.status = 'error';
        t.error = (err as Error).message;
        throw err;
      });
  };
  handle(IPC.TRANSFER_UPLOAD, (e, connectionId: string, localPath: string, remotePath: string) =>
    trackTransfer(e, 'upload', remotePath, localPath, (onProgress) => upload(connectionId, localPath, remotePath, onProgress)));
  handle(IPC.TRANSFER_DOWNLOAD, (e, connectionId: string, remotePath: string, localPath: string) =>
    trackTransfer(e, 'download', remotePath, localPath, (onProgress) => download(connectionId, remotePath, localPath, onProgress)));
  handle(IPC.TRANSFER_UPLOAD_DIR, (e, connectionId: string, localPath: string, remotePath: string) =>
    trackTransfer(e, 'upload', remotePath, localPath, (onProgress) => uploadDir(connectionId, localPath, remotePath, onProgress)));
  handle(IPC.TRANSFER_DOWNLOAD_DIR, (e, connectionId: string, remotePath: string, localPath: string) =>
    trackTransfer(e, 'download', remotePath, localPath, (onProgress) => downloadDir(connectionId, remotePath, localPath, onProgress)));
  handle(IPC.TRANSFER_LIST, (): TransferTask[] => [...transfers.values()]);

  // —— Redis ——
  handle(IPC.REDIS_KEYS, (_e, connectionId: string, pattern: string): Promise<RedisEntry[]> => redisKeys(connectionId, pattern));
  handle(IPC.REDIS_GET, (_e, connectionId: string, key: string) => redisGet(connectionId, key));
  handle(IPC.REDIS_SET, (_e, connectionId: string, key: string, type: string, value: string): Promise<void> => redisSet(connectionId, key, type, value));
  handle(IPC.REDIS_DEL, (_e, connectionId: string, key: string): Promise<void> => redisDel(connectionId, key));
  handle(IPC.REDIS_RENAME, (_e, connectionId: string, key: string, newKey: string): Promise<void> => redisRename(connectionId, key, newKey));
  handle(IPC.REDIS_EXPIRE, (_e, connectionId: string, key: string, ttl: number): Promise<void> => redisExpire(connectionId, key, ttl));
  handle(IPC.REDIS_SELECT_DB, (_e, connectionId: string, dbIndex: number): Promise<void> => redisSelectDb(connectionId, dbIndex));
  handle(IPC.REDIS_DB_INFO, (_e, connectionId: string): Promise<Record<number, number>> => redisDbInfo(connectionId));

  // —— SQL ——
  handle(IPC.SQL_RUN, (_e, connectionId: string, sql: string, db?: string): Promise<QueryResult> => runSql(connectionId, sql, db));
  handle(IPC.SQL_RUN_PAGED, (_e, connectionId: string, sql: string, offset: number, limit: number, db?: string): Promise<PagedSqlResult> => runSqlPaged(connectionId, sql, offset, limit, db));
  handle(IPC.SQL_SCRIPT, (_e, connectionId: string, script: string, db?: string): Promise<ScriptResult> => runScript(connectionId, script, db));
  handle(IPC.SQL_SCHEMA_COLUMNS, (_e, connectionId: string, db?: string): Promise<Record<string, string[]>> => listSchemaColumns(connectionId, db));
  handle(IPC.SQL_DATABASES, (_e, connectionId: string): Promise<string[]> => listDatabases(connectionId));
  handle(IPC.SQL_CREATE_DB, (_e, connectionId: string, spec: DbCreateSpec): Promise<void> => createDatabase(connectionId, spec));
  handle(IPC.SQL_DB_CREATE_OPTIONS, (_e, connectionId: string): Promise<DbCreateOptions> => listDbCreateOptions(connectionId));
  handle(IPC.SQL_TABLES, (_e, connectionId: string, database?: string, pgDb?: string): Promise<string[]> => listTables(connectionId, database, pgDb));
  handle(IPC.SQL_COLUMNS, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbColumn[]> => listColumns(connectionId, schema, table, db));
  handle(IPC.SQL_TABLE_DATA, (_e, connectionId: string, schema: string | undefined, table: string, limit?: number, db?: string, offset?: number, filter?: { where?: string; orderBy?: string }): Promise<QueryResult> => tableData(connectionId, schema, table, limit, db, offset, filter));
  handle(IPC.SQL_SCHEMAS, (_e, connectionId: string, db?: string): Promise<string[]> => listSchemas(connectionId, db));
  handle(IPC.SQL_OBJECTS, (_e, connectionId: string, kind: DbObjKind, schema: string, db?: string): Promise<string[]> => listObjects(connectionId, kind, schema, db));
  handle(IPC.SQL_PG_META, (_e, connectionId: string, kind: PgMetaKind, db?: string): Promise<string[]> => listPgMeta(connectionId, db, kind));
  handle(IPC.SQL_OBJECTS_META, (_e, connectionId: string, kind: DbMetaKind, schema: string, db?: string): Promise<DbObjectMeta[]> => listObjectsMeta(connectionId, kind, schema, db));
  handle(IPC.SQL_DROP_OBJECT, (_e, connectionId: string, kind: DbObjKind, schema: string, name: string, db?: string): Promise<void> => dropObject(connectionId, kind, schema, name, db));
  handle(IPC.SQL_RENAME_OBJECT, (_e, connectionId: string, kind: 'table' | 'view' | 'mview' | 'sequence', schema: string, name: string, newName: string, db?: string): Promise<void> => renameObject(connectionId, kind, schema, name, newName, db));
  handle(IPC.SQL_ADD_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, col: DbColumnSpec, db?: string): Promise<void> => addColumn(connectionId, schema, table, col, db));
  handle(IPC.SQL_DROP_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, column: string, db?: string): Promise<void> => dropColumn(connectionId, schema, table, column, db));
  handle(IPC.SQL_ALTER_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, column: string, spec: DbColumnAlterSpec, db?: string): Promise<void> => alterColumn(connectionId, schema, table, column, spec, db));
  handle(IPC.SQL_INDEXES, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbIndex[]> => listIndexes(connectionId, schema, table, db));
  handle(IPC.SQL_FOREIGN_KEYS, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbForeignKey[]> => listForeignKeys(connectionId, schema, table, db));
  handle(IPC.SQL_TRIGGERS, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbTrigger[]> => listTriggers(connectionId, schema, table, db));
  handle(IPC.SQL_VIEW_DEF, (_e, connectionId: string, kind: 'view' | 'mview', schema: string, name: string, db?: string): Promise<DbObjectDef> => getViewDefinition(connectionId, kind, schema, name, db));
  handle(IPC.SQL_FUNCTION_DEF, (_e, connectionId: string, schema: string, name: string, db?: string): Promise<DbObjectDef> => getFunctionDefinition(connectionId, schema, name, db));
  // —— 存储过程 / 函数：参数元数据 · 执行 · DBMS_DEBUG 调试（仅 Oracle 走 PL/SQL 语义）——
  handle(IPC.SQL_ROUTINE_PARAMS, (_e, connectionId: string, schema: string, name: string, _db?: string): Promise<RoutineParam[]> =>
    isOracleConn(connectionId) ? oraGetRoutineParams(connectionId, schema, name) : Promise.resolve([]));
  handle(IPC.SQL_ROUTINE_EXEC, (_e, req: RoutineExecRequest): Promise<RoutineExecResult> => {
    if (!isOracleConn(req.connectionId)) return Promise.reject(new Error('当前仅支持 Oracle 存储过程/函数的参数化执行'));
    return oraExecRoutine(req.connectionId, req.schema, req.name, req.args, req.autoCommit ?? true);
  });
  handle(IPC.SQL_DEBUG_START, (_e, connectionId: string, schema: string, name: string, args: Record<string, string>) => {
    if (!isOracleConn(connectionId)) return Promise.reject(new Error('当前仅支持 Oracle 存储过程调试（DBMS_DEBUG）'));
    return oraDebugStart(connectionId, schema, name, args);
  });
  handle(IPC.SQL_DEBUG_STEP, (_e, debugId: string, action: 'step' | 'continue'): Promise<RoutineDebugState> => oraDebugStep(debugId, action));
  handle(IPC.SQL_DEBUG_STOP, (_e, debugId: string): Promise<void> => oraDebugStop(debugId));
  handle(IPC.SQL_SEQUENCE_INFO, (_e, connectionId: string, schema: string, name: string, db?: string): Promise<DbSequenceInfo> => getSequenceInfo(connectionId, schema, name, db));
  // —— 用户与权限管理（PG 角色 / MySQL 用户 / Oracle 用户）——
  handle(IPC.SQL_USERS, (_e, connectionId: string): Promise<DbUser[]> => listUsers(connectionId));
  handle(IPC.SQL_USER_PRIVS, (_e, connectionId: string, name: string, host?: string): Promise<DbUserPrivilege[]> => getUserPrivileges(connectionId, name, host));
  handle(IPC.SQL_USER_PRIVS_UPDATE, (_e, connectionId: string, name: string, host: string | undefined, edit: DbUserPrivEdit): Promise<void> => updateUserPrivileges(connectionId, name, host, edit));
  handle(IPC.SQL_USER_CREATE, (_e, connectionId: string, spec: DbUserSpec): Promise<void> => createUser(connectionId, spec));
  handle(IPC.SQL_USER_DROP, (_e, connectionId: string, name: string, host?: string): Promise<void> => dropUser(connectionId, name, host));

  // —— 取消查询（超时 / 手动停止；best-effort，底层驱动级取消）——
  handle(IPC.SQL_CANCEL, (_e, connectionId: string, db?: string) => cancelActiveQuery(connectionId, db));

  // —— SQL 脚本（落盘 .sql 文件）——
  handle(IPC.SCRIPT_LIST, (_e, connId: string): DbScript[] => listScripts(connId));
  handle(IPC.SCRIPT_SAVE, (_e, connId: string, name: string, sql: string): DbScript => saveScript(connId, name, sql));
  handle(IPC.SCRIPT_DELETE, (_e, connId: string, name: string): void => deleteScript(connId, name));
  handle(IPC.SCRIPT_RENAME, (_e, connId: string, oldName: string, newName: string): DbScript => renameScript(connId, oldName, newName));
  handle(IPC.SCRIPT_REVEAL, (_e, connId: string, name: string): void => revealScript(connId, name));
  handle(IPC.SCRIPT_OPEN_FOLDER, (_e, connId?: string): Promise<void> => openScriptsDir(connId));

  // —— 结构对比 ——
  handle(IPC.DIFF_RUN, (_e, leftId: string, rightId: string, leftOpts?: DiffSideOptions, rightOpts?: DiffSideOptions): Promise<SchemaDiffResult> => runDiff(leftId, rightId, leftOpts, rightOpts));

  // —— 数据传输（跨库表传输，进度经 sender 实时推送；taskId 优先用渲染端传入以便随时取消）——
  handle(IPC.DATA_TRANSFER_RUN, (e, spec: DataTransferSpec, taskIdHint?: string) => {
    const taskId = taskIdHint || `dt-${Date.now().toString(36)}`;
    const send = (p: Partial<DataTransferProgress>) => e.sender.send(IPC.DATA_TRANSFER_PROGRESS, { taskId, ...p });
    return runDataTransfer(spec, taskId, send);
  });
  handle(IPC.DATA_TRANSFER_CANCEL, (_e, taskId: string) => cancelDataTransfer(taskId));

  // —— AI ——
  handle(IPC.AI_GET_SETTINGS, () => loadAiSettings());
  handle(IPC.AI_SET_SETTINGS, (_e, s) => updateSettings(s));
  handle(IPC.AI_ASK, async (e, history: AiMessage[], context?: string[], modelId?: string, conn?: { id: string; label: string; kind?: string; db?: string }) => {
    const requestId = `ai-${Date.now().toString(36)}`;
    const full = await aiAsk(history, context, (delta) => {
      e.sender.send(IPC.AI_CHUNK, { requestId, delta });
    }, modelId, conn);
    e.sender.send(IPC.AI_DONE, { requestId });
    return full;
  });

  // —— 本地文件系统 / 对话框 ——
  handle(IPC.FS_LOCAL_LIST, (_e, dir: string) => listLocal(dir));
  handle(IPC.FS_READ, (_e, path: string) => readText(path));
  handle(IPC.FS_WRITE, (_e, path: string, content: string) => writeText(path, content));
  handle(IPC.DIALOG_OPEN, (e, opts: { kind: 'file' | 'folder' | 'save'; title?: string; defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    if (opts.kind === 'save') {
      return dialog
        .showSaveDialog(win ?? BrowserWindow.getFocusedWindow() ?? (undefined as never), { title: opts.title, defaultPath: opts.defaultPath })
        .then((r) => (r.canceled || !r.filePath ? null : r.filePath));
    }
    const properties = (opts.kind === 'folder' ? ['openDirectory'] : ['openFile']) as ('openDirectory' | 'openFile')[];
    return dialog
      .showOpenDialog(win ?? BrowserWindow.getFocusedWindow() ?? (undefined as never), { title: opts.title, defaultPath: opts.defaultPath, properties })
      .then((r) => (r.canceled || !r.filePaths.length ? null : r.filePaths[0]));
  });

  // —— 应用级 / 窗口控制 ——
  handle(IPC.APP_VERSION, () => app.getVersion());
  handle(IPC.APP_PLATFORM, () => process.platform);
  // —— 通用偏好（设置表单即时生效）——
  handle(IPC.PREFS_GET, () => loadGeneralPrefs());
  handle(IPC.PREFS_SET, (_e, p) => saveGeneralPrefs(p));
  handle(IPC.FOLDERS_GET, () => loadFolders());
  handle(IPC.FOLDERS_SET, (_e, folders) => saveFolders(folders));
  // —— 云同步（Gitee gist）——
  handle(IPC.SYNC_GET_CONFIG, () => getSyncConfig());
  handle(IPC.SYNC_SET_CONFIG, (_e, token: string, gistId?: string) => setSyncConfig(token, gistId));
  handle(IPC.SYNC_RESET, () => resetSyncConfig());
  handle(IPC.SYNC_PUSH, (_e, token?: string) => pushSync(token));
  handle(IPC.SYNC_PULL, (_e, token?: string) => pullSync(token));
  // 真实窗口控制：最小化 / 最大化-还原 / 关闭（frameless 自绘标题栏用）
  handle(IPC.WINDOW_CONTROL, (e, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });

  // —— 原生窗口背景色跟随主题（frameless 窗口在 HTML 加载前的底色；浅色主题防白闪）——
  handle(IPC.WINDOW_SET_BG, (e, color: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win && typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) win.setBackgroundColor(color);
  });

  // —— 系统剪贴板（走主进程 electron.clipboard，比 navigator.clipboard 更稳）——
  handle(IPC.CLIPBOARD_READ, () => clipboard.readText());
  handle(IPC.CLIPBOARD_WRITE, (_e, text: string) => {
    clipboard.writeText(text);
  });

  // —— SSH 二次验证（keyboard-interactive / TOTP）回传 ——
  handle(IPC.SSH_INPUT_RESPONSE, (_e, requestId: string, answers: string[] | null) => {
    resolveSshInput(requestId, answers);
  });

  // —— OTP 动态码条目（TOTP 因子库；secret 只在主进程，列表为脱敏视图）——
  handle(IPC.OTP_LIST, () => listOtpEntryViews());
  handle(IPC.OTP_SAVE, (_e, entry: Partial<OtpEntry>) => saveOtpEntry(entry));
  handle(IPC.OTP_DELETE, (_e, id: string) => {
    deleteOtpEntry(id);
  });
  handle(
    IPC.OTP_PREVIEW,
    (_e, target: { entryId?: string; secret?: string; algorithm?: OtpEntry['algorithm']; digits?: number; period?: number }): OtpPreview => {
      const entry = target.entryId ? getOtpEntry(target.entryId) : undefined;
      const secret = target.secret?.trim() || entry?.secret;
      if (!secret) throw new Error('缺少 OTP 密钥（Base32）');
      return totp(secret, {
        algorithm: target.algorithm ?? entry?.algorithm,
        digits: target.digits ?? entry?.digits,
        period: target.period ?? entry?.period,
      });
    },
  );

  // —— 自动更新（electron-updater：check / download / install）——
  handle(IPC.UPDATE_CHECK, () => checkForUpdates());
  handle(IPC.UPDATE_DOWNLOAD, () => downloadUpdate());
  handle(IPC.UPDATE_INSTALL, () => installUpdate());

  logger.info('IPC 通道已注册（真实实现）');
}

/** 反注册（测试/热重载用） */
export function unregisterIpc(): void {
  Object.values(IPC).forEach((ch) => ipcMain.removeHandler(ch));
}
