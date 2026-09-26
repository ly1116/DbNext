import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { AiMessage } from '@shared/types';

/**
 * AI 对话共享 hook（真实流式）。
 *
 * - 发送时把历史交给 `api.aiAsk`，主进程调用 OpenAI 兼容接口并流式回传增量；
 * - 增量经 `onAiChunk` 实时累积到 `draft`，`onAiDone` 时落盘成一条 assistant 消息；
 * - 任一时刻只处理一轮对话（streaming 锁），避免并发交错。
 *
 * @since 0.1.0
 */
export function useAiChat(initial: AiMessage[] = []) {
  const [messages, setMessages] = useState<AiMessage[]>(initial);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const draftRef = useRef('');

  useEffect(() => {
    const offChunk = api.onAiChunk((d: string) => {
      draftRef.current += d;
      setDraft(draftRef.current);
    });
    const offDone = api.onAiDone(() => {
      const text = draftRef.current;
      draftRef.current = '';
      setDraft('');
      if (text) {
        setMessages((m) => [...m, { id: `a-${Date.now().toString(36)}`, role: 'assistant', content: text, ts: Date.now() }]);
      }
      setStreaming(false);
    });
    return () => {
      offChunk();
      offDone();
    };
  }, []);

  const send = useCallback(
    async (text: string, context?: string[], modelId?: string, conn?: { id: string; label: string; kind?: string }) => {
      if (streaming) return;
      const t = text.trim();
      if (!t) return;
      const userMsg: AiMessage = { id: `u-${Date.now().toString(36)}`, role: 'user', content: t, ts: Date.now() };
      const history = [...messages, userMsg];
      setMessages(history);
      setStreaming(true);
      draftRef.current = '';
      setDraft('');
      try {
        await api.aiAsk(history, context, modelId, conn);
      } catch (e) {
        setStreaming(false);
        setMessages((m) => [...m, { id: `e-${Date.now().toString(36)}`, role: 'assistant', content: `错误：${(e as Error).message}`, ts: Date.now() }]);
      }
    },
    [messages, streaming],
  );

  return { messages, draft, streaming, send };
}
