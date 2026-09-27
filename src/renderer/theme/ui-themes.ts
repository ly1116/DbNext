import type { ThemeName } from '@shared/types';

/**
 * UI 配色方案（设置 → 系统 → 外观 → 配色方案）。
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
  /** JetBrains Darcula（默认，VS Code Dark+ 风格） */
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
  /** Dracula */
  dracula: {
    bg: '#21222c',
    panel: '#282a36',
    panel2: '#343746',
    panel3: '#44475a',
    line: '#44475a',
    line2: '#6272a4',
    fg: '#f8f8f2',
    dim: '#a6accd',
    dim2: '#6272a4',
    accent: '#bd93f9',
    accent2: '#ff79c6',
    prod: '#ff5555',
    ok: '#50fa7b',
    warn: '#f1fa8c',
    purple: '#ff79c6',
    blue: '#8be9fd',
    str: '#f1fa8c',
    num: '#bd93f9',
    fn: '#50fa7b',
    ai: '#bd93f9',
    ai2: '#ff79c6',
    sel: '#44475a',
  },
  /** Nord */
  nord: {
    bg: '#2e3440',
    panel: '#3b4252',
    panel2: '#434c5e',
    panel3: '#4c566a',
    line: '#434c5e',
    line2: '#4c566a',
    fg: '#d8dee9',
    dim: '#a3acba',
    dim2: '#4c566a',
    accent: '#88c0d0',
    accent2: '#81a1c1',
    prod: '#bf616a',
    ok: '#a3be8c',
    warn: '#ebcb8b',
    purple: '#b48ead',
    blue: '#81a1c1',
    str: '#a3be8c',
    num: '#d08770',
    fn: '#88c0d0',
    ai: '#b48ead',
    ai2: '#d3869b',
    sel: '#434c5e',
  },
  /** Monokai */
  monokai: {
    bg: '#272822',
    panel: '#2f3127',
    panel2: '#3e3d32',
    panel3: '#49483e',
    line: '#49483e',
    line2: '#75715e',
    fg: '#f8f8f2',
    dim: '#ccccc7',
    dim2: '#75715e',
    accent: '#66d9ef',
    accent2: '#a6e22e',
    prod: '#f92672',
    ok: '#a6e22e',
    warn: '#f4bf75',
    purple: '#ae81ff',
    blue: '#66d9ef',
    str: '#e6db74',
    num: '#ae81ff',
    fn: '#a6e22e',
    ai: '#ae81ff',
    ai2: '#fd971f',
    sel: '#49483e',
  },
  /** Gruvbox Dark */
  gruvbox: {
    bg: '#282828',
    panel: '#3c3836',
    panel2: '#504945',
    panel3: '#504945',
    line: '#504945',
    line2: '#665c54',
    fg: '#ebdbb2',
    dim: '#bdae93',
    dim2: '#665c54',
    accent: '#83a598',
    accent2: '#d79921',
    prod: '#fb4934',
    ok: '#b8bb26',
    warn: '#fabd2f',
    purple: '#d3869b',
    blue: '#83a598',
    str: '#b8bb26',
    num: '#d3869b',
    fn: '#fabd2f',
    ai: '#d3869b',
    ai2: '#fe8019',
    sel: '#504945',
  },
  /** 浅色（白，VS Code Light 风格） */
  light: {
    bg: '#f3f3f3',
    panel: '#ffffff',
    panel2: '#f8f8f8',
    panel3: '#ececec',
    line: '#e0e0e0',
    line2: '#c8c8c8',
    fg: '#1f1f1f',
    dim: '#5a5a5a',
    dim2: '#8a8a8a',
    accent: '#005fb8',
    accent2: '#0a7bd4',
    prod: '#d13438',
    ok: '#107c41',
    warn: '#b7791f',
    purple: '#af00db',
    blue: '#0033b3',
    str: '#a31515',
    num: '#098658',
    fn: '#795e26',
    ai: '#6256f0',
    ai2: '#7b6cff',
    sel: '#cce4f7',
  },
};

/** 各 token 对应的 CSS 变量名（与 tailwind.config 的 colors 映射一致） */
const TOKEN_VARS: Record<keyof UiPalette, string> = {
  bg: '--c-bg',
  panel: '--c-panel',
  panel2: '--c-panel2',
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
