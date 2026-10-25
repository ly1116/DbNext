import { app, clipboard, dialog, BrowserWindow, shell } from 'electron';
import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type { SyncAutoPush } from '@shared/types';
import { getSyncConfig, setSyncConfig, resetSyncConfig, pushSync, pullSync } from '../services/sync.service';
import { listLocal, readText, writeText } from '../services/local-fs.service';
import { resolveSshInput } from '../services/ssh-input';
import { checkForUpdates, downloadUpdate, installUpdate } from '../auto-update';
import { loadGeneralPrefs, saveGeneralPrefs, loadFolders, saveFolders } from '../services/connection-store';

/** 本地文件系统 / 对话框 / 窗口控制 / 剪贴板 / 云同步 / 自动更新 等通用 IPC 通道。 */
export function registerMiscIpc(): void {
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
  // 外部链接：交给系统默认浏览器（渲染端 window.open 只会开应用内子窗口）
  handle(IPC.OPEN_EXTERNAL, (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    throw new Error(`拒绝打开非 http(s) 外链：${url}`);
  });
  // —— 通用偏好（设置表单即时生效）——
  handle(IPC.PREFS_GET, () => loadGeneralPrefs());
  handle(IPC.PREFS_SET, (_e, p) => saveGeneralPrefs(p));
  handle(IPC.FOLDERS_GET, () => loadFolders());
  handle(IPC.FOLDERS_SET, (_e, folders) => saveFolders(folders));
  // —— 云同步（Gitee gist）——
  handle(IPC.SYNC_GET_CONFIG, () => getSyncConfig());
  handle(IPC.SYNC_SET_CONFIG, (_e, token: string, gistId?: string, autoPush?: SyncAutoPush, pullOnStartup?: boolean) =>
    setSyncConfig(token, gistId, autoPush, pullOnStartup));
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

  // —— 自动更新（electron-updater：check / download / install）——
  handle(IPC.UPDATE_CHECK, () => checkForUpdates());
  handle(IPC.UPDATE_DOWNLOAD, () => downloadUpdate());
  handle(IPC.UPDATE_INSTALL, () => installUpdate());
}
