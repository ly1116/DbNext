/**
 * Electron 开发模式启动器（一体化）。
 *
 * 职责：
 * 1. 确保 Vite dev server 已在 http://localhost:5173 提供渲染层。
 *    - 若 5173 已被占用（例如已单独运行 `npm run web`），直接复用，不再重复拉起；
 *    - 否则自行 spawn Vite dev server 并等待端口就绪。
 * 2. 端口就绪后启动 Electron，主进程（main.ts）会 loadURL('http://localhost:5173')。
 * 3. 监听退出信号，在 Electron 关闭时清理 Vite 子进程，避免残留 dev server 占用端口。
 *
 * 用法：node scripts/electron-dev.mjs   （等价于修复后的 `npm run electron:dev`）
 *
 * @since 0.1.0
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

/** 项目根目录（scripts 的上级），不依赖调用方 cwd */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 复用当前 Node 运行时启动 Vite 子进程 */
const nodeBin = process.execPath;

/**
 * Electron 可执行文件：
 * - Windows 直接用 electron.exe 二进制启动（切勿用 `node electron/cli.js`，
 *   否则 cli.js 在非 Electron 运行时下加载主进程，require("electron").app 为 undefined）。
 * - 其他平台使用 PATH 中的 electron 命令（由 electron 包的 bin 指向其运行时）。
 */
const electronExe =
  process.platform === 'win32'
    ? resolve(root, 'node_modules/electron/dist/electron.exe')
    : 'electron';

/** Vite / Electron 子进程引用，便于退出时统一清理 */
let vite = null;
let electron = null;

/**
 * 探测 5173 端口是否已被监听（可能已有外部 Vite 在运行）。
 * @param {(open: boolean) => void} cb 端口开放状态回调
 */
function probePort(cb) {
  const sock = net.connect(5173, '127.0.0.1');
  sock.on('connect', () => {
    sock.destroy();
    cb(true);
  });
  sock.on('error', () => {
    sock.destroy();
    cb(false);
  });
}

/**
 * 轮询等待 5173 端口就绪（用于自行拉起的 Vite）。
 * @param {() => void} cb 就绪回调
 */
function waitPort(cb) {
  const tryOnce = () => {
    const sock = net.connect(5173, '127.0.0.1');
    sock.on('connect', () => {
      sock.destroy();
      cb();
    });
    sock.on('error', () => {
      sock.destroy();
      setTimeout(tryOnce, 500);
    });
  };
  tryOnce();
}

/** 自行拉起 Vite dev server，就绪后回调 */
function startVite(cb) {
  console.log('[electron-dev] 启动 Vite dev server (http://localhost:5173) ...');
  vite = spawn(nodeBin, ['node_modules/vite/bin/vite.js'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  vite.on('error', (err) => console.error('[electron-dev] Vite 启动失败:', err.message));
  waitPort(cb);
}

/** 启动 Electron 桌面窗口 */
function startElectron() {
  console.log('[electron-dev] 启动 Electron 窗口 ...');
  // 清理可能干扰 Electron 正常启动的环境变量：
  // ELECTRON_RUN_AS_NODE 会让 electron 退化成普通 Node，导致 require("electron") 返回异常，
  // 主进程因此无法拿到 app / BrowserWindow 等 API。
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  // 开启 Electron 内部日志（崩溃/子进程异常会打印到 stderr，便于诊断），
  // 用 log-level=1 只保留 error 及以上级别，避免刷屏。
  childEnv.ELECTRON_ENABLE_LOGGING = '1';
  electron = spawn(
    electronExe,
    [
      // 受限 / 沙箱环境下 GPU 子进程常因权限无法启动并触发 FATAL 退出，
      // 关闭 GPU 与子进程沙箱、改用软件渲染可稳定拉起窗口（仅开发期）。
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--log-level=1',
      '--enable-logging=stderr',
      '.',
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: childEnv,
    },
  );
  electron.on('error', (err) => console.error('[electron-dev] Electron 启动失败:', err.message));
  electron.on('exit', (code, signal) => {
    console.log(`[electron-dev] Electron 退出：code=${code} signal=${signal}`);
    // 给 Electron 子进程的 stderr 留出 flush 时间，避免崩溃日志被提前截断
    setTimeout(() => {
      try {
        vite?.kill();
      } catch {
        /* 忽略已退出进程 */
      }
      process.exit(code ?? 0);
    }, 500);
  });
}

/** 统一清理子进程，避免端口/进程残留 */
function cleanup() {
  try {
    vite?.kill();
  } catch {
    /* 忽略 */
  }
  try {
    electron?.kill();
  } catch {
    /* 忽略 */
  }
  process.exit(0);
}

// 先探测端口，避免重复拉起 Vite
probePort((open) => {
  if (open) {
    console.log('[electron-dev] 检测到 5173 已有服务，直接复用');
    startElectron();
  } else {
    startVite(startElectron);
  }
});

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
