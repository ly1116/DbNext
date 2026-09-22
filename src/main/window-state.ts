import { app, screen } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger';

/**
 * 窗口状态持久化（真实桌面应用标准行为）。
 *
 * 把主窗口的位置 / 大小 / 最大化状态存到 `userData/window-state.json`，
 * 下次启动原样恢复；首次启动（无存档）按当前屏幕工作区自适应并默认最大化。
 * 拖动 / 缩放过程中防抖保存，关闭时兜底保存一次。
 *
 * @since 0.1.0
 */
const logger = createLogger('win-state');

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const file = () => join(app.getPath('userData'), 'window-state.json');

/** 读取上次窗口状态；损坏 / 不存在返回 null（调用方走首次启动默认值） */
export function loadWindowState(): WindowState | null {
  try {
    const raw = readFileSync(file(), 'utf8');
    const s = JSON.parse(raw) as WindowState;
    if (!Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;
    // 防御：存档位置落在已拔掉的显示器上时丢弃位置，仅保留尺寸
    if (s.x !== undefined && s.y !== undefined && !isPointOnAnyDisplay(s.x, s.y)) {
      logger.info('窗口存档位置不在任何显示器上，丢弃位置仅保留尺寸');
      return { width: s.width, height: s.height, isMaximized: s.isMaximized };
    }
    return s;
  } catch {
    return null; // 首次启动 / 文件不存在 / JSON 损坏
  }
}

/** 持久化窗口状态（resize/move 防抖调用，close 兜底调用） */
export function saveWindowState(state: WindowState): void {
  try {
    writeFileSync(file(), JSON.stringify(state), 'utf8');
  } catch (e) {
    logger.warn(`窗口状态保存失败: ${(e as Error).message}`);
  }
}

/** 首次启动默认值：直接最大化（无存档时以全屏姿态出现，之后由状态存档接管） */
export function defaultWindowState(): WindowState {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  return { width: Math.min(1600, wa.width), height: Math.min(1000, wa.height), isMaximized: true };
}

function isPointOnAnyDisplay(x: number, y: number): boolean {
  return screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return x >= b.x - 50 && x <= b.x + b.width + 50 && y >= b.y - 50 && y <= b.y + b.height + 50;
  });
}
