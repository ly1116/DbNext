import type { ThemeName } from '@shared/types';
import type { ITheme } from 'xterm';

/**
 * 终端配色方案（设置 → 系统 → 外观 → 配色方案）。
 *
 * 五套经典终端主题的真实 xterm 色板；基准前景/背景与各主题官方定义对齐，
 * 光标与选区色取自同系亮色，保证暗色面板下可读。
 *
 * @since 0.1.0
 */
export function terminalTheme(name: ThemeName): ITheme {
  return THEMES[name] ?? THEMES.darcula;
}

const THEMES: Record<ThemeName, ITheme> = {
  /** JetBrains Darcula（默认，与应用整体 VS Code 风格一致） */
  darcula: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#aeafad',
    cursorAccent: '#1e1e1e',
    selection: '#214283',
    black: '#000000',
    red: '#ff6b68',
    green: '#a8c023',
    yellow: '#d6bf6b',
    blue: '#5394ec',
    magenta: '#a771bf',
    cyan: '#4fcad0',
    white: '#d4d4d4',
    brightBlack: '#555555',
    brightRed: '#ff8785',
    brightGreen: '#bcda46',
    brightYellow: '#e6d580',
    brightBlue: '#7cb2ff',
    brightMagenta: '#c393dc',
    brightCyan: '#71e0e5',
    brightWhite: '#ffffff',
  },
  /** Dracula */
  dracula: {
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selection: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  /** Nord */
  nord: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selection: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  /** Monokai */
  monokai: {
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selection: '#49483e',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  /** Gruvbox Dark */
  gruvbox: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selection: '#504945',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
};
