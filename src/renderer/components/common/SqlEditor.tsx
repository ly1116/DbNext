import { useMemo, useRef } from 'react';

/**
 * SQL 语法高亮编辑器（轻量自实现，无第三方依赖）。
 *
 * 采用「透明 textarea + 高亮 backdrop」叠层技术：
 * - 上层 `<textarea>` 透明文字、承载输入与光标；
 * - 下层 `<pre>` 渲染同字体/同位置的高亮文本；
 * 两者滚动同步，得到可编辑且带配色的 SQL 编辑器（VS Code Dark+ 配色）。
 *
 * 词法规则覆盖：注释、字符串、数字、关键字、函数名、运算符、标点符号。
 *
 * @since 0.1.0
 */

/** SQL 关键字（大小写不敏感匹配，渲染为大写蓝色） */
const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'join', 'left', 'right',
  'inner', 'outer', 'on', 'as', 'and', 'or', 'not', 'in', 'is', 'null', 'like',
  'distinct', 'count', 'sum', 'avg', 'min', 'max', 'case', 'when', 'then', 'else',
  'end', 'union', 'all', 'desc', 'asc', 'create', 'table', 'alter', 'drop', 'index',
  'view', 'with', 'between', 'exists', 'primary', 'key', 'foreign', 'references',
]);

/** 聚合/常见函数名（渲染为黄色） */
const FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'concat', 'cast', 'now', 'date',
  'substring', 'lower', 'upper', 'length', 'round',
]);

/** 单 token 着色 */
function tokenize(line: string): React.ReactNode[] {
  // 注释：-- 至行尾
  const commentIdx = line.indexOf('--');
  let code = line;
  let comment = '';
  if (commentIdx >= 0) {
    code = line.slice(0, commentIdx);
    comment = line.slice(commentIdx);
  }

  const out: React.ReactNode[] = [];
  // 词法正则：字符串 | 数字 | 标识符/关键字 | 运算符/标点
  const re = /('[^']*'|"[^"]*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([^\sA-Za-z0-9_]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [txt, str, num, ident, punct] = m;
    if (str) out.push(<span key={key++} className="text-str">{txt}</span>);
    else if (num) out.push(<span key={key++} className="text-num">{txt}</span>);
    else if (ident) {
      const lower = ident.toLowerCase();
      if (KEYWORDS.has(lower)) out.push(<span key={key++} className="font-medium text-blue">{ident.toUpperCase()}</span>);
      else if (FUNCTIONS.has(lower)) out.push(<span key={key++} className="text-fn">{ident}</span>);
      else out.push(<span key={key++}>{ident}</span>);
    } else if (punct) out.push(<span key={key++} className="text-purple">{txt}</span>);
    last = re.lastIndex;
  }
  if (last < code.length) out.push(code.slice(last));
  if (comment) out.push(<span key={key++} className="text-dim2">{comment}</span>);
  return out;
}

export interface SqlEditorProps {
  value: string;
  onChange: (v: string) => void;
}

/**
 * SQL 编辑器组件。
 * @param value 当前 SQL 文本
 * @param onChange 文本变化回调
 */
export function SqlEditor({ value, onChange }: SqlEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // 逐行高亮（保持与 textarea 行号一致）
  const highlighted = useMemo(
    () => value.split('\n').map((line, i) => <div key={i}>{tokenize(line)}</div>),
    [value],
  );

  // 滚动同步：textarea 滚动时同步 backdrop
  const syncScroll = () => {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  return (
    <div className="relative flex-1 bg-bg">
      {/* 行号 */}
      <div className="pointer-events-none absolute left-0 top-0 select-none py-3 pr-3 text-right text-[12px] leading-[22px] text-dim2 mono" style={{ width: 48 }}>
        {value.split('\n').map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>

      {/* 高亮 backdrop */}
      <pre
        ref={preRef}
        aria-hidden
        className="pointer-events-none absolute left-12 right-0 top-0 m-0 overflow-hidden whitespace-pre-wrap break-words py-3 text-[12.5px] leading-[22px] text-fg mono"
      >
        {highlighted}
        {'\n'}
      </pre>

      {/* 输入层（透明文字） */}
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        className="absolute left-12 right-0 top-0 h-full resize-none overflow-auto bg-transparent py-3 text-[12.5px] leading-[22px] text-transparent caret-fg outline-none mono"
      />
    </div>
  );
}
