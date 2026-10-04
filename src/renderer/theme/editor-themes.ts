import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';
import type { ThemeName } from '@shared/types';
import { UI_THEMES } from './ui-themes';

/**
 * CodeMirror 编辑器主题工厂：跟随「设置 → 外观 → 配色方案」（prefs.theme）。
 *
 * - 颜色全部取自 UI_THEMES 调色板，与整体 UI 同源换肤；
 * - 浅色主题（light）自动标记 dark:false，语法高亮用对应浅色 token；
 * - 返回扩展数组，配合 Compartment 在主题切换时热替换。
 *
 * @since 0.4.1
 */
export function editorTheme(name: ThemeName): Extension[] {
  const p = UI_THEMES[name] ?? UI_THEMES.darcula;
  const highlight = HighlightStyle.define([
    { tag: t.comment, color: p.dim2, fontStyle: 'italic' },
    { tag: t.keyword, color: p.blue },
    { tag: [t.controlKeyword, t.moduleKeyword], color: p.purple },
    { tag: [t.string, t.special(t.string)], color: p.str },
    { tag: [t.number, t.integer, t.float], color: p.num },
    { tag: [t.bool, t.null, t.atom], color: p.blue },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: p.fn },
    { tag: [t.typeName, t.className, t.self], color: p.fn },
    { tag: t.definition(t.variableName), color: p.fg },
    { tag: [t.variableName, t.propertyName], color: p.fg },
    { tag: [t.operator, t.operatorKeyword], color: p.purple },
    { tag: [t.punctuation, t.bracket, t.separator], color: p.dim },
    { tag: [t.meta, t.documentMeta], color: p.dim },
    { tag: t.invalid, color: p.prod },
  ]);
  const isLight = name === 'light';
  return [
    EditorView.theme(
      {
        '&': { color: p.fg, backgroundColor: p.panel },
        '.cm-content': { caretColor: p.accent2 },
        '&.cm-focused': { outline: 'none' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: p.accent2 },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
          backgroundColor: p.sel,
        },
        '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: p.dim2 },
        '.cm-activeLine': { backgroundColor: `${p.fg}0d` },
        '.cm-activeLineGutter': { backgroundColor: `${p.fg}0d` },
        '.cm-tooltip': { border: `1px solid ${p.line2}`, backgroundColor: p.panel2, color: p.fg },
        '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' },
        // 补全列表当前选中项：用强调色 + 白字，保证任何主题下都一眼可见
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected], .cm-tooltip-autocomplete > ul > li[aria-selected]': {
          backgroundColor: p.accent2,
          color: '#ffffff',
          fontWeight: '600',
        },
        '.cm-tooltip.cm-tooltip-autocomplete > ul > li:hover': { backgroundColor: `${p.fg}14` },
        '.cm-panels': { backgroundColor: p.panel2, color: p.fg },
        '.cm-searchMatch': { backgroundColor: `${p.warn}40` },
        '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: `${p.warn}80` },
        // 「@ai 提及」记号高亮（见 theme/ai-mention.ts）：小圆角徽标，明确去掉链接式下划线
        '.cm-mention-ai': {
          color: p.purple,
          fontWeight: '600',
          backgroundColor: `${p.purple}26`,
          borderRadius: '4px',
          padding: '0 2px',
          textDecoration: 'none',
        },
      },
      { dark: !isLight },
    ),
    syntaxHighlighting(highlight, { fallback: true }),
  ];
}
