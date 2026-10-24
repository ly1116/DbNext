import { useEffect, useState } from 'react';
import { useAiChat } from '@renderer/hooks/useAiChat';
import { useAiModels } from '@renderer/hooks/useAiModels';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { ModelPicker } from '@renderer/components/common/ModelPicker';
import { Markdown } from '@renderer/components/common/Markdown';
import { FullScreenHeader } from '@renderer/components/shell/FullScreenHeader';
import type { AiMessage } from '@shared/types';
import { Icon } from '@renderer/components/common/icons';
import { Button } from '@renderer/components/ui/button';

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
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <FullScreenHeader
        title="AI 深度任务"
        accent="ai"
        actions={
          <span className="rounded border border-border bg-secondary px-1.5 text-[10px] text-muted-foreground">OpenAI 兼容流式</span>
        }
      />
      {enabled && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="shrink-0 text-[11px] text-muted-foreground">模型</span>
          <ModelPicker models={models} value={modelId} onChange={setModelId} />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 任务类型 */}
        <div className="w-[240px] shrink-0 overflow-y-auto border-r border-border bg-background p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">任务类型</div>
          {TASKS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTask(t.id)}
              className={`mb-2 block w-full rounded-md border px-3 py-2 text-left transition-colors ${task === t.id ? 'border-border bg-secondary text-foreground' : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'}`}
            >
              <div className="text-[12px] font-medium">{t.label}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{t.desc}</div>
            </button>
          ))}
        </div>

        {/* 对话 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto p-4 text-[12px]">
            {messages.length === 0 && !streamingDraft && (
              <div className="py-10 text-center text-muted-foreground">
                选择左侧任务类型，描述你的需求，AI 将以流式方式给出可落地的分析与建议。
              </div>
            )}
            {messages.map((m) => (
              <Bubble key={m.id} msg={m} />
            ))}
            {streamingDraft && <StreamingBubble text={streamingDraft} />}
          </div>
          <div className="shrink-0 border-t border-border p-3">
            <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-2 py-2 focus-within:border-primary">
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
                className="flex-1 resize-none bg-transparent px-1 text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
              />
              <Button size="sm" onClick={sendWithTask} disabled={streaming}>
                {streaming ? '生成中…' : '发送'}
              </Button>
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
        <div className="max-w-[80%] rounded-lg rounded-tr-sm border border-border bg-secondary px-3 py-2 text-foreground">{msg.content}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
        <SparkIcon />
      </div>
      <div className="flex-1 rounded-lg rounded-tl-sm border border-border bg-muted px-3 py-2.5 leading-relaxed text-foreground"><Markdown text={msg.content} /></div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
        <SparkIcon />
      </div>
      <div className="flex-1 rounded-lg rounded-tl-sm border border-border bg-muted px-3 py-2.5 leading-relaxed text-foreground"><Markdown text={text} /><span className="ml-0.5 inline-block animate-pulse">▌</span></div>
    </div>
  );
}

function SparkIcon() {
  return (
    <Icon name="mic" className="h-3 w-3 text-muted-foreground"  />
  );
}
