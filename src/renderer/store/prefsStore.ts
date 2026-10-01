import { create } from 'zustand';
import { api } from '@renderer/api';
import { DEFAULT_PREFS, type GeneralPrefs } from '@shared/types';

/**
 * 通用偏好 store（渲染端单一事实来源）。
 *
 * - 应用启动时 load() 一次，设置弹窗与消费方（终端字体/配色、AI 默认模型…）
 *   统一从这里订阅，修改即时传播到所有使用处；
 * - patch() 乐观更新并异步写回主进程持久化（设置表单无「应用」按钮的前提）。
 *
 * @since 0.1.0
 */
interface PrefsState {
  prefs: GeneralPrefs;
  /** 已成功从主进程加载过（浏览器预览下保持默认值） */
  loaded: boolean;
  load: () => Promise<void>;
  /** 局部修改偏好：乐观更新 + 落盘 */
  patch: (p: Partial<GeneralPrefs>) => void;
}

/** 把缩放偏好应用到界面（webFrame；浏览器预览降级为 body zoom） */
function applyZoom(factor: number): void {
  try {
    api.setZoomFactor(factor);
  } catch {
    /* ignore */
  }
}

/**
 * 落盘防抖：多个设置面板挂载/初始化时会各自 patch 一次，若每次都立即写盘
 * （且大多只是把默认值再写一遍），会造成启动期连续 8 次文件写入。
 * 这里合并到 400ms 后的单次写入；值与上次已落盘一致则直接跳过。
 */
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedJson = '';

function flushSave(prefs: GeneralPrefs): void {
  const json = JSON.stringify(prefs);
  if (json === lastSavedJson) return; // 无变化，跳过
  lastSavedJson = json;
  api.setGeneralPrefs(prefs).catch(() => undefined);
}

/** 调度一次合并落盘（覆盖未触发的上一次） */
function scheduleSave(prefs: GeneralPrefs): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSave(prefs);
  }, SAVE_DEBOUNCE_MS);
}

/** 同步刷新：在窗口卸载/退出前确保最后一次修改已落盘 */
function flushPending(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    flushSave(usePrefs.getState().prefs);
  }
}

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: { ...DEFAULT_PREFS },
  loaded: false,

  load: async () => {
    try {
      const p = await api.getGeneralPrefs();
      lastSavedJson = JSON.stringify(p); // 基准，避免加载后立即回写
      set({ prefs: p, loaded: true });
      applyZoom(p.zoomFactor); // 启动即恢复上次缩放
    } catch {
      /* 浏览器预览：保持默认值 */
    }
  },

  patch: (p) => {
    const next = { ...get().prefs, ...p };
    set({ prefs: next }); // 乐观更新 → 控件与消费方立即生效
    applyZoom(next.zoomFactor);
    scheduleSave(next); // 防抖合并写入，避免启动期重复落盘
  },
}));

// 退出/卸载前强制刷新未触发的落盘，避免最后改动丢失
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushPending);
}
