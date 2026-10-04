import type { ThemeName } from '@shared/types';
import type { ITheme } from 'xterm';

/**
 * 终端配色方案（设置 → 系统 → 外观 → 配色方案）。
 *
 * 仅两套：深色（Darcula，与应用整体风格一致）+ 浅色（白，VS Code Light 风格），
 * 与 UI 配色方案共用同一个 prefs.theme，切换即整体换肤。
 *
 * @since 0.1.0
 */
export function terminalTheme(name: ThemeName): ITheme {
  return THEMES[name] ?? THEMES.darcula;
}

const THEMES: Record<ThemeName, ITheme> = {
  /** JetBrains Darcula（默认深色，与应用整体 VS Code 风格一致） */
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
  /** 浅色（白，VS Code Light 风格） */
  light: {
    background: '#ffffff',
    foreground: '#1f1f1f',
    cursor: '#1f1f1f',
    cursorAccent: '#ffffff',
    selection: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#107c41',
    yellow: '#b7791f',
    blue: '#005fb8',
    magenta: '#af00db',
    cyan: '#0e7c7b',
    white: '#555555',
    brightBlack: '#8a8a8a',
    brightRed: '#d13438',
    brightGreen: '#28a745',
    brightYellow: '#e5a00d',
    brightBlue: '#0a7bd4',
    brightMagenta: '#c586c0',
    brightCyan: '#23a4a3',
    brightWhite: '#1f1f1f',
  },
};
