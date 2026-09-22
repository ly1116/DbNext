import type { DbnestApi } from './vite-env';

/**
 * 渲染进程 API 封装。
 *
 * 优先调用主进程注入的 `window.dbnest`（Electron 环境，真实实现）。
 * 纯浏览器预览（`npm run web`）下无 preload，所有方法明确拒绝并提示「请使用桌面端」，
 * **不再返回任何 mock 假数据**——避免用假数据掩盖未连后端的事实。
 *
 * @since 0.1.0
 */
const host = typeof window !== 'undefined' ? window.dbnest : undefined;

const NOT_DESKTOP = '当前为浏览器预览模式，无真实后端。请用桌面端（npm run electron:dev）连接服务器。';

/** 浏览器预览模式的诚实降级：一律拒绝，绝不编造数据 */
const browserFallback: DbnestApi = {
  getVersion: async () => '0.0.0 (web-preview)',
  getPlatform: async () => 'browser' as const,
  windowControl: async () => {},
  listConnections: async () => { throw new Error(NOT_DESKTOP); },
  saveConnection: async () => { throw new Error(NOT_DESKTOP); },
  deleteConnection: async () => { throw new Error(NOT_DESKTOP); },
  testConnection: async () => { throw new Error(NOT_DESKTOP); },
  connect: async () => { throw new Error(NOT_DESKTOP); },
  disconnect: async () => { throw new Error(NOT_DESKTOP); },
  exportProfile: async () => { throw new Error(NOT_DESKTOP); },
  importProfile: async () => { throw new Error(NOT_DESKTOP); },
  terminalCreate: async () => { throw new Error(NOT_DESKTOP); },
  terminalWrite: () => { throw new Error(NOT_DESKTOP); },
  terminalResize: () => { throw new Error(NOT_DESKTOP); },
  terminalExit: () => { throw new Error(NOT_DESKTOP); },
  onTerminalData: () => () => {},
  listDir: async () => { throw new Error(NOT_DESKTOP); },
  stat: async () => { throw new Error(NOT_DESKTOP); },
  mkdir: async () => { throw new Error(NOT_DESKTOP); },
  remove: async () => { throw new Error(NOT_DESKTOP); },
  rename: async () => { throw new Error(NOT_DESKTOP); },
  touch: async () => { throw new Error(NOT_DESKTOP); },
  upload: async () => { throw new Error(NOT_DESKTOP); },
  download: async () => { throw new Error(NOT_DESKTOP); },
  uploadDir: async () => { throw new Error(NOT_DESKTOP); },
  downloadDir: async () => { throw new Error(NOT_DESKTOP); },
  listTransfers: async () => [],
  onTransferProgress: () => () => {},
  redisKeys: async () => { throw new Error(NOT_DESKTOP); },
  redisGet: async () => { throw new Error(NOT_DESKTOP); },
  runSql: async () => { throw new Error(NOT_DESKTOP); },
  listDatabases: async () => { throw new Error(NOT_DESKTOP); },
  createDatabase: async () => { throw new Error(NOT_DESKTOP); },
  listTables: async () => { throw new Error(NOT_DESKTOP); },
  listColumns: async () => { throw new Error(NOT_DESKTOP); },
  tableData: async () => { throw new Error(NOT_DESKTOP); },
  listSchemas: async () => { throw new Error(NOT_DESKTOP); },
  listObjects: async () => { throw new Error(NOT_DESKTOP); },
  runDiff: async () => { throw new Error(NOT_DESKTOP); },
  getAiSettings: async () => ({ enabled: false, models: [] }),
  setAiSettings: async (s) => s,
  aiAsk: async () => { throw new Error(NOT_DESKTOP); },
  onAiChunk: () => () => {},
  onAiDone: () => () => {},
  getGeneralPrefs: async () => (await import('@shared/types')).DEFAULT_PREFS,
  setGeneralPrefs: async (p) => p,
  getFolders: async () => [],
  setFolders: async (f) => f,
  getSyncConfig: async () => ({ hasToken: false, hasPassphrase: false, gistId: '' }),
  setSyncConfig: async () => ({ hasToken: false, hasPassphrase: false, gistId: '' }),
  pushSync: async () => { throw new Error(NOT_DESKTOP); },
  pullSync: async () => { throw new Error(NOT_DESKTOP); },
  toggleDevTools: () => {},
  onConnectionStatus: () => () => {},
  onMaximized: () => () => {},
  localList: async () => { throw new Error(NOT_DESKTOP); },
  readFile: async () => { throw new Error(NOT_DESKTOP); },
  writeFile: async () => { throw new Error(NOT_DESKTOP); },
  openDialog: async () => { throw new Error(NOT_DESKTOP); },
  clipboardRead: async () => { throw new Error(NOT_DESKTOP); },
  clipboardWrite: async () => { throw new Error(NOT_DESKTOP); },
  pathForFile: () => '',
  onSshInputRequest: () => () => {},
  sshInputRespond: async () => {},
};

/** 对外暴露的统一 API（Electron 优先，浏览器诚实拒绝） */
export const api: DbnestApi = host ?? browserFallback;

/** 当前是否运行在真实桌面端 */
export const isDesktop = !!host;
