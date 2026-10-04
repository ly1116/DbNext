import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { editorTheme } from '@renderer/theme/editor-themes';
import { usePrefs } from '@renderer/store/prefsStore';
import { api } from '@renderer/api';
import { detectLanguage, languageLabel } from '@renderer/theme/file-types';

/**
 * 远端文件编辑器（CodeMirror 6 封装）。
 *
 * 语法高亮对齐 VSCode 的「自动识别文件格式」：
 * 用 @codemirror/language-data 的 LanguageDescription 描述表，
 * 按文件名（含无扩展名的 Dockerfile/Makefile 等）匹配并按需异步加载语言包。
 * 表里没有的语言（如 Shell/Ruby/Dockerfile 走 legacy-modes）回退为纯文本，不影响编辑。
 *
 * 其它：主题跟随「设置 → 外观 → 配色方案」（Compartment 热切换）；Ctrl/⌘+S 写回远端。
 *
 * @since 0.3.0
 */

/** 从 language-data 描述表里按文件名找最匹配的语言（与 VSCode 的 detectLanguage 思路一致） */
function findLanguageDesc(fileName: string) {
  const lower = fileName.toLowerCase();
  // 1) filename 正则命中（Dockerfile / Makefile / CMakeLists.txt / nginx.conf 这类）
  const byFile = languages.find((l) => l.filename?.test(fileName));
  if (byFile) return byFile;
  // 2) 精确名称/别名命中
  const byName = languages.filter((l) => l.alias.includes(lower) || l.name.toLowerCase() === lower);
  if (byName.length) return byName[0];
  // 3) 按扩展名命中。
  //    注意：LanguageDescription.extensions **不带点**（如 'xml' / 'js'），比较时两边都要归一化，
  //    否则永远匹配不上 → 语言不加载 → 整篇纯文本（这是之前 XML/JS/PY 都没高亮的原因）。
  const ext = lower.includes('.') ? lower.split('.').pop() ?? '' : '';
  if (ext) {
    const byExt = languages.filter((l) => l.extensions.some((e) => e.toLowerCase().replace(/^\./, '') === ext));
    if (byExt.length) {
      // 同一扩展名被多语言声明时（如 .h → C / C++ / Objective-C），取声明该扩展名最多的语言
      return byExt.sort((a, b) => b.extensions.length - a.extensions.length)[0];
    }
  }
  // 4) 复合扩展名（.tar.gz / .tar.bz2 …）取最后一段再试
  const segs = lower.split('.');
  if (segs.length >= 3) {
    const last = segs[segs.length - 1];
    const byExt = languages.filter((l) => l.extensions.some((e) => e.toLowerCase().replace(/^\./, '') === last));
    if (byExt.length) return byExt.sort((a, b) => b.extensions.length - a.extensions.length)[0];
  }
  return null;
}

export function RemoteFileEditor({
  connectionId,
  path,
  onSaved,
}: {
  connectionId: string;
  path: string;
  /** 保存成功后回调（通知父组件刷新 SFTP 列表） */
  onSaved?: (path: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const onSaveRef = useRef<(() => void) | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [size, setSize] = useState(0);
  /** 原始内容（判断是否改动） */
  const originalRef = useRef('');
  const fileName = path.split('/').filter(Boolean).pop() ?? path;
  // 展示用的语言名：优先用我们自己的映射（覆盖更多，如 nginx.conf → Nginx 配置）
  const [langLabel, setLangLabel] = useState(() => languageLabel(detectLanguage(path)));

  // 加载远端内容
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .readTextFile(connectionId, path)
      .then((r) => {
        if (!alive) return;
        originalRef.current = r.content;
        setSize(r.size);
        setDirty(false);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connectionId, path]);

  // 保存（Ctrl/⌘+S 或工具条按钮）
  const doSave = async () => {
    const view = viewRef.current;
    if (!view || saving) return;
    const content = view.state.doc.toString();
    if (content === originalRef.current) {
      setDirty(false);
      return;
    }
    setSaving(true);
    try {
      await api.writeTextFile(connectionId, path, content);
      originalRef.current = content;
      setDirty(false);
      onSavedRef.current?.(path);
    } catch (e) {
      setError(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  onSaveRef.current = () => void doSave();

  // 创建编辑器实例（内容加载完成后）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current || loading || error) return;
    const { theme } = usePrefs.getState().prefs;
    const view = new EditorView({
      state: EditorState.create({
        doc: originalRef.current,
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
          // 语言（异步识别后注入）
          langComp.current.of([]),
          // 主题（跟随配色方案）
          themeComp.current.of(editorTheme(theme)),
          indentUnit.of('  '),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
          // Ctrl/⌘+S 保存（最高优先级，避免被其它快捷键拦截）
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  onSaveRef.current?.();
                  return true;
                },
              },
            ]),
          ),
          EditorView.theme({
            '&': { height: '100%', fontSize: 'calc(var(--pref-fs, 15px) * 1.1)' },
            '.cm-scroller': { fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace', overflow: 'auto' },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(u.state.doc.toString() !== originalRef.current);
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [loading, error]);

  // 语法高亮：按文件名自动识别语言并按需加载
  useEffect(() => {
    let alive = true;
    const desc = findLanguageDesc(fileName);
    if (!desc) {
      // language-data 没收录（如 .bashrc 这类无扩展名脚本）：退回 file-types 的映射，仅影响标签显示
      setLangLabel(languageLabel(detectLanguage(path)));
      return;
    }
    setLangLabel(desc.name);
    // load() 直接返回 LanguageSupport；加载失败降级为纯文本，不影响编辑
    desc
      .load()
      .then((support) => {
        if (!alive || !viewRef.current) return;
        viewRef.current.dispatch({ effects: langComp.current.reconfigure([support]) });
      })
      .catch(() => {
        /* 语言包缺失：保持纯文本 */
      });
    return () => {
      alive = false;
    };
  }, [fileName, path]);

  // 主题热切换
  const themeName = usePrefs((s) => s.prefs.theme);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: themeComp.current.reconfigure(editorTheme(themeName)) });
  }, [themeName]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-[12px] text-dim">
        <div className="max-w-md text-center">
          <div className="mb-2 text-prod">无法打开文件</div>
          <div className="text-dim2">{error}</div>
          <div className="mt-3 break-all text-[11px] text-dim2">{path}</div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center text-[12px] text-dim">正在加载远端文件…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* 工具条：文件名 + 语言 + 大小 + 保存状态 */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="truncate font-medium" title={path}>
          {fileName}
        </span>
        <span className="shrink-0 rounded bg-panel3 px-1.5 py-0.5 text-[10px] text-dim2">{langLabel}</span>
        <span className="shrink-0 text-[10px] text-dim2">{size > 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`}</span>
        <span className="ml-auto flex items-center gap-2">
          {saving && <span className="text-[11px] text-dim">保存中…</span>}
          {!saving && dirty && <span className="text-[11px] text-warn">● 未保存</span>}
          {!saving && !dirty && <span className="text-[11px] text-dim2">已同步</span>}
          <button
            onClick={() => void doSave()}
            disabled={!dirty || saving}
            className="rounded bg-accent px-2 py-0.5 text-[11px] text-white hover:bg-accent2 disabled:opacity-40"
            title="保存回远端（Ctrl/⌘+S）"
          >
            保存
          </button>
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
