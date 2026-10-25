import { useEffect, useRef, useState } from 'react';
import type { Extension } from '@codemirror/state';
import { StreamLanguage, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { yaml as yamlLegacy } from '@codemirror/legacy-modes/mode/yaml';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { html } from '@codemirror/lang-html';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { usePrefs } from '@renderer/store/prefsStore';
import { UI_THEMES } from '@renderer/theme/ui-themes';

/**
 * Nacos 屏公共工具：格式常量 / 类型推断 / 编辑器语言扩展 / 下载 / 左右分栏拖拽。
 * 从 NacosScreen 拆出，供配置页、服务页、编辑器、同步弹窗共用。
 */

/** 详情页格式 chips（对齐参考实现：TEXT JSON XML YAML HTML Properties TOML） */
export const FORMAT_CHIPS = ['TEXT', 'JSON', 'XML', 'YAML', 'HTML', 'Properties', 'TOML'] as const;
/** chip → nacos type 小写值（用于高亮匹配） */
export const chipType = (chip: string) => chip.toLowerCase();

/** 每页条数可选项 */
export const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100] as const;

/** 推断新建配置默认格式（按 dataId 后缀启发式；命中不了回退 text） */
export function inferType(dataId: string): string {
  const lower = dataId.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.js')) return 'json';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.properties') || lower.endsWith('.conf') || lower.endsWith('.cfg') || lower.endsWith('.ini')) return 'properties';
  return 'text';
}

/** 格式 chip 是否高亮（编辑态按当前类型；新建未选按 dataId 推断） */
export function chipActive(chip: string, type: string): boolean {
  const c = chipType(chip);
  if (c === 'properties') return type === 'properties';
  return c === type;
}

/** 列表「格式」列的色调（按类型微区分，保持克制） */
export function fmtToneClass(fmt: string): string {
  switch (fmt) {
    case 'yaml':
    case 'yml':
      return 'text-warning';
    case 'json':
      return 'text-success';
    case 'xml':
    case 'html':
      return 'text-destructive';
    case 'properties':
    case 'toml':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * YAML 专属高亮（基于 legacy yaml mode，自带 tokenizer）。
 * 实测 legacy mode 对各语法单元产出的 tag 为：
 *   - 键名            → tags.atom              （注意：不是 propertyName）
 *   - 引号字符串       → tags.string
 *   - 数字            → tags.number
 *   - true/false/on/off… → tags.keyword
 *   - &锚点 / *别名    → tags.variableName
 *   - --- / ... 文档标记 → tags.definition(variableName)
 *   - 注释            → tags.comment
 *   - 分隔符/列表符/块标量 → tags.meta（: - | > { } [ ] ,）
 * 编辑器通用高亮把这些大部分映射成前景白，故单独给 YAML 一套克制配色：
 * 键名蓝、字符串橙红、数字绿、布尔蓝、注释灰斜体、结构灰。不影响 json/xml 等其它语言。
 */
export function yamlThemeHighlight(): Extension {
  const theme = usePrefs.getState().prefs.theme ?? 'darcula';
  const p = UI_THEMES[theme] ?? UI_THEMES.darcula;
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.atom, color: p.blue }, // YAML 键名
      { tag: [t.string, t.special(t.string)], color: p.str },
      { tag: [t.number, t.integer, t.float], color: p.num },
      { tag: [t.keyword, t.bool, t.null], color: p.blue }, // true/false/on/off…
      { tag: t.variableName, color: p.fn }, // &anchor / *alias
      { tag: t.definition(t.variableName), color: p.dim2 }, // --- / ... 文档标记
      { tag: t.comment, color: p.dim2, fontStyle: 'italic' },
      { tag: [t.meta, t.documentMeta], color: p.dim }, // : / - / | / > / {}[] ,
      { tag: [t.punctuation, t.separator, t.bracket], color: p.dim }, // 兜底（内联结构）
    ]),
  );
}

/** 配置类型 → CodeMirror 语法高亮扩展（自动适配：yaml/json/xml/html/properties/toml，text 无高亮） */
export function langExtensionOf(type: string, dataId: string): Extension | null {
  const t = (type || inferType(dataId)).toLowerCase();
  if (t === 'yaml') return [StreamLanguage.define(yamlLegacy), yamlThemeHighlight()];
  if (t === 'json') return json();
  if (t === 'xml') return xml();
  if (t === 'html') return html({ matchClosingTags: false });
  if (t === 'properties') return StreamLanguage.define(properties);
  if (t === 'toml') return StreamLanguage.define(toml);
  return null;
}

/** 折叠标记 DOM：对齐参考编辑器行号旁的小箭头（展开 ⌄ / 收起 ›） */
export function foldMarkerDOM(open: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cm-fold-marker';
  span.innerHTML = `<svg viewBox="0 0 12 12" width="10" height="10" style="opacity:.5"><path d="${open ? 'M3 4.5 6 7.5 9 4.5' : 'M4.5 3 7.5 6 4.5 9'}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return span;
}

/** 将文本作为文件下载（导出 / 另存为 / 批量导出共用） */
export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 左右分栏拖拽 hook：返回容器 ref / 左宽百分比 / 拖拽事件（clamp 20%~70%，双击回默认） */
export function useSplitter(defaultPct = 42) {
  const splitRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(defaultPct);
  const drag = useRef<{ startX: number; startPct: number } | null>(null);
  const onSplitDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startPct: leftPct };
    e.preventDefault();
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = drag.current.startPct + ((e.clientX - drag.current.startX) / rect.width) * 100;
      setLeftPct(Math.min(70, Math.max(20, pct)));
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);
  return { splitRef, leftPct, onSplitDown, setLeftPct };
}

/** 分隔线（悬停/拖拽高亮，双击恢复默认） */
export function Splitter({ onDown, onReset }: { onDown: (e: React.PointerEvent) => void; onReset: () => void }) {
  return (
    <div onPointerDown={onDown} onDoubleClick={onReset} className="group relative w-1 shrink-0 cursor-col-resize bg-background" title="拖拽调节左右宽度">
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/70" />
    </div>
  );
}
