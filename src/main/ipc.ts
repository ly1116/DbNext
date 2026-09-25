import { app, clipboard, dialog, ipcMain, BrowserWindow } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type {
  AiMessage,
  ConnectionConfig,
  ConnectionSummary,
  DbColumn,
  DbColumnSpec,
  FileNode,
  QueryResult,
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
  listConnections,
  saveConnection,
  loadAiSettings,
  loadGeneralPrefs,
  saveGeneralPrefs,
  loadFolders,
  saveFolders,
} from './services/connection-store';
import { getSyncConfig, setSyncConfig, pushSync, pullSync } from './services/sync.service';
import {
  connect,
  disconnect,
  onStatusChange,
  statusOf,
  testConnection,
} from './clients/manager';
import { createTerminalSession, type TerminalSession } from './services/ssh.service';
import { resolveSshInput } from './services/ssh-input';
import { listDir, stat, mkdir, remove, rename, touch } from './services/sftp.service';
import { upload, download, uploadDir, downloadDir } from './services/transfer.service';
import { keys as redisKeys, get as redisGet } from './services/redis.service';
import { runSql, listDatabases, listTables, listColumns, tableData, createDatabase, listSchemas, listObjects, addColumn, dropColumn, type DbObjKind } from './services/sql.service';
import { runDiff } from './services/diff.service';
import { ask as aiAsk, updateSettings } from './services/ai.service';
import { listLocal, readText, writeText } from './services/local-fs.service';

/**
 * IPC 路由注册中心。
 *
 * 将 `shared/ipc-channels` 中声明的每个通道，绑定到主进程对应的「真实」service 实现。
 * 渲染进程通过 preload 暴露的 `window.dbnest` 调用，类型两端一致。
 *
 * 所有涉及真实服务器的动作都带 connectionId，由客户端管理器取已建立的连接。
 *
 * @since 0.1.0
 */
const logger = createLogger('ipc');

/** 终端会话表：webContentsId:connectionId -> session */
const terminals = new Map<string, TerminalSession>();
const termKey = (wid: number, cid: string) => `${wid}:${cid}`;

/** 传输任务表（用于 transfer:list 快照） */
const transfers = new Map<string, TransferTask>();

/** 注册所有 IPC 处理器 */
export function registerIpc(): void {
  initConnectionStore();
  onStatusChange((id, status) => {
    // 连接状态变化时广播给所有窗口，渲染端据此刷新连接树
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC.CONNECTION_STATUS, { id, status });
    }
  });

  // —— 连接管理 ——
  ipcMain.handle(IPC.CONNECTION_LIST, (): ConnectionSummary[] => listConnections(statusOf));
  ipcMain.handle(IPC.CONNECTION_SAVE, (_e, cfg: ConnectionConfig): ConnectionSummary => saveConnection(cfg));
  ipcMain.handle(IPC.CONNECTION_DELETE, (_e, id: string) => deleteConnection(id));
  ipcMain.handle(IPC.CONNECTION_TEST, (_e, cfg: ConnectionConfig) => testConnection(cfg));
  ipcMain.handle(IPC.CONNECTION_CONNECT, (_e, id: string): Promise<ConnectionSummary> => connect(id));
  ipcMain.handle(IPC.CONNECTION_DISCONNECT, (_e, id: string) => disconnect(id));
  ipcMain.handle(IPC.CONNECTION_EXPORT, (_e, ids?: string[]) => exportProfile(ids));
  ipcMain.handle(IPC.CONNECTION_IMPORT, (_e, profile: string): ConnectionSummary[] => importProfile(profile));

  // —— SSH 终端（真实 ssh2 shell）——
  ipcMain.handle(IPC.TERMINAL_CREATE, async (e, connectionId: string, opts) => {
    const sess = await createTerminalSession(connectionId, opts ?? {});
    sess.onData((chunk) => e.sender.send(IPC.TERMINAL_DATA, { connectionId, data: chunk }));
    terminals.set(termKey(e.sender.id, connectionId), sess);
    return true;
  });
  ipcMain.handle(IPC.TERMINAL_WRITE, (e, connectionId: string, data: string) => {
    terminals.get(termKey(e.sender.id, connectionId))?.write(data);
  });
  ipcMain.handle(IPC.TERMINAL_RESIZE, (e, connectionId: string, dims: { cols: number; rows: number }) => {
    terminals.get(termKey(e.sender.id, connectionId))?.resize(dims.cols, dims.rows);
  });
  ipcMain.handle(IPC.TERMINAL_EXIT, (e, connectionId: string) => {
    terminals.get(termKey(e.sender.id, connectionId))?.dispose();
    terminals.delete(termKey(e.sender.id, connectionId));
  });

  // —— SFTP ——
  ipcMain.handle(IPC.SFTP_LIST, (_e, connectionId: string, path: string): Promise<FileNode[]> => listDir(connectionId, path));
  ipcMain.handle(IPC.SFTP_STAT, (_e, connectionId: string, path: string): Promise<FileNode> => stat(connectionId, path));
  ipcMain.handle(IPC.SFTP_MKDIR, (_e, connectionId: string, path: string) => mkdir(connectionId, path));
  ipcMain.handle(IPC.SFTP_REMOVE, (_e, connectionId: string, path: string, recursive?: boolean) => remove(connectionId, path, recursive));
  ipcMain.handle(IPC.SFTP_RENAME, (_e, connectionId: string, oldPath: string, newPath: string) => rename(connectionId, oldPath, newPath));
  ipcMain.handle(IPC.SFTP_TOUCH, (_e, connectionId: string, path: string) => touch(connectionId, path));

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
  ipcMain.handle(IPC.TRANSFER_UPLOAD, (e, connectionId: string, localPath: string, remotePath: string) =>
    trackTransfer(e, 'upload', remotePath, localPath, (onProgress) => upload(connectionId, localPath, remotePath, onProgress)));
  ipcMain.handle(IPC.TRANSFER_DOWNLOAD, (e, connectionId: string, remotePath: string, localPath: string) =>
    trackTransfer(e, 'download', remotePath, localPath, (onProgress) => download(connectionId, remotePath, localPath, onProgress)));
  ipcMain.handle(IPC.TRANSFER_UPLOAD_DIR, (e, connectionId: string, localPath: string, remotePath: string) =>
    trackTransfer(e, 'upload', remotePath, localPath, (onProgress) => uploadDir(connectionId, localPath, remotePath, onProgress)));
  ipcMain.handle(IPC.TRANSFER_DOWNLOAD_DIR, (e, connectionId: string, remotePath: string, localPath: string) =>
    trackTransfer(e, 'download', remotePath, localPath, (onProgress) => downloadDir(connectionId, remotePath, localPath, onProgress)));
  ipcMain.handle(IPC.TRANSFER_LIST, (): TransferTask[] => [...transfers.values()]);

  // —— Redis ——
  ipcMain.handle(IPC.REDIS_KEYS, (_e, connectionId: string, pattern: string): Promise<RedisEntry[]> => redisKeys(connectionId, pattern));
  ipcMain.handle(IPC.REDIS_GET, (_e, connectionId: string, key: string) => redisGet(connectionId, key));

  // —— SQL ——
  ipcMain.handle(IPC.SQL_RUN, (_e, connectionId: string, sql: string): Promise<QueryResult> => runSql(connectionId, sql));
  ipcMain.handle(IPC.SQL_DATABASES, (_e, connectionId: string): Promise<string[]> => listDatabases(connectionId));
  ipcMain.handle(IPC.SQL_CREATE_DB, (_e, connectionId: string, name: string): Promise<void> => createDatabase(connectionId, name));
  ipcMain.handle(IPC.SQL_TABLES, (_e, connectionId: string, database?: string): Promise<string[]> => listTables(connectionId, database));
  ipcMain.handle(IPC.SQL_COLUMNS, (_e, connectionId: string, schema: string, table: string, db?: string): Promise<DbColumn[]> => listColumns(connectionId, schema, table, db));
  ipcMain.handle(IPC.SQL_TABLE_DATA, (_e, connectionId: string, schema: string | undefined, table: string, limit?: number, db?: string): Promise<QueryResult> => tableData(connectionId, schema, table, limit, db));
  ipcMain.handle(IPC.SQL_SCHEMAS, (_e, connectionId: string, db?: string): Promise<string[]> => listSchemas(connectionId, db));
  ipcMain.handle(IPC.SQL_OBJECTS, (_e, connectionId: string, kind: DbObjKind, schema: string, db?: string): Promise<string[]> => listObjects(connectionId, kind, schema, db));
  ipcMain.handle(IPC.SQL_ADD_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, col: DbColumnSpec, db?: string): Promise<void> => addColumn(connectionId, schema, table, col, db));
  ipcMain.handle(IPC.SQL_DROP_COLUMN, (_e, connectionId: string, schema: string | undefined, table: string, column: string, db?: string): Promise<void> => dropColumn(connectionId, schema, table, column, db));

  // —— 结构对比 ——
  ipcMain.handle(IPC.DIFF_RUN, (_e, leftId: string, rightId: string): Promise<SchemaDiffResult> => runDiff(leftId, rightId));

  // —— AI ——
  ipcMain.handle(IPC.AI_GET_SETTINGS, () => loadAiSettings());
  ipcMain.handle(IPC.AI_SET_SETTINGS, (_e, s) => updateSettings(s));
  ipcMain.handle(IPC.AI_ASK, async (e, history: AiMessage[], context?: string[], modelId?: string, conn?: { id: string; label: string }) => {
    const requestId = `ai-${Date.now().toString(36)}`;
    const full = await aiAsk(history, context, (delta) => {
      e.sender.send(IPC.AI_CHUNK, { requestId, delta });
    }, modelId, conn);
    e.sender.send(IPC.AI_DONE, { requestId });
    return full;
  });

  // —— 本地文件系统 / 对话框 ——
  ipcMain.handle(IPC.FS_LOCAL_LIST, (_e, dir: string) => listLocal(dir));
  ipcMain.handle(IPC.FS_READ, (_e, path: string) => readText(path));
  ipcMain.handle(IPC.FS_WRITE, (_e, path: string, content: string) => writeText(path, content));
  ipcMain.handle(IPC.DIALOG_OPEN, (e, opts: { kind: 'file' | 'folder' | 'save'; title?: string; defaultPath?: string }) => {
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
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion());
  ipcMain.handle(IPC.APP_PLATFORM, () => process.platform);
  // —— 通用偏好（设置表单即时生效）——
  ipcMain.handle(IPC.PREFS_GET, () => loadGeneralPrefs());
  ipcMain.handle(IPC.PREFS_SET, (_e, p) => saveGeneralPrefs(p));
  ipcMain.handle(IPC.FOLDERS_GET, () => loadFolders());
  ipcMain.handle(IPC.FOLDERS_SET, (_e, folders) => saveFolders(folders));
  // —— 云同步（Gitee gist）——
  ipcMain.handle(IPC.SYNC_GET_CONFIG, () => getSyncConfig());
  ipcMain.handle(IPC.SYNC_SET_CONFIG, (_e, token: string, passphrase: string) => setSyncConfig(token, passphrase));
  ipcMain.handle(IPC.SYNC_PUSH, (_e, token?: string, passphrase?: string) => pushSync(token, passphrase));
  ipcMain.handle(IPC.SYNC_PULL, (_e, token?: string, passphrase?: string) => pullSync(token, passphrase));
  // 真实窗口控制：最小化 / 最大化-还原 / 关闭（frameless 自绘标题栏用）
  ipcMain.handle(IPC.WINDOW_CONTROL, (e, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === 'close') win.close();
  });

  // —— 系统剪贴板（走主进程 electron.clipboard，比 navigator.clipboard 更稳）——
  ipcMain.handle(IPC.CLIPBOARD_READ, () => clipboard.readText());
  ipcMain.handle(IPC.CLIPBOARD_WRITE, (_e, text: string) => {
    clipboard.writeText(text);
  });

  // —— SSH 二次验证（keyboard-interactive / TOTP）回传 ——
  ipcMain.handle(IPC.SSH_INPUT_RESPONSE, (_e, requestId: string, answers: string[] | null) => {
    resolveSshInput(requestId, answers);
  });

  logger.info('IPC 通道已注册（真实实现）');
}

/** 反注册（测试/热重载用） */
export function unregisterIpc(): void {
  Object.values(IPC).forEach((ch) => ipcMain.removeHandler(ch));
}
