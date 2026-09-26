import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';

/**
 * SQL 编辑器（CodeMirror 6 封装）。
 *
 * - 语法高亮（lang-sql）+ One Dark 主题；
 * - 智能提示：SQL 关键字 + 当前库的表/列名（schema 由父组件内省后传入，表名小写键）；
 * - Ctrl/⌘+Enter 触发执行（通过 onRun 回调）；
 * - onChange 节流不必要重渲染：父组件用 ref 读取最新值即可。
 *
 * @since 0.3.0
 */
export function SqlEditor({
  initialValue,
  schema,
  onRun,
  onSave,
  onChange,
  injectRef,
  className,
}: {
  initialValue?: string;
  /** 表名(小写) -> 列名数组；支持 "schema.table" 限定键（lang-sql 原生按点分层，PG 全 schema 内省用）；为空时仅关键字提示 */
  schema?: Record<string, string[]>;
  onRun?: () => void;
  /** Ctrl/⌘+S 保存脚本（通过父组件弹框命名） */
  onSave?: () => void;
  onChange?: (value: string) => void;
  /** 外部注入内容：父组件调用 injectRef.current?.(sql) 可整体替换编辑器文本（历史回填等） */
  injectRef?: { current: ((v: string) => void) | null };
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const schemaComp = useRef(new Compartment());
  const onRunRef = useRef(onRun);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onSaveRef.current = onSave;
  onChangeRef.current = onChange;

  // 整体替换编辑器内容（保留光标到开头）
  const inject = (v: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: v },
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  };
  if (injectRef) injectRef.current = inject;

  // 只创建一次实例
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue ?? '',
        extensions: [
          basicSetup,
          oneDark,
          EditorView.theme({
            '&': { height: '100%', fontSize: '12px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto' },
            '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#5c6370' },
            '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
            '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
            '.cm-tooltip': { border: '1px solid #3a3f4b', backgroundColor: '#21252b' },
          }),
          schemaComp.current.of(sql({ schema: schema ?? {}, upperCaseKeywords: true })),
          // Ctrl/⌘+Enter 执行 + Ctrl/⌘+S 保存脚本（最高优先级，避免被缩进等快捷键拦截）
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-Enter',
                run: () => {
                  onRunRef.current?.();
                  return true;
                },
              },
              {
                key: 'Mod-s',
                run: () => {
                  onSaveRef.current?.();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
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

  // schema（表/列清单）变化时热替换补全数据源
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: schemaComp.current.reconfigure(sql({ schema: schema ?? {}, upperCaseKeywords: true })),
    });
  }, [schema]);

  return <div ref={hostRef} className={className ?? 'h-full min-h-0 overflow-hidden'} />;
}
