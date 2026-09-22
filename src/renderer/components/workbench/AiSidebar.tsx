import { useEffect, useState } from 'react';
import { useAiChat } from '@renderer/hooks/useAiChat';
import { useAiModels } from '@renderer/hooks/useAiModels';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { ModelPicker } from '@renderer/components/common/ModelPicker';
import type { AiMessage } from '@shared/types';

/**
 * AI 助手侧栏（真实实现）。
 *
 * 顶部显示上下文（当前选中的连接），中部为对话流（流式），底部为输入框。
 * 发送时把历史交给 `useAiChat` → 主进程 OpenAI 兼容接口流式返回，全部真实，无 mock。
 *
 * @since 0.1.0
 */
export function AiSidebar() {
  const { messages, draft, streaming, send } = useAiChat();
  const [input, setInput] = useState('');
  const { models, defaultId, enabled } = useAiModels();
  const [modelId, setModelId] = useState<string | null>(null);

  // 当前连接：优先「聚焦的 SSH 终端」，回退「连接树选中项」
  const activeTerm = useAppStore((s) => s.activeTerm);
  const selectedId = useConnections((s) => s.selectedId);
  const connections = useConnections((s) => s.connections);
  const conn = connections.find((c) => c.id === (activeTerm ?? selectedId)) ?? null;
  const isSshConn = conn?.kind === 'ssh' || conn?.kind === 'bastion';

  // 上下文 + 工具可用的连接（仅 SSH / 堡垒机）：让 AI 能在真实主机上执行命令
  const ctx = conn
    ? [
        `连接: ${conn.kind} ${conn.name}`,
        `主机: ${conn.host}:${conn.port ?? ''}  用户: ${conn.username ?? ''}`,
        `状态: ${conn.status}  环境: ${conn.environment ?? ''}`,
        isSshConn ? `可在该 SSH 主机执行命令（df -h / free -m 等）` : '该连接非 SSH，无法在主机上执行命令',
      ].filter(Boolean)
    : undefined;
  const aiConn = isSshConn && conn ? { id: conn.id, label: `${conn.host}${conn.username ? ` (${conn.username})` : ''}` } : undefined;

  // 初次拿到模型列表时，默认选中「默认模型」
  useEffect(() => {
    if (modelId === null && defaultId) setModelId(defaultId);
  }, [defaultId, modelId]);

  const submit = () => {
    const t = input.trim();
    if (!t) return;
    void send(t, ctx, modelId ?? undefined, aiConn);
    setInput('');
  };

  return (
    <div className="flex w-[320px] shrink-0 flex-col border-l border-line bg-panel">
      {/* 头部 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-ai to-ai2">
          <SparkIcon />
        </div>
        <span className="text-[12px] font-medium">AI 助手</span>
        <span className="rounded bg-panel3 px-1.5 py-0.5 text-[10px] text-dim2">流式</span>
        {enabled && (
          <ModelPicker models={models} value={modelId} onChange={setModelId} />
        )}
        <button
          onClick={() => useAppStore.getState().openOverlay({ kind: 'aitask' })}
          className="ml-auto rounded border border-line2 px-1.5 py-0.5 text-[10px] text-dim hover:text-fg"
          title="打开 AI 深度任务（审查 / 生成 / 优化）"
        >
          深度任务
        </button>
        <button
          onClick={() => useAppStore.getState().toggleAiSidebar(false)}
          className="flex h-5 w-5 items-center justify-center rounded text-dim hover:bg-panel3 hover:text-fg"
          title="关闭 AI 助手"
          aria-label="关闭 AI 助手"
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path d="m5 5 14 14M19 5 5 19" />
          </svg>
        </button>
      </div>

      {/* 上下文 */}
      <div className="shrink-0 border-b border-line bg-ai/5 px-3 py-2">
        <div className="mb-1.5 text-[10px] text-dim2">上下文</div>
        <div className="flex flex-wrap gap-1.5">
          {conn ? (
            <Tag>
              <span className={`h-1.5 w-1.5 rounded-full ${conn.status === 'connected' ? 'bg-ok' : 'bg-prod'}`} />
              {conn.name}
              <span className="text-dim2">{conn.host}</span>
              {aiConn && <span className="rounded bg-accent/20 px-1 text-[9px] text-accent">可操作</span>}
            </Tag>
          ) : (
            <span className="text-[10px] text-dim2">未选中连接</span>
          )}
        </div>
      </div>

      {/* 对话流 */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-[12px]">
        {messages.length === 0 && !draft && (
          <div className="py-6 text-center text-[11px] text-dim2">
            问我任何问题，或先选中一个连接以带入上下文。
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
        {draft && <StreamingBubble text={draft} />}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-line p-2.5">
        <div className="rounded-lg border border-line2 bg-bg transition-all focus-within:border-ai">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder="问我任何问题…"
            className="w-full resize-none bg-transparent px-3 py-2 text-[12px] text-fg outline-none placeholder:text-dim2"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <button className="rounded px-1.5 text-[10px] text-dim hover:text-fg">@ 引用</button>
            <button className="rounded px-1.5 text-[10px] text-dim hover:text-fg">/ 命令</button>
            <button
              onClick={submit}
              disabled={streaming}
              className="ml-auto flex h-6 w-6 items-center justify-center rounded bg-ai text-white hover:bg-ai2 disabled:opacity-60"
              title="发送"
            >
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="m5 12 7-7 7 7M12 19V5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ msg }: { msg: AiMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg rounded-tr-sm border border-accent/30 bg-accent/20 px-3 py-2 text-fg">{msg.content}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-ai to-ai2">
        <SparkIcon />
      </div>
      <div className="flex-1 whitespace-pre-wrap rounded-lg rounded-tl-sm border border-line bg-panel2 px-3 py-2.5 leading-relaxed text-fg">{msg.content}</div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-ai to-ai2">
        <SparkIcon />
      </div>
      <div className="flex-1 whitespace-pre-wrap rounded-lg rounded-tl-sm border border-line bg-panel2 px-3 py-2.5 leading-relaxed text-fg">
        {text}
        <span className="ml-0.5 inline-block animate-pulse">▌</span>
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center gap-1 rounded bg-panel3 px-1.5 py-0.5 text-[10px] text-fg">{children}</span>;
}

function SparkIcon() {
  return (
    <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    </svg>
  );
}
