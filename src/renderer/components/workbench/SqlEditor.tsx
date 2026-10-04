import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { sql, PostgreSQL, MySQL } from '@codemirror/lang-sql';
import { autocompletion } from '@codemirror/autocomplete';
import { editorTheme } from '@renderer/theme/editor-themes';
import { makeSqlComplete } from '@renderer/theme/sql-completion';
import { aiMentionComplete, aiMentionHighlighter } from '@renderer/theme/ai-mention';
import { usePrefs } from '@renderer/store/prefsStore';

/**
 * SQL 编辑器（CodeMirror 6 封装）。
 *
 * - 语法高亮（lang-sql）+ 编辑器主题跟随「设置 → 外观 → 配色方案」（prefs.theme，Compartment 热切换）；
 * - 智能提示：SQL 关键字 + 当前库的表/列名（schema 由父组件内省后传入，表名小写键）；
 * - Ctrl/⌘+Enter 触发执行（通过 onRun 回调）；
 * - onChange 节流不必要重渲染：父组件用 ref 读取最新值即可。
 *
 * @since 0.3.0
 */
export function SqlEditor({
  initialValue,
  schema,
  dialect,
  onRun,
  onRunScript,
  onSave,
  onChange,
  injectRef,
  insertRef,
  selectionRef,
  className,
}: {
  initialValue?: string;
  /** 表名(小写) -> 列名数组；支持 "schema.table" 限定键（lang-sql 原生按点分层，PG 全 schema 内省用）；为空时仅关键字提示 */
  schema?: Record<string, string[]>;
  /** 方言：决定关键字/语法高亮与补全的词表（postgres / mysql）；缺省走标准 SQL */
  dialect?: 'postgres' | 'mysql';
  /** Ctrl/⌘+Enter 执行（父组件约定：有选中时只执行选中） */
  onRun?: () => void;
  /** Ctrl/⌘+Shift+Enter 脚本运行（编辑器全文按多语句顺序执行） */
  onRunScript?: () => void;
  /** Ctrl/⌘+S 保存脚本（通过父组件弹框命名） */
  onSave?: () => void;
  onChange?: (value: string) => void;
  /** 外部注入内容：父组件调用 injectRef.current?.(sql) 可整体替换编辑器文本（历史回填等） */
  injectRef?: { current: ((v: string) => void) | null };
  /** 外部读取当前选中文本：父组件调用 selectionRef.current?.() 取选中内容（无选中返回 ''） */
  selectionRef?: { current: (() => string) | null };
  /** 外部在光标处插入文本：父组件调用 insertRef.current?.(text) 在当前光标/选区插入（对象树点选列/表名） */
  insertRef?: { current: ((v: string) => void) | null };
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const schemaComp = useRef(new Compartment());
  const acComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const onRunRef = useRef(onRun);
  const onRunScriptRef = useRef(onRunScript);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  onRunRef.current = onRun;
  onRunScriptRef.current = onRunScript;
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
  // 读取当前选中文本（运行选中专用）
  if (selectionRef) selectionRef.current = () => {
    const view = viewRef.current;
    if (!view) return '';
    return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  };
  // 在光标处插入文本（对象树点选表/列名）
  if (insertRef) insertRef.current = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  };

  // 只创建一次实例
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;
    const { sqlAutoComplete, sqlUppercaseKeywords, theme } = usePrefs.getState().prefs;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialValue ?? '',
        extensions: [
          basicSetup,
          themeComp.current.of(editorTheme(theme)),
          EditorView.theme({
            '&': { height: '100%', fontSize: 'calc(var(--pref-fs, 14px) * 1.1)' },
            '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto' },
          }),
          schemaComp.current.of(sql({ dialect: dialect === 'postgres' ? PostgreSQL : dialect === 'mysql' ? MySQL : undefined, schema: schema ?? {}, upperCaseKeywords: sqlUppercaseKeywords })),
          // 自定义补全（覆盖 lang-sql 原生）：解析 FROM/JOIN 别名后按作用域提示字段/表/关键字；@ 触发 ai 提及；偏好可整体关闭
          acComp.current.of(sqlAutoComplete ? autocompletion({ override: [aiMentionComplete, makeSqlComplete(schema ?? {}, dialect)] }) : []),
          // @ai 记号高亮（跟随主题点缀色）
          aiMentionHighlighter,
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
                key: 'Mod-Shift-Enter',
                run: () => {
                  onRunScriptRef.current?.();
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

  // schema（表/列清单）或补全偏好变化时热替换补全数据源（语法扩展与自定义补全源一起重建）
  const sqlAutoComplete = usePrefs((s) => s.prefs.sqlAutoComplete);
  const sqlUppercaseKeywords = usePrefs((s) => s.prefs.sqlUppercaseKeywords);
  // 编辑器主题跟随「设置 → 外观 → 配色方案」实时换肤
  const theme = usePrefs((s) => s.prefs.theme);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        schemaComp.current.reconfigure(sql({ dialect: dialect === 'postgres' ? PostgreSQL : dialect === 'mysql' ? MySQL : undefined, schema: schema ?? {}, upperCaseKeywords: sqlUppercaseKeywords })),
        acComp.current.reconfigure(sqlAutoComplete ? Prec.highest(autocompletion({ override: [aiMentionComplete, makeSqlComplete(schema ?? {}, dialect)] })) : []),
        themeComp.current.reconfigure(editorTheme(theme)),
      ],
    });
  }, [schema, sqlAutoComplete, sqlUppercaseKeywords, dialect, theme]);

  return <div ref={hostRef} className={className ?? 'h-full min-h-0 overflow-hidden'} />;
}
