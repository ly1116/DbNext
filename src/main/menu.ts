import { Menu, type BrowserWindow, app } from 'electron';
import { createLogger } from './logger';

/**
 * 应用菜单（原生菜单栏）。
 *
 * 提供标准的文件 / 编辑 / 视图 / 帮助 菜单；「视图」中的开发者工具开关
 * 仅在开发模式（未打包且非 production 环境）开放，生产构建不暴露，
 * 避免被随意打开控制台。
 *
 * @since 0.1.0
 */
const logger = createLogger('menu');

/** 开发模式：未打包且非显式 production 环境（与 main.ts 保持一致） */
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

/** 构建并应用菜单 */
export function buildMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin';
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'reload', label: '重新加载' },
  ];
  // 开发者工具仅在开发模式开放；生产构建不显示该菜单项
  if (isDev) {
    viewSubmenu.push({
      label: '开发者工具',
      accelerator: 'CmdOrCtrl+Shift+I',
      click: () => win.webContents.toggleDevTools(),
    });
  }
  viewSubmenu.push({ role: 'togglefullscreen', label: '全屏' });

  // 基础模板（Windows / Linux 与 macOS 共用文件/编辑/视图/帮助）
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ label: '新建连接', accelerator: 'CmdOrCtrl+N' }, { type: 'separator' }, { role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
      ],
    },
    {
      label: '视图',
      submenu: viewSubmenu,
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 DataRoost', click: () => logger.info(`DataRoost v${app.getVersion()}`) }],
    },
  ];

  // macOS：拼成符合系统规范的菜单栏
  // - 前置 App 菜单（关于 / 隐藏 / 显示其他 / 退出）
  // - 「文件」里的「退出」与 App 菜单重复，去掉避免两处退出
  // - 末尾加「窗口」菜单（最小化 / 缩放 / 全部置于顶层）
  if (isMac) {
    const fileMenu = template.find((m) => m.label === '文件');
    if (fileMenu && Array.isArray(fileMenu.submenu)) {
      fileMenu.submenu = (fileMenu.submenu as Electron.MenuItemConstructorOptions[]).filter(
        (s) => (s as Electron.MenuItemConstructorOptions).role !== 'quit',
      );
    }
    const appMenu: Electron.MenuItemConstructorOptions = {
      label: 'DataRoost',
      submenu: [
        { role: 'about', label: '关于 DataRoost' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 DataRoost' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出 DataRoost' },
      ],
    };
    const windowMenu: Electron.MenuItemConstructorOptions = {
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '全部置于顶层' },
      ],
    };
    template.unshift(appMenu);
    template.push(windowMenu);
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // 开发模式允许 F12 打开控制台；生产模式禁用（防误触 / 被随意打开）
  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}
