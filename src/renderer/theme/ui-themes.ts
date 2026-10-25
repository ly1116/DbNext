import type { ThemeName } from '@shared/types';

/**
 * UI 配色方案（设置 → 系统 → 外观 → 配色方案）。
 *
 * 仅提供两套：深色（Darcula 精调版）与浅色（DbNest Light）。
 * 终端配色随同一选择切换，UI 与终端共用 prefs.theme。
 *
 * 调色板与 `design/` 下的高保真原型稿（objects-page-redesign / data-grid-redesign）
 * 严格一致：冷调中性灰底、单一利落蓝强调色、克制的语义色，深浅主题切换时认知一致。
 *
 * 与 tailwind.config 的 colors 一一对应（外加 sel 选中高亮、fg2 次级文字、
 * hover 行悬停底、okBg/warnBg/prodBg 语义浅底）。
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
  fg2: string;
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
  /** 行悬停底（网格 / 列表 / 树） */
  hover: string;
  /** 语义浅底：成功 / 警告 / 危险（标签、徽章、状态点背景） */
  okBg: string;
  warnBg: string;
  prodBg: string;
}

const DARCULA: UiPalette = {
  bg: '#0f1319',
  panel: '#161b23',
  panel2: '#1a202a',
  panel3: '#1f2733',
  line: '#232b37',
  line2: '#2e3846',
  fg: '#e6eaf1',
  fg2: '#b3bdcc',
  dim: '#7c8797',
  dim2: '#5b6575',
  accent: '#4d8dff',
  accent2: '#3b7bf0',
  prod: '#f0645e',
  ok: '#3ecf8e',
  warn: '#eba544',
  purple: '#c586c0',
  blue: '#6cb6ff',
  str: '#ce9178',
  num: '#b5cea8',
  fn: '#dcdcaa',
  ai: '#7b45e0',
  ai2: '#9d7cff',
  sel: '#1c3a5e',
  hover: '#1f2733',
  okBg: '#10301e',
  warnBg: '#332312',
  prodBg: '#391a19',
};

const LIGHT: UiPalette = {
  bg: '#f4f6f9',
  panel: '#ffffff',
  panel2: '#fafbfc',
  panel3: '#f2f4f7',
  line: '#e9edf2',
  line2: '#dfe4ec',
  fg: '#18202e',
  fg2: '#47536a',
  dim: '#7c8698',
  dim2: '#a3acbb',
  accent: '#3b82f6',
  accent2: '#2563eb',
  prod: '#d1453b',
  ok: '#16935f',
  warn: '#c2790a',
  purple: '#8e4ec6',
  blue: '#2f6feb',
  str: '#c2255c',
  num: '#0f9d8a',
  fn: '#7a3ff2',
  ai: '#7b45e0',
  ai2: '#9d7cff',
  sel: '#e3ecfd',
  hover: '#f2f4f7',
  okBg: '#e6f6ec',
  warnBg: '#fdf1e0',
  prodBg: '#fbebea',
};

export const UI_THEMES: Record<ThemeName, UiPalette> = {
  /**
   * Darcula（精调深色）：冷调近黑底 + 利落蓝强调，比旧版更通透、对比更干净。
   * 与浅色主题同源，切换时语义色一致。
   */
  darcula: DARCULA,
  /**
   * 浅色（「DbNest Light」）：冷调中性灰底 + 单一利落蓝强调色，
   * 比旧 VS Code Light 仿色对比度更高、分隔线更可见、选中态更明确。
   * 语义色（prod/ok/warn/ai）与深色主题同源，深浅主题切换时认知一致。
   */
  light: LIGHT,
  /**
   * 玻璃拟态（暗色 Glassmorphism）：文本 / 语义 token 与 darcula 同源（保证暗色下文字清晰、
   * 语义色一致），真正的「半透明 + 磨砂」表面观感由 index.css 的 `[data-glass="1"]` 层统一重写
   *（bg-bg / bg-panel* / border-line* 与 .card/.btn/.ipt 等全局类在玻璃态自动转为 frosted glass）。
   * 此处仅提供基底 token；applyUiTheme 在 theme === 'glass' 时写 data-glass=1 触发 CSS 层。
   */
  glass: { ...DARCULA, bg: '#0b0f1a' },
};

/**
 * 玻璃拟态（暗色 Glassmorphism）：文本 / 语义 token 与 darcula 同源（保证暗色下文字清晰、
 * 语义色一致），真正的「半透明 + 磨砂」表面观感由 index.css 的 `[data-glass="1"]` 层统一重写
 *（bg-bg / bg-panel* / border-line* 与 .card/.btn/.ipt 等全局类在玻璃态自动转为 frosted glass）。
 * 此处仅提供基底 token；applyUiTheme 在 theme === 'glass' 时写 data-glass=1 触发 CSS 层。
 */

/** 各 token 对应的 CSS 变量名（与 tailwind.config 的 colors 映射一致） */
const TOKEN_VARS: Record<keyof UiPalette, string> = {
  bg: '--c-bg',
  panel: '--c-panel',
  panel2: '--c-panel2',
  panel3: '--c-panel3',
  line: '--c-line',
  line2: '--c-line2',
  fg: '--c-fg',
  fg2: '--c-fg2',
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
  hover: '--c-hover',
  okBg: '--c-ok-bg',
  warnBg: '--c-warn-bg',
  prodBg: '--c-prod-bg',
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
 * 主题名归一化：历史持久化数据里曾用正确拼写 `dracula`，而代码内部统一用
 * `darcula`（`d-a-r-c`，早期约定）。二者指向同一套深色配色，此处归一化，
 * 避免「偏好写的是 dracula、但 `.dark` 类因严格相等判断未挂载」导致暗色主题失效（黑屏）。
 */
const THEME_ALIASES: Record<string, ThemeName> = { dracula: 'darcula' };
export function normalizeTheme(t: string): ThemeName {
  return (THEME_ALIASES[t] ?? t) as ThemeName;
}

/**
 * 把指定主题写入 <html> 的 CSS 变量，并同步数据库区基准字号（--pref-fs）。
 * 任何组件只要用 bg-bg / text-fg / border-line 等 token 即自动换肤。
 *
 * 圆角（--c-radius）与阴影（--c-shadow）为深浅主题共用的全局尺度，
 * 在此一并写入，保证全应用圆角/阴影尺度统一。
 */
export function applyUiTheme(theme: ThemeName, fontSize: number): void {
  const t = normalizeTheme(theme);
  const pal = UI_THEMES[t] ?? UI_THEMES.darcula;
  const root = document.documentElement;
  // 玻璃拟态开关：写入 data-glass 属性，index.css 据此把全部表面类重写为磨砂玻璃
  root.setAttribute('data-glass', t === 'glass' ? '1' : '0');
  // shadcn/ui 暗色模式：暗色主题（darcula / glass）在 <html> 挂 .dark，
  // index.css 的 .dark 规则随之把 shadcn HSL 令牌（--background 等）切换为暗色值
  root.classList.toggle('dark', t === 'darcula' || t === 'glass');
  (Object.keys(TOKEN_VARS) as (keyof UiPalette)[]).forEach((tok) => {
    root.style.setProperty(TOKEN_VARS[tok], hexToChannels(pal[tok]));
  });
  // 数据库区基准字号：设置「字体大小」整体放大 10%（用户反馈数据库区字号偏小）
  root.style.setProperty('--pref-fs', `${fontSize}px`);
  // 全局尺度：玻璃态略增圆角，更契合磨砂面板的厚度感；深浅主题保持克制
  const isGlass = theme === 'glass';
  root.style.setProperty('--c-radius', isGlass ? '10px' : '8px');
  root.style.setProperty('--c-radius-lg', isGlass ? '14px' : '12px');
  // 阴影：浅色用极淡双层投影；深色用低透明黑柔光；玻璃用更柔更散的投影（内高光由 CSS 玻璃层补）
  const shadow = theme === 'light'
    ? '0 1px 2px rgb(16 24 40 / .05), 0 6px 18px rgb(16 24 40 / .08)'
    : isGlass
      ? '0 8px 32px rgb(0 0 0 / .40)'
      : '0 1px 2px rgb(0 0 0 / .35), 0 8px 24px rgb(0 0 0 / .35)';
  root.style.setProperty('--c-shadow', shadow);
}
