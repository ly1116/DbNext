import { useEffect, useState } from 'react';
import { useAiChat } from '@renderer/hooks/useAiChat';
import { useAiModels } from '@renderer/hooks/useAiModels';
import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { ModelPicker } from '@renderer/components/common/ModelPicker';
import { Markdown } from '@renderer/components/common/Markdown';
import { Button } from '@renderer/components/ui/button';
import type { AiMessage } from '@shared/types';
import { Icon } from '@renderer/components/common/icons';

/**
 * AI 助手侧栏（真实实现）。
 *
 * 顶部显示上下文（当前选中的连接），中部为对话流（流式），底部为输入框。
 * 发送时把历史交给 `useAiChat` → 主进程 OpenAI 兼容接口流式返回，全部真实，无 mock。
 *
 * 宽度由外层传入（工作台的分隔线可拖拽调整），默认 320px。
 *
 * @since 0.1.0
 */
export function AiSidebar({ width = 320 }: { width?: number }) {
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
  const isDbConn = conn?.kind === 'mysql' || conn?.kind === 'postgres' || conn?.kind === 'oracle';
  // 数据库连接仅在已连接时开放只读 SQL 工具（未连接无真实会话可执行）
  const dbReady = isDbConn && conn?.status === 'connected';

  // 上下文 + 工具可用的连接（SSH 可执行命令 / 数据库可执行只读 SQL）
  const ctx = conn
    ? [
        `连接: ${conn.kind} ${conn.name}`,
        `主机: ${conn.host}:${conn.port ?? ''}  用户: ${conn.username ?? ''}`,
        `状态: ${conn.status}  环境: ${conn.environment ?? ''}`,
        isSshConn
          ? `可在该 SSH 主机执行命令（df -h / free -m 等）`
          : dbReady
            ? `可对该数据库执行只读 SQL 获取真实数据（SELECT / WITH / SHOW）`
            : isDbConn
              ? '该数据库连接未建立，无法查询真实数据'
              : '该连接非 SSH，无法在主机上执行命令',
      ].filter(Boolean)
    : undefined;
  const aiConn =
    conn && (isSshConn || dbReady)
      ? { id: conn.id, label: `${conn.host}${conn.username ? ` (${conn.username})` : ''}`, kind: conn.kind }
      : undefined;

  // 初次拿到模型列表时，默认选中「默认模型」
  useEffect(() => {
    if (modelId === null && defaultId) setModelId(defaultId);
  }, [defaultId, modelId]);

  // 菜单「生成 SQL / 解释这条 SQL / 优化建议」触发的预填提示词，消费后清空
  const aiPrefill = useAppStore((s) => s.aiPrefill);
  const setAiPrefill = useAppStore((s) => s.setAiPrefill);
  useEffect(() => {
    if (aiPrefill) {
      setInput(aiPrefill);
      setAiPrefill(null);
    }
  }, [aiPrefill, setAiPrefill]);

  const submit = () => {
    const t = input.trim();
    if (!t) return;
    void send(t, ctx, modelId ?? undefined, aiConn);
    setInput('');
  };

  return (
    <div className="flex shrink-0 flex-col bg-background" style={{ width }}>
      {/* 头部（统一 flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 规范） */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <SparkIcon />
        </div>
        <span className="shrink-0 whitespace-nowrap text-sm font-semibold text-foreground">AI 助手</span>
        <span className="shrink-0 whitespace-nowrap rounded bg-secondary px-1.5 py-0.5 text-[length:var(--fs-micro)] text-muted-foreground">流式</span>
        {enabled && (
          <div className="min-w-0 flex-1">
            <ModelPicker models={models} value={modelId} onChange={setModelId} />
          </div>
        )}
        <button
          onClick={() => useAppStore.getState().openOverlay({ kind: 'aitask' })}
          className={`shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground ${enabled ? '' : 'ml-auto'}`}
          title="打开 AI 深度任务（审查 / 生成 / 优化）"
        >
          <span className="whitespace-nowrap">深度任务</span>
        </button>
        <button
          onClick={() => useAppStore.getState().toggleAiSidebar(false)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="关闭 AI 助手"
          aria-label="关闭 AI 助手"
        >
          <Icon name="close" className="h-3 w-3" strokeWidth={1.8} />
        </button>
      </div>

      {/* 上下文 */}
      <div className="shrink-0 border-b border-border bg-muted px-3 py-2">
        <div className="mb-1.5 text-[10px] text-muted-foreground">上下文</div>
        <div className="flex flex-wrap gap-1.5">
          {conn ? (
            <Tag>
              <span className={`h-1.5 w-1.5 rounded-full ${conn.status === 'connected' ? 'bg-success' : 'bg-destructive'}`} />
              {conn.name}
              <span className="text-muted-foreground">{conn.host}</span>
              {(aiConn) && <span className="rounded bg-primary/20 px-1 text-[9px] text-primary">{isDbConn ? '可查询' : '可操作'}</span>}
            </Tag>
          ) : (
            <span className="text-[10px] text-muted-foreground">未选中连接</span>
          )}
        </div>
      </div>

      {/* 对话流 */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-[12px]">
        {messages.length === 0 && !draft && (
          <div className="py-6 text-center text-[11px] text-muted-foreground">
            问我任何问题，或先选中一个连接以带入上下文（选中数据库连接可查询真实数据）。
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
        {draft && <StreamingBubble text={draft} />}
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-border p-2.5">
        <div className="rounded-lg border border-border bg-background transition-all focus-within:border-primary">
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
            className="w-full resize-none bg-transparent px-3 py-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-1 px-2 pb-2">
            <button className="rounded px-1.5 text-[10px] text-muted-foreground hover:text-foreground">@ 引用</button>
            <button className="rounded px-1.5 text-[10px] text-muted-foreground hover:text-foreground">/ 命令</button>
            <Button
              onClick={submit}
              disabled={streaming}
              className="ml-auto h-6 w-6 shrink-0"
              size="icon"
              title="发送"
            >
              <Icon name="arrowUp-2" className="h-3.5 w-3.5" />
            </Button>
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
        <div className="max-w-[85%] rounded-lg rounded-tr-sm border border-primary/30 bg-primary/20 px-3 py-2 text-foreground">{msg.content}</div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
        <SparkIcon />
      </div>
      <div className="flex-1 rounded-lg rounded-tl-sm border border-border bg-muted px-3 py-2.5 leading-relaxed text-foreground">
        <Markdown text={msg.content} />
      </div>
    </div>
  );
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
        <SparkIcon />
      </div>
      <div className="flex-1 rounded-lg rounded-tl-sm border border-border bg-muted px-3 py-2.5 leading-relaxed text-foreground">
        <Markdown text={text} />
        <span className="ml-0.5 inline-block animate-pulse">▌</span>
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-foreground">{children}</span>;
}

function SparkIcon() {
  return (
    <Icon name="mic" className="h-3 w-3 text-foreground"  />
  );
}
