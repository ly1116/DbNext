import { Fragment, useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars, Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, indentUnit, syntaxHighlighting, HighlightStyle, LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { editorTheme } from '@renderer/theme/editor-themes';
import { usePrefs } from '@renderer/store/prefsStore';
import { api } from '@renderer/api';
import { ErrorBox } from '@renderer/components/common/States';
import type { DbObjectDef, QueryResult, RoutineDebugState, RoutineParam } from '@shared/types';

/**
 * 存储过程 / 函数设计器（对标 DBeaver「过程」页 + PL/SQL Developer 调试）。
 *
 * 三块能力：
 * 1. 定义编辑：CodeMirror + **PL/SQL 自定义语法高亮**（关键字/字符串/注释/绑定变量/数字），
 *    主题跟随配色方案，Ctrl/⌘+S 保存（执行 DDL 重建对象）。
 * 2. 参数化执行：读 ALL_ARGUMENTS 得到形参，按 IN/OUT/INOUT 生成输入表单，
 *    执行后展示 OUT/INOUT 回填值与过程内 DBMS_OUTPUT 的输出。
 * 3. 调试（Oracle DBMS_DEBUG）：单步 / 继续，实时显示**当前行号**与**作用域内变量值**。
 */

/* ---------------- PL/SQL 语法高亮 ---------------- */

/** PL/SQL 关键字（Oracle 保留字 + 流程控制 + 异常处理 + 包） */
const PLSQL_KEYWORDS = new Set([
  'BEGIN', 'END', 'IF', 'THEN', 'ELSE', 'ELSIF', 'END IF', 'LOOP', 'END LOOP', 'WHILE', 'FOR', 'FORALL',
  'RETURN', 'EXIT', 'CONTINUE', 'GOTO', 'CASE', 'WHEN', 'DECLARE', 'EXCEPTION', 'RAISE', 'SQLCODE', 'SQLERRM',
  'IS', 'NULL', 'TRUE', 'FALSE', 'NOT', 'AND', 'OR', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'ALL', 'ANY', 'SOME',
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO', 'VALUES', 'SET', 'TABLE',
  'CREATE', 'ALTER', 'DROP', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'BODY', 'TRIGGER', 'TYPE', 'VIEW',
  'REPLACE', 'OR', 'AND', 'NOT', 'OUT', 'INOUT', 'EXECUTE', 'IMMEDIATE', 'RETURNING', 'BULK', 'COLLECT',
  'PIPE', 'ROW', 'PUSH', 'NOAUTH', 'EDITIONABLE', 'NONEDITIONABLE', 'AUTHID', 'DETERMINISTIC', 'PIPELINED',
  'RESULT_CACHE', 'PARALLEL_ENABLE', 'EXCEPTION_INIT', 'AGGREGATE', 'UNNEST', 'CAST', 'TREAT', 'REF',
  'INDEX', 'SEQUENCE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'OPEN', 'CLOSE', 'FETCH', 'CURSOR', 'FOR_RECORD',
  'PRAGMA', 'BULK', 'COLLECT', 'FORALL', 'SAVE', 'EXCEPTIONS', 'RESTRICT_REFERENCES',
  'AUTHID', 'CURRENT_USER', 'SESSION_USER', 'SYS_CONTEXT', 'DUAL', 'CONNECT', 'STARTUP', 'MINUS', 'UNION',
  'GROUP', 'ORDER', 'HAVING', 'DISTINCT', 'ROWNUM', 'LEVEL',
]);

const PLSQL_TYPES = new Set([
  'NUMBER', 'VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'VARCHAR', 'CLOB', 'NCLOB', 'LONG', 'RAW',
  'BLOB', 'BFILE', 'DATE', 'TIMESTAMP', 'INTERVAL', 'PLS_INTEGER', 'NATURAL', 'NATURALN', 'POSITIVE',
  'POSITIVEN', 'SIGNTYPE', 'SIMPLE_INTEGER', 'BINARY_FLOAT', 'BINARY_DOUBLE', 'BOOLEAN', 'ROWID', 'UROWID',
  'XMLTYPE', 'ANY', 'SYS_REFCURSOR', 'REF', 'TABLE', 'VARRAY', 'RECORD', 'OBJECT',
]);

/** PL/SQL 语法高亮样式（token 分类 → 颜色由主题决定，这里用 editorTheme 的语义位） */
const plsqlHighlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--pl-kw)' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: 'var(--pl-kw2)', fontWeight: '600' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--pl-type)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--pl-str)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--pl-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--pl-cmt)', fontStyle: 'italic' },
  { tag: [t.variableName], color: 'var(--pl-var)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--pl-fn)' },
  { tag: [t.operator], color: 'var(--pl-op)' },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'var(--pl-op)' },
  { tag: [t.definitionKeyword], color: 'var(--pl-kw2)', fontWeight: '600' },
  { tag: [t.processingInstruction], color: 'var(--pl-cmt)' },
]);

/** 基于 TokenTable 的完整 PL/SQL 语言（把关键字/类型/绑定变量分类着色） */
const plsqlStreamParser: StreamParser<unknown> = {
  name: 'plsql',
  token(stream, _state) {
    if (stream.eatSpace()) return null;
    const ch = stream.peek();
    // 单引号字符串（含 '' 转义）
    if (ch === "'") {
      stream.next();
      while (!stream.eol()) {
        const c = stream.next();
        if (c === "'") {
          if (stream.peek() === "'") stream.next();
          else break;
        }
      }
      return 'string';
    }
    // 双引号标识符
    if (ch === '"') {
      stream.next();
      while (!stream.eol() && stream.next() !== '"');
      return 'variableName';
    }
    // 注释：-- 行注释（注意不能只匹配单个 '-'，否则负数如 -20001 会被整行吞掉）
    if (ch === '-' && stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === '/' && stream.match('/*')) {
      let prev = '';
      while (!stream.eol()) {
        const c = String(stream.next() ?? '');
        if (prev === '*' && c === '/') break;
        prev = c;
      }
      return 'comment';
    }
    // 绑定变量 :name（PL/SQL 特有，重要——调试时最常看的就是它们）
    if (ch === ':') {
      stream.next();
      if (/[A-Za-z_]/.test(stream.peek() ?? '')) {
        stream.match(/^[A-Za-z_][A-Za-z0-9_$#]*/);
        return 'variableName';
      }
      stream.match(/^[^A-Za-z0-9_]*/);
      return 'operator';
    }
    // 数字
    if (/[0-9]/.test(ch ?? '')) {
      stream.match(/^\d+(\.\d+)?([eE][+-]?\d+)?|^\d+\.\d*/);
      return 'number';
    }
    // q'[ ... ]' 跨行字符串（必须放在标识符分支之前，否则 q 会被当变量吞掉）
    if (/[qQ]/.test(ch ?? '') && stream.match(/^[qQ]'/)) {
      let prev = '';
      while (!stream.eol()) {
        const c = stream.next() ?? '';
        if (prev === "'" && c === ']') break;
        prev = c;
      }
      return 'string';
    }
    // 标识符 / 关键字（自行截取词文本，避免依赖 stream.current() 的实现细节）
    if (/[A-Za-z_#&]/.test(ch ?? '')) {
      let word = '';
      while (!stream.eol()) {
        const c = stream.peek() ?? '';
        if (!/[A-Za-z0-9_$#&]/.test(c)) break;
        word += c;
        stream.next();
      }
      const upper = word.toUpperCase();
      if (PLSQL_KEYWORDS.has(upper)) return 'keyword';
      if (PLSQL_TYPES.has(upper)) return 'typeName';
      return 'variableName';
    }
    // 运算符 / 标点
    if (/^[+\-*/<>=!|:&%^~(),;.{}[\]@$#]/.test(ch ?? '')) {
      stream.next();
      return /[(),;.{}[\]]/.test(ch ?? '') ? 'punctuation' : 'operator';
    }
    // 兜底：必须推进 stream，否则 CodeMirror 抛 "Stream parser failed to advance stream"
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '--', block: { open: '/*', close: '*/' } } },
};

const plsqlSupport = new LanguageSupport(StreamLanguage.define(plsqlStreamParser));

/** 把 PL/SQL 颜色变量挂到编辑器容器上（跟随主题） */
function usePlsqlVars(prefTheme: string) {
  useEffect(() => {
    // 与 editorTheme 保持同一套语义色：紫=关键字、青=类型、绿=字符串、橙=数字、灰=注释
    // 注意：主题色是 RGB 三元组变量（--c-*），必须包 rgb() 才是合法颜色值
    const root = document.documentElement;
    root.style.setProperty('--pl-kw', 'rgb(var(--c-accent))');
    root.style.setProperty('--pl-kw2', 'rgb(var(--c-ai))');
    root.style.setProperty('--pl-type', 'rgb(var(--c-ok))');
    root.style.setProperty('--pl-str', 'rgb(var(--c-prod))');
    root.style.setProperty('--pl-num', 'rgb(var(--c-warn))');
    root.style.setProperty('--pl-cmt', 'rgb(var(--c-dim2))');
    root.style.setProperty('--pl-var', 'rgb(var(--c-fg))');
    root.style.setProperty('--pl-fn', 'rgb(var(--c-accent2))');
    root.style.setProperty('--pl-op', 'rgb(var(--c-dim))');
  }, [prefTheme]);
}

/* ---------------- 断点/当前行高亮插件 ---------------- */

/**
 * 调试可视化：把当前执行行整行高亮（左侧强调条 + 淡黄底）。
 * line 为 1 起（DBMS_DEBUG 的行号语义）。
 */
function debugLineHighlighter(lineGetter: { current: number }) {
  const build = (line: number): DecorationSet => {
    if (!line || line < 1) return Decoration.none;
    return Decoration.set([Decoration.line({ class: 'cm-debug-line' }).range(line - 1)]);
  };
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet;
      constructor() {
        this.deco = build(lineGetter.current);
      }
      update(u: { viewportChanged: boolean; docChanged: boolean }) {
        if (u.viewportChanged || u.docChanged) this.deco = build(lineGetter.current);
      }
    },
    { decorations: (v) => v.deco },
  );
}

/* ---------------- 主组件 ---------------- */

export function RoutineStudio({
  connId,
  pgDb,
  schema,
  name,
  kind,
  embedded = false,
}: {
  connId: string;
  pgDb?: string;
  schema: string;
  name: string;
  kind: 'function' | 'procedure' | 'view' | 'mview';
  /** 内嵌在函数浏览器右栏时去掉外层 p-3（由宿主控制留白） */
  embedded?: boolean;
}) {
  const isRoutine = kind === 'function' || kind === 'procedure';
  const isView = kind === 'view' || kind === 'mview';

  const [def, setDef] = useState<DbObjectDef | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 执行
  const [params, setParams] = useState<RoutineParam[]>([]);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [execOut, setExecOut] = useState<{ outputs: Record<string, string | null>; elapsedMs: number; message?: string } | null>(null);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // 调试
  const [debugId, setDebugId] = useState<string | null>(null);
  const [dbg, setDbg] = useState<RoutineDebugState | null>(null);
  const [dbgBusy, setDbgBusy] = useState(false);
  const [dbgErr, setDbgErr] = useState<string | null>(null);

  // 视图预览
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const debugLineRef = useRef(0);
  const saveRef = useRef<(() => void) | null>(null);
  const execRef = useRef<(() => void) | null>(null);
  const dbgStartRef = useRef<(() => void) | null>(null);
  const dbgStepRef = useRef<((a: 'step' | 'continue') => void) | null>(null);
  const dbgStopRef = useRef<(() => void) | null>(null);
  const insertTextRef = useRef<((v: string) => void) | null>(null);

  const themeName = usePrefs((s) => s.prefs.theme);
  usePlsqlVars(themeName);

  /* —— 加载定义 —— */
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = isView ? await api.getViewDefinition(connId, kind, schema, name, pgDb) : await api.getFunctionDefinition(connId, schema, name, pgDb);
      setDef(d);
      setText(d.ddl);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, kind, schema, name, pgDb]);

  /* —— 加载参数元数据 —— */
  useEffect(() => {
    if (!isRoutine) return;
    let alive = true;
    api
      .getRoutineParams(connId, schema, name, pgDb)
      .then((ps) => {
        if (!alive) return;
        setParams(ps.filter((p) => p.mode !== 'RETURN'));
        const init: Record<string, string> = {};
        for (const p of ps) if (p.mode === 'IN' || p.mode === 'INOUT') init[p.name] = '';
        setArgs(init);
      })
      .catch(() => {
        /* 非 Oracle 或无权限：参数表单留空 */
      });
    return () => {
      alive = false;
    };
  }, [connId, schema, name, pgDb, isRoutine, def?.ddl]);

  /* —— CodeMirror 实例 —— */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current || loading || error) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          // PL/SQL 语法高亮
          langComp.current.of(plsqlSupport),
          syntaxHighlighting(plsqlHighlight),
          themeComp.current.of(editorTheme(themeName)),
          indentUnit.of('  '),
          // 调试当前行高亮
          debugLineHighlighter(debugLineRef),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          // 调试快捷键：F8 = 继续，F10 = 单步，Shift+F5 = 结束调试
          Prec.highest(
            keymap.of([
              { key: 'Mod-s', run: () => (saveRef.current?.(), true) },
              { key: 'F8', run: () => (dbgStartRef.current?.(), true) },
              { key: 'F10', run: () => (dbgStepRef.current?.('step'), true) },
              { key: 'Shift-F8', run: () => (dbgStepRef.current?.('continue'), true) },
              { key: 'Shift-F5', run: () => (dbgStopRef.current?.(), true) },
            ]),
          ),
          EditorView.theme({
            '&': { height: '100%', fontSize: 'calc(var(--pref-fs, 15px) * 1.1)' },
            '.cm-scroller': { fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace', overflow: 'auto' },
            // 调试当前执行行：淡黄底 + 左侧强调条
            '.cm-debug-line': { backgroundColor: 'rgba(234, 179, 8, 0.16)', boxShadow: 'inset 3px 0 0 var(--warn)' },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setText(u.state.doc.toString());
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    insertTextRef.current = (v: string) => {
      const v2 = viewRef.current;
      if (!v2) return;
      const { from, to } = v2.state.selection.main;
      v2.dispatch({ changes: { from, to, insert: v }, selection: { anchor: from + v.length } });
      v2.focus();
    };
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [loading, error]);

  // 主题热切换
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: themeComp.current.reconfigure(editorTheme(themeName)) });
  }, [themeName]);

  /* —— 操作 —— */
  const save = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.runSql(connId, text, pgDb || undefined);
      setMsg({ kind: 'ok', text: '已保存（DDL 执行成功，对象已重建）' });
    } catch (e) {
      setMsg({ kind: 'err', text: `保存失败：${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  const exec = async () => {
    if (running) return;
    setRunning(true);
    setExecErr(null);
    setExecOut(null);
    try {
      const r = await api.execRoutine({ connectionId: connId, schema, name, args });
      setExecOut({ outputs: r.outputs, elapsedMs: r.elapsedMs, message: r.message });
    } catch (e) {
      setExecErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };
  execRef.current = () => void exec();

  const dbgStart = async () => {
    if (dbgBusy || debugId) return;
    setDbgBusy(true);
    setDbgErr(null);
    try {
      const r = await api.debugStart(connId, schema, name, args);
      setDebugId(r.debugId);
      setDbg(r.state);
      applyDebugLine(r.state.line);
    } catch (e) {
      setDbgErr((e as Error).message);
    } finally {
      setDbgBusy(false);
    }
  };
  dbgStartRef.current = () => void dbgStart();

  const dbgStep = async (action: 'step' | 'continue') => {
    if (!debugId || dbgBusy) return;
    setDbgBusy(true);
    setDbgErr(null);
    try {
      const r = await api.debugStep(debugId, action);
      setDbg(r);
      applyDebugLine(r.line);
      if (r.finished) {
        setDebugId(null);
        debugLineRef.current = 0;
      }
    } catch (e) {
      setDbgErr((e as Error).message);
    } finally {
      setDbgBusy(false);
    }
  };
  dbgStepRef.current = (a) => void dbgStep(a);

  const dbgStop = async () => {
    if (!debugId) return;
    try {
      await api.debugStop(debugId);
    } catch {
      /* ignore */
    }
    setDebugId(null);
    setDbg(null);
    debugLineRef.current = 0;
    forceRedraw();
  };
  dbgStopRef.current = () => void dbgStop();

  /** 设置当前执行行并滚动到可见 */
  const applyDebugLine = (line: number) => {
    debugLineRef.current = line;
    const view = viewRef.current;
    if (!view || !line) return;
    const pos = Math.min(view.state.doc.length, Math.max(0, line - 1));
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  };
  /** 调试状态变化后强制重绘装饰 */
  const forceRedraw = () => {
    const view = viewRef.current;
    if (view) view.dispatch({});
  };

  // 调试会话销毁时释放连接
  useEffect(
    () => () => {
      if (debugIdRef.current) void api.debugStop(debugIdRef.current).catch(() => undefined);
    },
    [],
  );
  const debugIdRef = useRef<string | null>(null);
  debugIdRef.current = debugId;

  const previewData = async () => {
    setPreviewErr(null);
    try {
      setPreview(await api.runSql(connId, `SELECT * FROM "${schema}"."${name}" LIMIT 200`, pgDb || undefined));
    } catch (e) {
      setPreviewErr((e as Error).message);
    }
  };

  const kindLabel = kind === 'function' ? '函数' : kind === 'procedure' ? '存储过程' : kind === 'mview' ? '物化视图' : '视图';
  /** 未保存标记：编辑文本与库内定义不一致 */
  const dirty = !!def && text !== def.ddl;
  /** 代码卡头部签名提示：DDL 首个非空行 */
  const sig = text.split('\n').find((l) => l.trim()) ?? '';
  /** 从 DDL 文本解析展示用元数据（语言/返回类型/易变性/并行），解析不到就不显示 */
  const lang = def?.ddl.match(/\bLANGUAGE\s+['"]?([A-Za-z_][\w$]*)/i)?.[1];
  const retType = def
    ?.ddl.split('\n')
    .find((l) => /\bRETURNS\b/i.test(l))
    ?.replace(/^.*?\bRETURNS\s+(?:SETOF\s+)?/i, '')
    .trim()
    .replace(/\s+(LANGUAGE|PARALLEL|COST|STABLE|IMMUTABLE|VOLATILE|STRICT|SECURITY|NOT|AS)\b.*$/i, '');
  const volat = def?.ddl.match(/\b(VOLATILE|STABLE|IMMUTABLE)\b/i)?.[1];
  const paral = def?.ddl.match(/\bPARALLEL\s+(SAFE|RESTRICTED|UNSAFE)\b/i)?.[1];
  const isSetof = def ? /\bRETURNS\s+SETOF\b/i.test(def.ddl) : false;
  const strict = def?.ddl.match(/\bSTRICT\b|\bRETURNS NULL ON NULL INPUT\b/i)?.[1];
  const security = def?.ddl.match(/\bSECURITY\s+(INVOKER|DEFINER)\b/i)?.[1];

  /** 工具条内容：对象身份 + 属性 + 操作。独立页横贯顶部；内嵌浏览器时收进代码卡头部（三栏顶底对齐等高） */
  const toolbarBody = (
    <>
        <h1 className="text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-fg">
          <span className="font-medium text-dim">{schema}.</span>
          {name}
        </h1>
        <span className="rounded-md border border-line2 px-1.5 py-px text-[length:calc(var(--pref-fs)*0.714)] text-dim">{kindLabel}</span>
        <span className="min-w-4 flex-1" />
        {msg && <span className={`shrink-0 text-[length:calc(var(--pref-fs)*0.786)] ${msg.kind === 'err' ? 'text-prod' : 'text-ok'}`}>{msg.text}</span>}
        {dirty && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.786)] text-warn">● 未保存</span>}
        <button onClick={() => void load()} className="btn shrink-0" title="还原为数据库中的当前定义（放弃本地修改）">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          还原
        </button>
        <button onClick={() => void api.clipboardWrite(text).catch(() => undefined)} className="btn shrink-0" title="复制定义文本">
          复制
        </button>
        {isView && (
          <button onClick={() => void previewData()} className="btn shrink-0">
            预览数据
          </button>
        )}
        {isRoutine && !debugId && (
          <>
            <button onClick={() => void exec()} disabled={running} className="btn shrink-0" title="按右侧参数执行一次">
              ▶ 执行
            </button>
            <button onClick={() => void dbgStart()} disabled={dbgBusy} className="btn shrink-0" title="启动 DBMS_DEBUG 调试（F8）">
              调试
            </button>
          </>
        )}
        {isRoutine && debugId && (
          <>
            <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] text-warn">● 调试中 第 {dbg?.line ?? 0} 行</span>
            <button onClick={() => void dbgStep('step')} disabled={dbgBusy} className="btn shrink-0" title="单步执行一行（F10）">
              单步
            </button>
            <button onClick={() => void dbgStep('continue')} disabled={dbgBusy} className="btn shrink-0" title="运行到下一个断点（Shift+F8）">
              继续
            </button>
            <button onClick={() => void dbgStop()} className="btn shrink-0" title="结束调试并释放连接（Shift+F5）">
              结束
            </button>
          </>
        )}
        <button onClick={() => void save()} disabled={saving} className="btn-primary shrink-0" title="执行 DDL 重建对象（Ctrl/⌘+S）">
          {saving ? '保存中…' : '执行（保存定义）'}
        </button>
    </>
  );

  /** 编辑器宿主：加载/错误态占位，就绪后挂 CodeMirror */
  const editorHost = error ? (
    <div className="p-3">
      <ErrorBox message={error} onRetry={() => void load()} />
    </div>
  ) : loading ? (
    <div className="p-3 text-[length:calc(var(--pref-fs)*0.857)] text-dim2">加载定义…</div>
  ) : (
    <div ref={hostRef} className="min-h-0 flex-1" />
  );

  /** 右信息卡：过程 = 参数 + 执行结果 + 调试变量；视图 = 数据预览 */
  const infoCard = (isRoutine || preview || previewErr) && (
    <div className="flex min-w-[330px] max-w-[430px] flex-1 flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-sm">
      <div className="min-h-0 flex-1 overflow-y-auto">
            {/* 参数：表格版（名称 / 类型 / 方向 / 默认），IN 参数行下附执行输入框 */}
            {isRoutine && (
              <div className="border-b border-line px-3.5 py-2.5">
                <div className="mb-1.5 flex items-baseline gap-2">
                  <span className="text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">参数</span>
                  <span className="text-[10px] tabular-nums text-dim2">{params.length} 个</span>
                  <span className="ml-auto text-[10px] text-dim2">留空 = NULL</span>
                </div>
                {params.length === 0 ? (
                  <div className="text-[11px] text-dim2">无参数（或该连接不支持参数元数据）</div>
                ) : (
                  <table className="w-full table-fixed">
                    <thead>
                      <tr className="border-b border-line text-left text-[length:calc(var(--pref-fs)*0.714)] text-dim2">
                        <th className="w-[32%] py-1 pr-2 font-normal">名称</th>
                        <th className="w-[38%] py-1 pr-2 font-normal">类型</th>
                        <th className="py-1 font-normal">方向 / 默认</th>
                      </tr>
                    </thead>
                    <tbody>
                      {params.map((p) => (
                        <Fragment key={p.name}>
                          <tr className="border-b border-line/50 align-middle">
                            <td className="max-w-0 truncate py-1 pr-2 font-mono text-[12px] font-medium text-fg" title={p.name}>
                              {p.name}
                            </td>
                            <td className="max-w-0 truncate py-1 pr-2 font-mono text-[11px] text-dim" title={p.dataType}>
                              {p.dataType}
                            </td>
                            <td className="py-1">
                              <span className="rounded border border-line2 px-1 text-[9.5px] font-semibold leading-[14px] text-dim" title={p.mode}>
                                {p.mode}
                              </span>
                              {p.hasDefault && <span className="ml-1 text-[9.5px] text-dim2">DEFAULT</span>}
                            </td>
                          </tr>
                          {p.mode === 'OUT' ? (
                            <tr className="border-b border-line/50">
                              <td colSpan={3} className="py-1 text-[10px] text-dim2">
                                输出参数，执行后回填
                              </td>
                            </tr>
                          ) : (
                            <tr className="border-b border-line/50">
                              <td colSpan={3} className="py-1">
                                <input
                                  value={args[p.name] ?? ''}
                                  onChange={(e) => setArgs((a) => ({ ...a, [p.name]: e.target.value }))}
                                  onFocus={() => insertTextRef.current?.(p.name)}
                                  placeholder={p.required ? '必填' : '留空 = NULL'}
                                  className="w-full rounded border border-line2 bg-bg px-1.5 py-0.5 font-mono text-[11px] text-fg outline-none focus:border-accent"
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* 返回 */}
            {isRoutine && retType && (
              <div className="border-b border-line px-3.5 py-2.5">
                <div className="mb-1.5 text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">返回</div>
                <div className="space-y-1">
                  <div className="flex gap-2 text-[11px]">
                    <span className="w-14 shrink-0 text-dim2">类型</span>
                    <span className="min-w-0 break-all font-mono text-fg">{retType}</span>
                  </div>
                  <div className="flex gap-2 text-[11px]">
                    <span className="w-14 shrink-0 text-dim2">结果集</span>
                    <span className="min-w-0 text-fg">{isSetof ? '是（返回集合）' : '否（标量函数）'}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 属性：语言 / 易变性 / 并行 / NULL 处理 / 安全声明（从 DDL 解析，解析不到就不显示） */}
            {isRoutine && (lang || volat || paral || strict || security) && (
              <div className="border-b border-line px-3.5 py-2.5">
                <div className="mb-1.5 text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">属性</div>
                <div className="space-y-1">
                  {[
                    ['语言', lang, false],
                    ['易变性', volat?.toUpperCase(), false],
                    ['并行', paral?.toUpperCase(), false],
                    ['NULL 处理', strict ? 'STRICT（入参为 NULL 直接返回 NULL）' : undefined, false],
                    ['安全声明', security?.toUpperCase(), false],
                  ]
                    .filter(([, v]) => !!v)
                    .map(([label, v]) => (
                      <div key={label as string} className="flex gap-2 text-[11px]">
                        <span className="w-14 shrink-0 text-dim2">{label}</span>
                        <span className="min-w-0 break-all font-mono text-fg">{v as string}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* 执行结果：OUT 回填 + DBMS_OUTPUT */}
            {isRoutine && (execErr || execOut) && (
              <div className="border-b border-line px-3.5 py-2.5">
                {execErr && <div className="rounded border border-prod/40 bg-prod/10 p-1.5 text-[11px] text-prod">执行失败：{execErr}</div>}
                {execOut && (
                  <div className="rounded border border-ok/30 bg-ok/5 p-1.5 text-[11px]">
                    <div className="mb-1 text-ok">✓ 执行成功（{execOut.elapsedMs} ms）</div>
                    {Object.keys(execOut.outputs).length > 0 && (
                      <table className="w-full">
                        <tbody>
                          {Object.entries(execOut.outputs).map(([k, v]) => (
                            <tr key={k} className="align-top">
                              <td className="pr-2 font-mono text-dim2">{k}</td>
                              <td className="max-w-[150px] break-all font-mono text-fg">{v === null ? <i className="text-dim2">NULL</i> : v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {execOut.message && (
                      <div className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bg/60 p-1.5 font-mono text-[10px] leading-relaxed text-dim">{execOut.message}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 调试变量面板 */}
            {isRoutine && (
              <div className="border-b border-line px-3.5 py-2.5">
                <div className="mb-1.5 flex items-baseline gap-2 text-[length:calc(var(--pref-fs)*0.786)]">
                  <span className="font-medium text-fg">调试 · 变量</span>
                  {debugId && <span className="rounded bg-warn/15 px-1 text-[10px] text-warn">第 {dbg?.line ?? 0} 行</span>}
                </div>
                {dbgErr && <div className="rounded border border-prod/40 bg-prod/10 p-1.5 text-[11px] text-prod">调试出错：{dbgErr}</div>}
                {!debugId && !dbgErr && (
                  <div className="text-[11px] leading-relaxed text-dim2">
                    点击「🐛 调试」启动 DBMS_DEBUG 会话，单步执行时可看到每个变量的当前值。
                    <div className="mt-1.5 rounded bg-warn/10 p-1.5 text-[10px] text-warn">
                      提示：过程需以调试权限编译 —— <code className="font-mono">alter {schema}.{name} debug</code>
                    </div>
                  </div>
                )}
                {debugId && dbg && (
                  <>
                    {dbg.finished ? (
                      <div className="rounded border border-ok/30 bg-ok/10 p-1.5 text-[11px] text-ok">调试已结束（过程执行完毕）</div>
                    ) : dbg.variables.length === 0 ? (
                      <div className="text-[11px] text-dim2">当前作用域无可见变量</div>
                    ) : (
                      <table className="w-full">
                        <tbody>
                          {dbg.variables.map((v) => (
                            <tr key={v.name} className="align-top">
                              <td className="w-[42%] break-all pr-1.5 font-mono text-[11px] text-accent2">{v.name}</td>
                              <td className="break-all font-mono text-[11px] text-fg">
                                {v.value === null ? <i className="text-dim2">NULL</i> : v.value === '' ? <i className="text-dim2">('')</i> : v.value}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="mt-2 flex gap-1.5 text-[10px] text-dim2">
                      <kbd className="rounded border border-line2 px-1">F8</kbd> 调试
                      <kbd className="rounded border border-line2 px-1">F10</kbd> 单步
                      <kbd className="rounded border border-line2 px-1">Shift+F8</kbd> 继续
                      <kbd className="rounded border border-line2 px-1">Shift+F5</kbd> 结束
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 视图数据预览 */}
            {(preview || previewErr) && (
              <div className="px-3.5 py-2.5">
                <div className="mb-1.5 text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">数据预览（最多 200 行）</div>
                {previewErr ? <div className="text-[11px] text-prod">{previewErr}</div> : preview ? <MiniGrid r={preview} /> : null}
              </div>
            )}
      </div>
    </div>
  );

  if (embedded) {
    /* 内嵌浏览器：工具条收进代码卡头部 → 左清单 / 代码卡 / 信息卡 三栏顶底对齐、等高 */
    return (
      <div className="flex min-h-0 min-w-0 flex-1 gap-2.5 overflow-hidden">
        <div className="flex min-w-0 flex-[1.9] flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-sm">
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-panel2 px-2.5 py-1.5">{toolbarBody}</div>
          {editorHost}
        </div>
        {infoCard}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-3">
      {/* ===== 工具条：对象身份 + 属性 + 操作 ===== */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">{toolbarBody}</div>

      {/* ===== 主体：左定义代码卡 / 右信息卡 ===== */}
      <div className="flex min-h-0 flex-1 gap-2.5">
        {/* 左：定义代码（签名提示条 + 编辑器，收进圆角卡片） */}
        <div className="flex min-w-0 flex-[1.9] flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-sm">
          {error || loading ? (
            editorHost
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-panel2 px-3 py-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-dim">
                <span className="truncate font-mono" title={sig}>
                  {sig}
                </span>
              </div>
              {editorHost}
            </>
          )}
        </div>
        {infoCard}
      </div>
    </div>
  );
}

/** 极简结果网格（侧栏窄，列自适应 + 横向滚动） */
function MiniGrid({ r }: { r: QueryResult }) {
  return (
    <div className="overflow-x-auto text-[11px]">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {r.columns.map((c) => (
              <th key={c.name} className="border-b border-line px-1.5 py-1 text-left font-medium text-dim" title={c.dataType}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {r.rows.slice(0, 200).map((row, i) => (
            <tr key={i} className="odd:bg-panel3/40">
              {r.columns.map((c) => (
                <td key={c.name} className="max-w-[140px] truncate border-b border-line2 px-1.5 py-0.5 font-mono text-fg" title={String(row[c.name] ?? '')}>
                  {row[c.name] === null ? <i className="text-dim2">NULL</i> : String(row[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {r.rowCount > 200 && <div className="mt-1 text-[10px] text-dim2">共 {r.rowCount} 行，仅显示前 200 行</div>}
    </div>
  );
}
