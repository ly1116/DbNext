import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 轻量 Markdown 渲染（@ai 回答等场景）：GFM 表格 / 代码块 / 列表 / 标题。
 * 样式对齐应用主题变量（line/panel/fg/dim/ai），不依赖全局 CSS。
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body break-words text-[length:calc(var(--pref-fs)*0.786)] leading-relaxed text-fg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 行内代码
          code({ className, children, ...rest }) {
            const isBlock = /language-/.test(className ?? '');
            if (!isBlock) {
              return (
                <code className="rounded bg-panel px-1 py-px font-mono text-[0.92em] text-ai" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          // 代码块
          pre({ children }) {
            return (
              <pre className="my-2 overflow-x-auto rounded border border-line bg-panel p-2 font-mono text-[0.92em] leading-snug">
                {children}
              </pre>
            );
          },
          // GFM 表格：紧凑边框 + 横向滚动
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="min-w-full border-collapse border border-line font-mono text-[0.92em]">{children}</table>
              </div>
            );
          },
          thead({ children }) {
            return <thead className="bg-panel">{children}</thead>;
          },
          th({ children }) {
            return <th className="whitespace-nowrap border border-line px-2 py-1 text-left font-medium">{children}</th>;
          },
          td({ children }) {
            return <td className="border border-line px-2 py-1 align-top">{children}</td>;
          },
          // 标题：统一缩到小尺寸，适合结果面板
          h1({ children }) {
            return <h1 className="mb-2 mt-3 text-base font-semibold">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mb-1.5 mt-3 text-[15px] font-semibold">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mb-1.5 mt-2 text-[length:calc(var(--pref-fs)*0.93)] font-semibold">{children}</h3>;
          },
          p({ children }) {
            return <p className="my-1.5">{children}</p>;
          },
          ul({ children }) {
            return <ul className="my-1.5 list-disc pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1.5 list-decimal pl-5">{children}</ol>;
          },
          li({ children }) {
            return <li className="my-0.5">{children}</li>;
          },
          a({ children, href }) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-ai underline decoration-dotted">
                {children}
              </a>
            );
          },
          blockquote({ children }) {
            return <blockquote className="my-2 border-l-2 border-line pl-3 text-dim">{children}</blockquote>;
          },
          hr() {
            return <hr className="my-3 border-line" />;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
