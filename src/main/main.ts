import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { registerIpc } from './ipc';
import { initAutoUpdater } from './auto-update';
import { disposeAll } from './clients/manager';
import { loadGeneralPrefs } from './services/connection-store';
import { buildMenu } from './menu';
import { createLogger } from './logger';
import { defaultWindowState, loadWindowState, saveWindowState } from './window-state';
import { IPC } from '@shared/ipc-channels';

/**
 * Electron 主进程入口。
 *
 * 职责：
 * 1. 等待 app ready 后创建主窗口
 * 2. 注册 IPC 路由（registerIpc）
 * 3. 构建原生菜单（buildMenu）
 * 4. 根据环境加载渲染内容（dev server 或打包后的静态文件）
 *
 * 安全：contextIsolation 开启、nodeIntegration 关闭，渲染进程只经 preload 白名单通信。
 *
 * @since 0.1.0
 */
const logger = createLogger('main');

// 在 app ready 之前禁用硬件加速：无 GPU / 无显示的沙箱或远程桌面环境下，
// Electron 的 GPU 子进程会反复崩溃并触发 FATAL 退出（"GPU process isn't usable"）。
// 禁用后回退软件渲染，桌面窗口仍可正常创建与交互。
app.disableHardwareAcceleration();

// Windows 任务栏/通知归属：不设置时 dev 模式显示为 "Electron"
app.setAppUserModelId('com.dataroost.app');

/** 主窗口引用（单窗口应用） */
let mainWindow: BrowserWindow | null = null;

/** 系统托盘引用（开启「关闭时最小化到托盘」后创建） */
let tray: Tray | null = null;

/** 正在退出标记：before-quit 置位，close 事件据此放行（否则托盘驻留会拦住退出） */
let quitting = false;

/** 是否开发模式（Vite dev server 运行在 5173） */
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

/**
 * 解析窗口/任务栏图标路径。
 *
 * 打包后 Windows 用 exe 内嵌图标、macOS 用 icns，无需显式设置；
 * 开发模式（electron:dev）运行的是裸 electron.exe，必须显式传 icon，
 * 否则任务栏/Alt-Tab 显示默认 Electron 图标。
 */
function resolveWindowIcon(): string | undefined {
  const ico = join(__dirname, '../build/icon.ico');
  return existsSync(ico) ? ico : undefined;
}

/** 解析托盘图标（优先 png；都缺失时空图兜底，Windows 会显示默认图标） */
function resolveTrayIcon() {
  const png = join(__dirname, '../build/icon.png');
  if (existsSync(png)) return nativeImage.createFromPath(png);
  const ico = join(__dirname, '../build/icon.ico');
  if (existsSync(ico)) return nativeImage.createFromPath(ico);
  return nativeImage.createEmpty();
}

/**
 * 从托盘/最小化恢复主窗口：restore → show → focus。
 *
 * 注意：app.disableHardwareAcceleration()（软件渲染）下，Windows 的 hide→show
 * 存在已知的「不重绘」问题 —— 窗口显示出来但内容白屏/花屏，必须主动
 * invalidate() 强制合成器重绘一次才能恢复。
 */
function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.invalidate();
}

/** 创建系统托盘：单击恢复主窗口；右键菜单 = 显示 / 退出 */
function ensureTray(): void {
  if (tray) return;
  tray = new Tray(resolveTrayIcon());
  tray.setToolTip('DataRoost');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => showMainWindow());
}

/**
 * 关闭事件拦截：开启「关闭时最小化到托盘」且非退出流程时，
 * 隐藏窗口并保持全部连接后台存活；托盘「退出」或未开启时正常关闭。
 */
function handleMainWindowClose(e: Electron.Event): void {
  if (quitting) return;
  let closeToTray = false;
  try {
    closeToTray = loadGeneralPrefs().closeToTray === true;
  } catch {
    /* 偏好读取失败按默认行为关闭 */
  }
  if (closeToTray) {
    e.preventDefault();
    mainWindow?.hide();
    ensureTray();
  }
}

/** 创建主窗口：恢复上次的尺寸/位置/最大化状态（真实桌面应用标准行为） */
function createWindow(): void {
  const saved = loadWindowState();
  const state = saved ?? defaultWindowState();

  mainWindow = new BrowserWindow({
    title: 'DataRoost',
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0d0d0d',
    ...(resolveWindowIcon() ? { icon: resolveWindowIcon() } : {}),
    // 窗口 chrome 按平台走真实系统行为：
    // - macOS: hiddenInset 隐藏标题栏，系统原生红黄绿按钮显示在左上角（真实系统控件）
    // - Windows/Linux: frame:false 去掉原生标题栏，由渲染层 TitleBar 提供真实的最小化/最大化/关闭（IPC → BrowserWindow）
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 恢复最大化状态（要在 show 前调用，避免闪一下小窗）
  if (state.isMaximized) mainWindow.maximize();

  // 拖动 / 缩放：防抖持久化窗口状态；最大化切换：即时推送渲染端同步按钮图标
  let saveTimer: NodeJS.Timeout | null = null;
  const persist = () => {
    if (!mainWindow) return;
    saveWindowState({ ...mainWindow.getBounds(), isMaximized: mainWindow.isMaximized() });
  };
  const schedulePersist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };
  mainWindow.on('resize', schedulePersist);
  mainWindow.on('move', schedulePersist);
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send(IPC.WINDOW_MAXIMIZED, true);
    persist();
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send(IPC.WINDOW_MAXIMIZED, false);
    schedulePersist();
  });
  mainWindow.on('close', (e) => handleMainWindowClose(e));
  mainWindow.on('close', persist);

  // 加载渲染内容
  if (isDev) {
    // 统一使用 IPv4 地址，与 Vite dev server 的 host: '127.0.0.1' 保持一致
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  buildMenu(mainWindow);
  mainWindow.on('closed', () => (mainWindow = null));
  // 诊断用：捕获渲染进程消失并打印原因，便于定位偶发崩溃（开发期）
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`渲染进程消失（reason=${details.reason}, exitCode=${details.exitCode}）`);
  });
}

// 诊断用：主进程未捕获异常 / 未处理的 Promise 拒绝，一律打印，避免静默退出
process.on('uncaughtException', (err) => {
  logger.error(`主进程未捕获异常: ${(err as Error).stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`主进程未处理的拒绝: ${reason}`);
});
app.on('quit', (_event, exitCode) => {
  logger.info(`app quit, exitCode=${exitCode}`);
});

// 应用就绪后启动
app.whenReady().then(() => {
  registerIpc();
  initAutoUpdater();
  createWindow();

  // macOS 开发模式：打包后用 icns，开发时裸 Electron 需显式设置 Dock 图标
  if (process.platform === 'darwin' && app.dock) {
    const png = join(__dirname, '../build/icon.png');
    if (existsSync(png)) app.dock.setIcon(png);
  }

  // macOS：点击 dock 图标重建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 除 macOS 外，所有窗口关闭即退出
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前清理所有真实连接（SSH/DB/Redis），避免资源泄漏
app.on('before-quit', () => {
  quitting = true;
  tray?.destroy();
  tray = null;
  disposeAll();
});

logger.info(`DataRoost 启动 (dev=${isDev})`);
