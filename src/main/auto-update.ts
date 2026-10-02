import { app, BrowserWindow, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC } from '@shared/ipc-channels';
import type { UpdateStatus } from '@shared/types';
import { createLogger } from './logger';

/**
 * 自动更新服务（electron-updater + GitHub Releases 分发）。
 *
 * 工作原理：
 * - 从 GitHub Release 读取 `latest.yml` 元数据，比对当前版本；
 * - 检查到新版本后后台自动下载（不自动安装，安装需用户确认以防误重启）；
 * - 下载完成推送「重启并更新」；未签名场景（Windows/macOS 当前构建未签名）
 *   quitAndInstall 会抛签名错误，自动退回到打开发布页手动下载；
 * - Linux AppImage 更新不依赖签名，可正常静默安装。
 *
 * 注意：
 * - 开发模式（app.isPackaged=false）不启用，避免误拉云端版本；
 * - 私有仓库需设置 `GH_TOKEN` 环境变量（运行时读取），否则更新接口返回 404/401。
 *
 * @since 0.1.1
 */

const logger = createLogger('auto-update');

/** 更新源（与 package.json build.publish 保持一致） */
const REPO = { owner: 'ly1116', repo: 'DbNext' } as const;
const RELEASES_URL = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;

let initialized = false;

/** 渲染端订阅的更新状态（主 → 渲染 推送） */
/** 把更新状态广播给所有窗口（渲染端 About 面板据此展示） */
function broadcast(payload: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(IPC.UPDATE_STATUS, payload);
  }
}

/** 初始化自动更新：仅打包后启用；启动 3 秒后静默检查一次 */
export function initAutoUpdater(): void {
  if (initialized) return;
  initialized = true;

  if (!app.isPackaged) {
    logger.info('自动更新已跳过（开发模式）');
    return;
  }

  // 由用户确认后再安装，避免静默重启打断工作
  autoUpdater.autoDownload = false;
  autoUpdater.allowDowngrade = false;

  // 私有仓库：运行时读取 GH_TOKEN 作为认证头（不硬编码）
  if (process.env.GH_TOKEN) {
    autoUpdater.requestHeaders = { authorization: `token ${process.env.GH_TOKEN}` };
  }

  // 确定性指定 GitHub feed（不依赖 app-update.yml 生成）
  try {
    autoUpdater.setFeedURL({ provider: 'github', owner: REPO.owner, repo: REPO.repo });
  } catch (e) {
    logger.error(`设置更新源失败: ${(e as Error).message}`);
  }

  autoUpdater.on('checking-for-update', () => broadcast({ type: 'checking' }));

  autoUpdater.on('update-available', (info) => {
    // 归一化 releaseNotes（electron-updater 可能返回 string | ReleaseNoteInfo[] | null）
    const notes = info.releaseNotes
      ? Array.isArray(info.releaseNotes)
        ? info.releaseNotes.map((n) => ({ version: n.version, notes: n.note == null ? '' : Array.isArray(n.note) ? n.note.join('\n') : n.note }))
        : info.releaseNotes
      : undefined;
    broadcast({ type: 'available', version: info.version, releaseNotes: notes });
    // 后台自动下载（不阻塞用户），下载进度与完成由下方事件推送
    autoUpdater.downloadUpdate().catch((e) => {
      const msg = (e as Error).message;
      logger.error(`下载更新失败: ${msg}`);
      broadcast({ type: 'error', message: msg, fallbackUrl: RELEASES_URL });
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    broadcast({ type: 'not-available', version: info.version });
  });

  autoUpdater.on('download-progress', (p) => {
    broadcast({ type: 'progress', percent: p.percent, transferred: p.transferred, total: p.total });
  });

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ type: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    const msg = (err as Error)?.message || String(err);
    // 未签名 / 签名损坏 / 拉取失败 → 引导用户去发布页手动下载
    const sigProblem = /not signed|signature|code signature|404|401|403/i.test(msg);
    broadcast({ type: 'error', message: msg, fallbackUrl: sigProblem ? RELEASES_URL : undefined });
    logger.error(`自动更新出错: ${msg}`);
  });

  // 启动后静默检查一次（仅通知，下载由 update-available 自动触发）
  setTimeout(() => {
    autoUpdater
      .checkForUpdates()
      .catch((e) => logger.error(`检查更新失败: ${(e as Error).message}`));
  }, 3000);
}

/** 渲染端「检查更新」按钮：手动触发一次检查 */
export function checkForUpdates(): void {
  if (!app.isPackaged) {
    broadcast({ type: 'error', message: '开发模式下不检查更新（请使用已打包的安装包）' });
    return;
  }
  autoUpdater.checkForUpdates().catch((e) => logger.error(`checkForUpdates 失败: ${(e as Error).message}`));
}

/** 渲染端「下载更新」按钮（若 available 事件未自动下载或失败重试） */
export function downloadUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.downloadUpdate().catch((e) => {
    const msg = (e as Error).message;
    logger.error(`下载更新失败: ${msg}`);
    broadcast({ type: 'error', message: msg, fallbackUrl: RELEASES_URL });
  });
}

/** 渲染端「重启并更新」按钮 */
export function installUpdate(): void {
  if (!app.isPackaged) return;
  try {
    // isSilent=false 显示安装进度；isForceRunAfter=true 装完自动重启
    autoUpdater.quitAndInstall(false, true);
  } catch (e) {
    // 未签名场景：quitAndInstall 抛签名错误，退回打开发布页手动更新
    const msg = (e as Error).message;
    logger.error(`自动安装失败，退回发布页: ${msg}`);
    shell.openExternal(RELEASES_URL);
  }
}
