import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { errMsg } from '@renderer/utils/errMsg';
import type { AiMessage } from '@shared/types';

/**
 * 把 AI 调用抛出的错误转成用户可读、可操作的中文提示。
 * 原始错误形如 `Error invoking remote method 'ai:ask': Error: Connection error.`，
 * 经 errMsg 剥掉 IPC 前缀后，再按已知模式映射为引导性文案，避免把底层技术错误直接暴露给用户。
 */
function friendlyAiError(e: unknown): string {
  const raw = errMsg(e);
  if (/connection error|econn|enotfound|fetch failed|network|timeout/i.test(raw)) {
    return '连接 AI 服务失败：请检查「设置 → AI 助手」中的接口地址（baseURL 是否可达）与网络连通性，并确认 API Key 有效。';
  }
  if (/api key|401|unauthorized|invalid|authentication/i.test(raw)) {
    return 'AI 服务鉴权失败：请检查「设置 → AI 助手」中该模型的 API Key 是否正确。';
  }
  if (/模型|model/i.test(raw)) {
    return `AI 模型配置有误：${raw}`;
  }
  return `AI 请求失败：${raw}`;
}

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
        setMessages((m) => [...m, { id: `e-${Date.now().toString(36)}`, role: 'assistant', content: friendlyAiError(e), ts: Date.now() }]);
      }
    },
    [messages, streaming],
  );

  return { messages, draft, streaming, send };
}
