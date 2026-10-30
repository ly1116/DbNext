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
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

/** 项目根目录（scripts 的上级），不依赖调用方 cwd */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 复用当前 Node 运行时启动 Vite 子进程 */
const nodeBin = process.execPath;

/**
 * Windows 控制台代码页修正（终端中文乱码的根因）。
 *
 * 现象：`npm run electron:dev` 后，主进程日志里的中文在终端显示为「瀵嗛挜」式乱码，
 * 英文部分正常 —— 这是 **UTF-8 字节被按 GBK(936) 解码** 的典型特征。
 *
 * 原因：Electron 主进程以 UTF-8 字节写 stdout；当控制台输出代码页是 936 时，
 * conhost 会拿 GBK 去解释这些字节，于是中文全变乱码（英文 ASCII 两种编码一致，故不受影响）。
 *
 * 修复：启动阶段把**当前控制台**的输出代码页切到 65001(UTF-8)。控制台代码页是
 * 控制台级共享属性，Vite / Electron 子进程都挂着同一个控制台，中文输出即恢复正常。
 * 已是 65001（Windows Terminal / 现代终端默认 UTF-8）时不做任何事。
 *
 * @returns {boolean} 控制台是否已处于 UTF-8（供调用方决定是否给出兜底提示）
 */
function ensureUtf8Console() {
  if (process.platform !== 'win32') return true;

  /** 读取当前控制台输出代码页（chcp 输出「活动代码页: 936」，只取数字，规避本地化文案差异） */
  const readCp = () => {
    try {
      const out = spawnSync('chcp.com', [], { encoding: 'utf8', windowsHide: true });
      const m = String(out.stdout ?? '').match(/(\d{3,5})/);
      return m ? m[1] : '';
    } catch {
      return '';
    }
  };

  const before = readCp();
  if (before === '65001') return true;

  try {
    // 注意必须给子进程有效句柄（用管道捕获输出）；stdio:'ignore' 下 chcp 会因句柄无效而直接退出，切换不生效。
    spawnSync('chcp.com', ['65001'], { encoding: 'utf8', windowsHide: true });
  } catch {
    // 非控制台环境（输出被重定向到文件/管道）时忽略：此场景不存在解码问题
    return true;
  }

  const after = readCp();
  if (after === '65001') {
    console.log(`[electron-dev] 控制台代码页 ${before || '?'} → UTF-8(65001)，避免日志中文乱码`);
    return true;
  }
  console.warn(
    '[electron-dev] 未能自动切换控制台代码页，日志中文可能仍乱码；请在本终端先执行 `chcp 65001` 再启动。',
  );
  return false;
}

ensureUtf8Console();


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
  // ELECTRON_DEBUG_PORT 环境变量非空时开启 CDP 远程调试端口，
  // 便于自动化截图/诊断（如 playwright 连接、Page.captureScreenshot）。

  // 无头 / 沙箱模式：仅在 ELECTRON_HEADLESS=1（或显式开启调试端口用于截图诊断）时，
  // 才关闭 GPU 与软件光栅化并改用 swiftshader 软件渲染 —— 这是受限环境稳定拉起窗口所必需。
  // ⚠️ 真实桌面（有显示器）绝不可传 --disable-gpu + --disable-software-rasterizer：
  // 二者同时禁用会清空所有渲染后端，导致 frameless 窗口"建出但画不出内容"，
  // 表现为「进程在跑、却看不到窗口、也无报错」。故默认走正常启动（保留 GPU）。
  const headless = childEnv.ELECTRON_HEADLESS === '1' || childEnv.ELECTRON_HEADLESS === 'true';
  // 本机直启开关：部分 macOS 安全策略下 Electron 会因 sandbox 初始化失败（Operation not permitted）
  // 而崩溃（GPU 进程 SIGTRAP）。ELECTRON_NO_SANDBOX=1 时在正常（有显示器）模式也加 --no-sandbox，
  // 仅关闭 Chromium 沙箱、保留 GPU 渲染后端，窗口可正常显示；不传则维持默认行为。
  const noSandbox =
    childEnv.ELECTRON_NO_SANDBOX === '1' || childEnv.ELECTRON_NO_SANDBOX === 'true';
  const args = ['--disable-dev-shm-usage'];
  if (headless) {
    args.push(
      '--headless=new',
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--window-size=1440,860',
    );
  }
  if (noSandbox) {
    args.push('--no-sandbox');
  }
  if (process.env.ELECTRON_DEBUG_PORT) {
    args.push(`--remote-debugging-port=${process.env.ELECTRON_DEBUG_PORT}`);
  }
  args.push('.');
  electron = spawn(electronExe, args, {
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

/**
 * 强制结束 Electron 进程。
 * Windows 下 `child.kill()` 默认发 SIGTERM，常杀不掉 Electron 及其 GPU/工具子进程，
 * 导致退出后残留"僵尸"实例（之前表现为多个隐藏窗口互相打架、窗口打不开）。
 * 因此 Windows 走 `taskkill /PID <pid> /T /F` 杀整棵进程树，其他平台用 SIGKILL。
 */
function killElectron() {
  if (!electron || electron.pid == null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(electron.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      /* 回退到 SIGKILL */
    }
  }
  try {
    electron.kill('SIGKILL');
  } catch {
    /* 忽略已退出进程 */
  }
}

/** 统一清理子进程，避免端口/进程残留 */
function cleanup() {
  try {
    vite?.kill();
  } catch {
    /* 忽略 */
  }
  killElectron();
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
process.on('SIGHUP', cleanup);
