import { useState } from 'react';
import { Icon } from '@renderer/components/common/icons';

/**
 * JSON 语法着色的可折叠树视图（Redis 值查看等场景复用）。
 *
 * - 对象/数组可折叠，带数量徽标与引导线；
 * - 键/字符串/数字/布尔/null 按类型着色；
 * - 原始值 hover 高亮，双击复制该值。
 *
 * @since 0.1.0
 */

/** 原始值的类型着色（跟随应用主题令牌） */
function valueSpan(v: unknown): JSX.Element {
  if (v === null) return <span className="text-muted-foreground italic">null</span>;
  const t = typeof v;
  if (t === 'string') return <span className="text-success break-all">"{v as string}"</span>;
  if (t === 'number') return <span className="text-ai2">{String(v)}</span>;
  if (t === 'boolean') return <span className="text-warning">{String(v)}</span>;
  return <span className="text-foreground break-all">{String(v)}</span>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon name="chevronRight-2" className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} strokeWidth={2.4} />
  );
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const isObj = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 4);

  const keyPart = name !== undefined ? (
    <span className="text-primary">"{name}"</span>
  ) : null;

  if (!isObj) {
    return (
      <div
        className="flex gap-1.5 rounded px-1 leading-5 hover:bg-secondary/50"
        onDoubleClick={() => {
          const text = typeof value === 'string' ? value : JSON.stringify(value);
          void navigator.clipboard?.writeText(text).catch(() => { /* 忽略 */ });
        }}
        title="双击复制该值"
      >
        <span className="w-3 shrink-0" />
        {keyPart}
        {keyPart !== null && <span className="text-muted-foreground">:</span>}
        {valueSpan(value)}
      </div>
    );
  }

  const isArr = Array.isArray(value);
  const entries: [string, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const openBr = isArr ? '[' : '{';
  const closeBr = isArr ? ']' : '}';

  return (
    <div className="leading-5">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex w-full items-start gap-1.5 rounded px-1 text-left hover:bg-secondary/50"
      >
        <span className="mt-1 flex w-3 shrink-0 justify-center"><Chevron open={open} /></span>
        {keyPart}
        {keyPart !== null && <span className="text-muted-foreground">:</span>}
        <span className="text-muted-foreground">{openBr}</span>
        {!open && (
          <>
            <span className="rounded bg-secondary px-1 text-[10px] leading-4 text-muted-foreground">{entries.length} 项</span>
            <span className="text-muted-foreground">…{closeBr}</span>
          </>
        )}
      </button>
      {open && (
        <div className={`ml-[7px] border-l border-border/60 pl-2 ${depth > 6 ? '' : ''}`}>
          {entries.length === 0 ? (
            <div className="px-1 text-muted-foreground italic">（空）</div>
          ) : (
            entries.map(([k, v]) => <JsonNode key={k} name={isArr ? undefined : k} value={v} depth={depth + 1} />)
          )}
        </div>
      )}
      {open && (
        <div className="flex items-center gap-1.5 rounded px-1 hover:bg-secondary/50">
          <span className="w-3 shrink-0" />
          <span className="text-muted-foreground">{closeBr}</span>
          {depth === 0 && entries.length > 0 && (
            <span className="rounded bg-secondary px-1 text-[10px] leading-4 text-muted-foreground">{entries.length} 项</span>
          )}
        </div>
      )}
    </div>
  );
}

/** 解析失败时返回 null；成功渲染折叠树 */
export function JsonTree({ text }: { text: string }) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  return (
    <div className="font-mono text-[length:calc(var(--pref-fs)*0.857)]">
      <JsonNode value={data} depth={0} />
    </div>
  );
}

/** 判断文本是否为合法 JSON（供调用方决定是否展示树视图） */
export function isParseableJson(text: string): boolean {
  if (!text || !text.trim()) return false;
  const c = text.trim()[0];
  if (c !== '{' && c !== '[' && c !== '"') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
