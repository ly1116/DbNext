import { useEffect, useRef } from 'react';
import { Compartment, EditorState, Prec, StateEffect, StateField, RangeSet, type Range } from '@codemirror/state';
import { EditorView, keymap, gutter, GutterMarker, Decoration, DecorationSet } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { sql, PostgreSQL, MySQL } from '@codemirror/lang-sql';
import { autocompletion } from '@codemirror/autocomplete';
import { editorTheme } from '@renderer/theme/editor-themes';
import { makeSqlComplete } from '@renderer/theme/sql-completion';
import { aiMentionComplete, aiMentionHighlighter } from '@renderer/theme/ai-mention';
import { usePrefs } from '@renderer/store/prefsStore';

/** 行号槽内的「运行此语句」标记（Navicat 式）：点击重新运行已执行语句 */
class RunLineMarker extends GutterMarker {
  constructor(private stmtText: string, private onClick: (t: string) => void) {
    super();
  }
  override toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-run-line';
    el.textContent = '▶'; // ▶
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick(this.stmtText);
    });
    return el;
  }
}

/** 已执行语句高亮：effect 携带语句区间；field 依据区间给相关行加「圆角盒」装饰（执行后才出现） */
const setExecStmt = StateEffect.define<{ from: number; to: number } | null>();
const execStmtField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setExecStmt)) continue;
      const v = e.value;
      if (!v) { decos = Decoration.none; continue; }
      const startLine = tr.state.doc.lineAt(v.from);
      const endLine = tr.state.doc.lineAt(v.to);
      const ranges: Range<Decoration>[] = [];
      for (let i = startLine.number; i <= endLine.number; i++) {
        const ln = tr.state.doc.line(i);
        const cls = 'cm-exec-stmt' + (i === startLine.number ? ' cm-exec-stmt-first' : '') + (i === endLine.number ? ' cm-exec-stmt-last' : '');
        ranges.push(Decoration.line({ class: cls }).range(ln.from));
      }
      decos = Decoration.set(ranges, true);
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** 构建语句运行槽：仅在「已执行语句」首行显示 ▶（执行后才出现，非默认）；点击重跑该语句。
 *  用 markers（而非 lineMarker）：markers 每次 update 都会重算并与上一次 diff，故装饰驱动的
 *  「已执行语句」变化能立即刷新 ▶（lineMarker 仅在文档/视口变化时才重算）。 */
function runLineGutter(
  getOnRun: () => ((line: string) => void) | undefined,
  getExecStart: () => number | null,
  getExecText: () => string,
) {
  return gutter({
    class: 'cm-run-gutter',
    markers: (view) => {
      const cb = getOnRun();
      const startLine = getExecStart();
      if (!cb || startLine == null) return RangeSet.empty;
      let pos: number;
      try { pos = view.state.doc.line(startLine).from; } catch { return RangeSet.empty; }
      return RangeSet.of([new RunLineMarker(getExecText(), (t) => cb(t)).range(pos)]);
    },
    initialSpacer: () => new RunLineMarker('', () => {}),
  });
}

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
  onRunLine,
  onChange,
  injectRef,
  insertRef,
  selectionRef,
  highlightRef,
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
  /** 逐行运行：点击行号槽的 ▶ 时回调该行文本（Navicat 式） */
  onRunLine?: (line: string) => void;
  onChange?: (value: string) => void;
  /** 外部注入内容：父组件调用 injectRef.current?.(sql) 可整体替换编辑器文本（历史回填等） */
  injectRef?: { current: ((v: string) => void) | null };
  /** 外部读取当前选中文本：父组件调用 selectionRef.current?.() 取选中内容（无选中返回 ''） */
  selectionRef?: { current: (() => string) | null };
  /** 外部在光标处插入文本：父组件调用 insertRef.current?.(text) 在当前光标/选区插入（对象树点选列/表名） */
  insertRef?: { current: ((v: string) => void) | null };
  /** 高亮「已执行语句」：父组件执行成功后调用 highlightRef.current?.(sqlText)，编辑器给该语句加 ▶ + 圆角盒（执行后才出现） */
  highlightRef?: { current: ((v: string) => void) | null };
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
  // 逐行运行回调（Navicat 式行号槽 ▶）
  const onRunLineRef = useRef(onRunLine);
  onRunLineRef.current = onRunLine;
  // 已执行语句的区间（行号 + 文本）：供 gutter 显示 ▶、供点击重跑；执行后才被 highlightRef 写入
  const execStmtRef = useRef<{ startLine: number; endLine: number; text: string } | null>(null);

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
  // 高亮「已执行语句」：按文本在文档中定位区间 → 加圆角盒 + gutter ▶（执行后才出现）
  if (highlightRef) highlightRef.current = (raw: string) => {
    const view = viewRef.current;
    if (!view) return;
    const t = raw.trim();
    if (!t) { execStmtRef.current = null; view.dispatch({ effects: setExecStmt.of(null) }); return; }
    const idx = view.state.doc.toString().indexOf(t);
    if (idx < 0) { execStmtRef.current = null; view.dispatch({ effects: setExecStmt.of(null) }); return; }
    const from = idx;
    const to = idx + t.length;
    const startLine = view.state.doc.lineAt(from).number;
    const endLine = view.state.doc.lineAt(to).number;
    execStmtRef.current = { startLine, endLine, text: t };
    view.dispatch({ effects: setExecStmt.of({ from, to }) });
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
            '.cm-run-gutter': { width: '1.4em', padding: 0, borderRight: '1px solid hsl(var(--border))' },
            '.cm-run-line': { color: 'hsl(var(--success))', cursor: 'pointer', fontSize: '11px', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.9 },
            '.cm-run-line:hover': { opacity: 1 },
            // 已执行语句圆角盒（执行后才出现）：淡底 + 细边，首/末行补上下边与圆角
            '.cm-exec-stmt': { backgroundColor: 'hsl(var(--primary) / 0.06)', borderLeft: '1px solid hsl(var(--primary) / 0.35)', borderRight: '1px solid hsl(var(--primary) / 0.35)' },
            '.cm-exec-stmt-first': { borderTop: '1px solid hsl(var(--primary) / 0.35)', borderTopLeftRadius: '4px', borderTopRightRadius: '4px' },
            '.cm-exec-stmt-last': { borderBottom: '1px solid hsl(var(--primary) / 0.35)', borderBottomLeftRadius: '4px', borderBottomRightRadius: '4px' },
          }),
          schemaComp.current.of(sql({ dialect: dialect === 'postgres' ? PostgreSQL : dialect === 'mysql' ? MySQL : undefined, schema: schema ?? {}, upperCaseKeywords: sqlUppercaseKeywords })),
          // 自定义补全（覆盖 lang-sql 原生）：解析 FROM/JOIN 别名后按作用域提示字段/表/关键字；@ 触发 ai 提及；偏好可整体关闭
          acComp.current.of(sqlAutoComplete ? autocompletion({ override: [aiMentionComplete, makeSqlComplete(schema ?? {}, dialect)] }) : []),
          // @ai 记号高亮（跟随主题点缀色）
          aiMentionHighlighter,
          // 已执行语句圆角盒装饰（执行后才出现）
          execStmtField,
          // 语句运行槽（行号槽 ▶，仅「已执行语句」首行显示）
          runLineGutter(() => onRunLineRef.current, () => execStmtRef.current?.startLine ?? null, () => execStmtRef.current?.text ?? ''),
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
