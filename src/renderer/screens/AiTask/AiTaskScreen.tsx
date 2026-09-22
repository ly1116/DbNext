import { useEffect, useState } from 'react';
import { useAiChat } from '@renderer/hooks/useAiChat';
import { useAiModels } from '@renderer/hooks/useAiModels';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { ModelPicker } from '@renderer/components/common/ModelPicker';
import type { AiMessage } from '@shared/types';

type TaskKind = 'review' | 'generate' | 'optimize';

/**
 * ⑪ AI 深度任务屏幕（真实实现）。
 *
 * 比侧栏更完整的 AI 工作台：选择任务类型（审查 / 生成 / 优化），底部输入自然语言，
 * 经 `useAiChat` 调用 OpenAI 兼容接口并**流式**展示结论与可采纳的修改建议。
 *
 * 不依赖任何 mock 历史——首次进入为空，所有消息均来自真实模型回复。
 *
 * @since 0.1.0
 */
const TASKS: { id: TaskKind; label: string; desc: string; prompt: string }[] = [
  { id: 'review', label: '代码审查', desc: '分析选中文件，列出问题并给出一键修复', prompt: '请审查以下代码并指出潜在问题：' },
  { id: 'generate', label: 'SQL 生成', desc: '根据自然语言描述生成 SQL', prompt: '请生成一条 SQL，实现以下需求：' },
  { id: 'optimize', label: '性能优化', desc: '分析慢查询 / 慢脚本并给出优化方案', prompt: '请分析以下查询/脚本的性能瓶颈并给出优化方案：' },
];

export function AiTaskScreen() {
  const { messages, draft: streamingDraft, streaming, send } = useAiChat();
  const [task, setTask] = useState<TaskKind>('review');
  const [input, setInput] = useState('');
  const { models, defaultId, enabled } = useAiModels();
  const [modelId, setModelId] = useState<string | null>(null);

  // 当前连接：优先聚焦的 SSH 终端，回退连接树选中项（仅 SSH/堡垒机可让 AI 执行命令）
  const activeTerm = useAppStore((s) => s.activeTerm);
  const selectedId = useConnections((s) => s.selectedId);
  const connections = useConnections((s) => s.connections);
  const conn = connections.find((c) => c.id === (activeTerm ?? selectedId)) ?? null;
  const isSshConn = conn?.kind === 'ssh' || conn?.kind === 'bastion';
  const aiConn = isSshConn && conn ? { id: conn.id, label: `${conn.host}${conn.username ? ` (${conn.username})` : ''}` } : undefined;

  useEffect(() => {
    if (modelId === null && defaultId) setModelId(defaultId);
  }, [defaultId, modelId]);

  const sendWithTask = () => {
    const t = input.trim();
    if (!t) return;
    const header = TASKS.find((x) => x.id === task)?.prompt ?? '';
    void send(`${header}\n${t}`, undefined, modelId ?? undefined, aiConn);
    setInput('');
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-line2 bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">AI 深度任务</span>
        <span className="rounded bg-ai/20 px-1.5 text-[10px] text-ai">OpenAI 兼容流式</span>
        {enabled && (
          <div className="ml-auto">
            <ModelPicker models={models} value={modelId} onChange={setModelId} />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 任务类型 */}
        <div className="w-[240px] shrink-0 border-r border-line bg-panel p-3">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-dim">任务类型</div>
          {TASKS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTask(t.id)}
              className={`mb-2 block w-full rounded px-3 py-2 text-left ${task === t.id ? 'bg-ai/20 text-fg' : 'text-dim hover:bg-panel3'}`}
            >
              <div className="text-[12px] font-medium">{t.label}</div>
              <div className="mt-0.5 text-[10px] text-dim2">{t.desc}</div>
            </button>
          ))}
        </div>

        {/* 对话 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
            {messages.length === 0 && !streamingDraft && (
              <div className="py-10 text-center text-dim2">
                选择左侧任务类型，描述你的需求，AI 将以流式方式给出可落地的分析与建议。
              </div>
            )}
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} />
            ))}
            {streamingDraft && <StreamingBubble text={streamingDraft} />}
          </div>
          <div className="shrink-0 border-t border-line p-3">
            <div className="flex items-end gap-2 rounded-lg border border-line2 bg-bg px-2 py-2 focus-within:border-ai">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendWithTask();
                  }
                }}
                rows={2}
                placeholder="描述你的任务，或粘贴待分析的代码/SQL…"
                className="flex-1 resize-none bg-transparent px-1 text-[12px] text-fg outline-none placeholder:text-dim2"
              />
              <button onClick={sendWithTask} disabled={streaming} className="rounded bg-ai px-3 py-1.5 font-medium text-white hover:bg-ai2 disabled:opacity-60">
                {streaming ? '生成中…' : '发送'}
              </button>
            </div>
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
        <div className="max-w-[80%] rounded-lg rounded-tr-sm border border-accent/30 bg-accent/20 px-3 py-2 text-fg">{msg.content}</div>
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
      <div className="flex-1 whitespace-pre-wrap rounded-lg rounded-tl-sm border border-line bg-panel2 px-3 py-2.5 leading-relaxed text-fg">{text}<span className="ml-0.5 inline-block animate-pulse">▌</span></div>
    </div>
  );
}

function SparkIcon() {
  return (
    <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    </svg>
  );
}
