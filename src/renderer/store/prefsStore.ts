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

export const usePrefs = create<PrefsState>((set, get) => ({
  prefs: { ...DEFAULT_PREFS },
  loaded: false,

  load: async () => {
    try {
      const p = await api.getGeneralPrefs();
      set({ prefs: p, loaded: true });
    } catch {
      /* 浏览器预览：保持默认值 */
    }
  },

  patch: (p) => {
    const next = { ...get().prefs, ...p };
    set({ prefs: next }); // 乐观更新 → 控件与消费方立即生效
    api.setGeneralPrefs(next).catch(() => undefined);
  },
}));
