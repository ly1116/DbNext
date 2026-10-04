import type { ThemeName } from '@shared/types';

/**
 * UI 配色方案（设置 → 系统 → 外观 → 配色方案）。
 *
 * 仅提供两套：深色（Darcula， VS Code Dark+ 风格）与浅色（DbNest Light）。
 * 终端配色随同一选择切换，UI 与终端共用 prefs.theme。
 *
 * 与终端主题（terminal-themes.ts）同源：数据库区 / 导航器 / 标签页 / 对话框等
 * 全部通过 CSS 变量（--c-*，存 RGB 通道三元组）取色，切换主题即整体换肤。
 *
 * 调色板字段与 tailwind.config 的 colors 一一对应（外加 sel 选中高亮）。
 *
 * @since 0.4.0
 */

/** UI 取色 token（值均为十六进制，applyUiTheme 时转为 RGB 通道三元组写入 CSS 变量） */
export interface UiPalette {
  bg: string;
  panel: string;
  panel2: string;
  panel3: string;
  line: string;
  line2: string;
  fg: string;
  dim: string;
  dim2: string;
  accent: string;
  accent2: string;
  prod: string;
  ok: string;
  warn: string;
  purple: string;
  blue: string;
  str: string;
  num: string;
  fn: string;
  ai: string;
  ai2: string;
  /** 选中行 / 焦点高亮（树 / 网格 / 标签激活态） */
  sel: string;
}

export const UI_THEMES: Record<ThemeName, UiPalette> = {
  /** Darcula（默认深色，VS Code Dark+ 风格） */
  darcula: {
    bg: '#181818',
    panel: '#1f1f1f',
    panel2: '#252526',
    panel3: '#2d2d30',
    line: '#2d2d30',
    line2: '#3e3e42',
    fg: '#cccccc',
    dim: '#858585',
    dim2: '#6a6a6a',
    accent: '#0e639c',
    accent2: '#1177bb',
    prod: '#e5484d',
    ok: '#4ec9b0',
    warn: '#e5a00d',
    purple: '#c586c0',
    blue: '#569cd6',
    str: '#ce9178',
    num: '#b5cea8',
    fn: '#dcdcaa',
    ai: '#7c5cff',
    ai2: '#9d7cff',
    sel: '#094771',
  },
  /**
   * 浅色（「DbNest Light」）：冷调中性灰底 + 单一利落蓝强调色，
   * 比旧 VS Code Light 仿色对比度更高、分隔线更可见、选中态更明确。
   * 语义色（prod/ok/warn/ai）与深色主题同源，深浅主题切换时认知一致。
   */
  light: {
    bg: '#f4f5f7',
    panel: '#ffffff',
    panel2: '#f6f7f9',
    panel3: '#eef1f4',
    line: '#e8ebef',
    line2: '#d4d9e0',
    fg: '#1f2733',
    dim: '#5c6675',
    dim2: '#8b95a3',
    accent: '#2f6feb',
    accent2: '#5b8def',
    prod: '#e5484d',
    ok: '#18a558',
    warn: '#d98a00',
    purple: '#8e4ec6',
    blue: '#2f6feb',
    str: '#c2255c',
    num: '#0f9d8a',
    fn: '#7a3ff2',
    ai: '#7c5cff',
    ai2: '#9d7cff',
    sel: '#dce8ff',
  },
};

/** 各 token 对应的 CSS 变量名（与 tailwind.config 的 colors 映射一致） */
const TOKEN_VARS: Record<keyof UiPalette, string> = {
  bg: '--c-bg',
  panel: '--c-panel',
  panel3: '--c-panel3',
  line: '--c-line',
  line2: '--c-line2',
  fg: '--c-fg',
  dim: '--c-dim',
  dim2: '--c-dim2',
  accent: '--c-accent',
  accent2: '--c-accent2',
  prod: '--c-prod',
  ok: '--c-ok',
  warn: '--c-warn',
  purple: '--c-purple',
  blue: '--c-blue',
  str: '--c-str',
  num: '--c-num',
  fn: '--c-fn',
  ai: '--c-ai',
  ai2: '--c-ai2',
  sel: '--c-sel',
  // panel2 映射到 --c-panel2
  panel2: '--c-panel2',
};

/** #rrggbb → "r g b"（供 tailwind 的 rgb(var(--c-x) / <alpha-value>) 与 rgb(var(--c-x)) 使用） */
function hexToChannels(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/**
 * 把指定主题写入 <html> 的 CSS 变量，并同步数据库区基准字号（--pref-fs）。
 * 任何组件只要用 bg-bg / text-fg / border-line 等 token 即自动换肤。
 */
export function applyUiTheme(theme: ThemeName, fontSize: number): void {
  const pal = UI_THEMES[theme] ?? UI_THEMES.darcula;
  const root = document.documentElement;
  (Object.keys(TOKEN_VARS) as (keyof UiPalette)[]).forEach((tok) => {
    root.style.setProperty(TOKEN_VARS[tok], hexToChannels(pal[tok]));
  });
  // 数据库区基准字号：设置「字体大小」+ 10% 整体放大（用户反馈数据库区字号偏小）
  root.style.setProperty('--pref-fs', `${fontSize}px`);
}
