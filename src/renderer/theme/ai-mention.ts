import { Decoration, type DecorationSet } from '@codemirror/view';
import { ViewPlugin } from '@codemirror/view';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

/**
 * 「@ai 提及」支持：SQL 编辑器里输入 @ 自动提示 ai，@ai 记号整体高亮为主题点缀色。
 *
 * - aiMentionComplete：光标前匹配 /@\w*$/ 时给出 ai 候选（回车补全为 "@ai "）；
 * - aiMentionHighlighter：ViewPlugin 对可见范围内的 @ai 记号加 Mark 装饰（颜色由 editorTheme 的 .cm-mention-ai 提供，跟随主题）。
 *
 * @since 0.4.1
 */

/** 输入 @ 时的提及补全源（放在 autocompletion override 首位） */
export function aiMentionComplete(ctx: CompletionContext): CompletionResult | null {
  const before = ctx.state.sliceDoc(0, ctx.pos);
  const m = before.match(/@([\w]*)$/);
  if (!m) return null;
  return {
    // from 留在「@」之后：待匹配文本为空/词部分，候选项 ai 才能正常弹出；
    // apply 只补 "ai "（不带 @），因为 @ 已存在，避免变成 @@ai
    from: ctx.pos - m[1].length,
    options: [
      {
        label: 'ai',
        detail: 'AI 助手：用自然语言查询当前库数据',
        type: 'keyword',
        boost: 100,
        apply: 'ai ',
      },
    ],
    validFor: /^[\w]*$/,
  };
}

/** @ai 记号的 Mark 装饰（样式类在 editorTheme 中按主题着色） */
const mentionMark = Decoration.mark({ class: 'cm-mention-ai' });

const MENTION_RE = /@ai\b/gi;

/** 高亮可见范围内的 @ai 记号 */
export const aiMentionHighlighter: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: import('@codemirror/view').EditorView) {
      this.decorations = this.build(view);
    }
    update(u: import('@codemirror/view').ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: import('@codemirror/view').EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.sliceDoc(from, to);
        MENTION_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = MENTION_RE.exec(text))) {
          b.add(from + m.index, from + m.index + m[0].length, mentionMark);
        }
      }
      return b.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
