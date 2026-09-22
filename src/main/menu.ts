import { Menu, type BrowserWindow, app } from 'electron';
import { createLogger } from './logger';

/**
 * 应用菜单（原生菜单栏）。
 *
 * 提供标准的文件 / 编辑 / 视图 / 帮助 菜单，并在「视图」中提供开发者工具开关，
 * 在「帮助」中提供关于。生产环境可按平台裁剪。
 *
 * @since 0.1.0
 */
const logger = createLogger('menu');

/** 构建并应用菜单 */
export function buildMenu(win: BrowserWindow): void {
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
      submenu: [
        { role: 'reload', label: '重新加载' },
        {
          label: '开发者工具',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => win.webContents.toggleDevTools(),
        },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 DbNest', click: () => logger.info(`DbNest v${app.getVersion()}`) }],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  // 让渲染进程可通过 F12 触发开发者工具
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });
}
