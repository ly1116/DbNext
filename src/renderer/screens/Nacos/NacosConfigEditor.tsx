import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentUnit, foldGutter, foldKeymap } from '@codemirror/language';
import { editorTheme } from '@renderer/theme/editor-themes';
import { usePrefs } from '@renderer/store/prefsStore';
import { foldMarkerDOM, langExtensionOf } from './nacosShared';

/**
 * 配置内容编辑器（CodeMirror 6 封装，模块级组件）。
 *
 * - 语法高亮按配置类型自动切换（Compartment 热重载），行号 / 折叠箭头 / 括号匹配 / 撤销历史；
 * - 内容外部更新（切换配置 / 读取详情）时整篇替换；用户输入经 onChange 回写父状态，
 *   回写后 value === doc 时不重复 dispatch，避免光标跳动；
 * - 主题跟随「设置 → 外观 → 配色方案」。
 */
export function NacosConfigEditor({ value, type, dataId, readOnly, onChange }: {
  value: string;
  type: string;
  dataId: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  /** 编辑器主题舱：深/浅主题切换时热替换底色与语法配色，避免编辑器停在旧主题（浅色下仍黑底） */
  const themeComp = useRef(new Compartment());
  /** 跟随「设置 → 外观 → 配色方案」；作为依赖驱动下方主题热替换 effect */
  const theme = usePrefs((s) => s.prefs.theme);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 创建实例（一次）；销毁随卸载
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter({ markerDOM: foldMarkerDOM }),
          highlightActiveLine(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          highlightSpecialChars(),
          history(),
          bracketMatching(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          langComp.current.of(langExtensionOf(type, dataId) ?? []),
          themeComp.current.of(editorTheme(theme)),
          // 关键：CodeMirror 默认 height:auto 随内容撑高，必须显式限高 100% 并让 scroller 滚动，
          // 否则长配置在 flex 容器（overflow-hidden）里被直接裁掉、无法上下滚动
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, Menlo, Consolas, "JetBrains Mono", monospace', lineHeight: '1.65' },
            '.cm-gutters': { flexShrink: 0 },
            '.cm-foldGutter': { width: '14px' },
            '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 2px', cursor: 'pointer' },
          }),
          indentUnit.of('  '),
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !readOnly) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化（切换配置 / 加载详情）→ 整篇替换；自身输入回写不触发（doc 已相等）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (doc !== value) {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: value } });
    }
  }, [value]);

  // 类型 / dataId / 主题变化 → 语言高亮热切换（YAML 专属配色随主题换肤）
  useEffect(() => {
    viewRef.current?.dispatch({ effects: langComp.current.reconfigure(langExtensionOf(type, dataId) ?? []) });
  }, [type, dataId, theme]);

  // 主题（深/浅）切换 → 编辑器底色 + 通用语法高亮热替换（修复浅色主题下编辑器仍为黑底的问题）
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(editorTheme(theme)) });
  }, [theme]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />;
}
