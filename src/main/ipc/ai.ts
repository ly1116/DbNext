import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type { AiMessage } from '@shared/types';
import { loadAiSettings } from '../services/connection-store';
import { updateSettings, ask as aiAsk } from '../services/ai.service';

/** AI 对话 IPC 通道（设置读写 + 流式问答）。 */
export function registerAiIpc(): void {
  handle(IPC.AI_GET_SETTINGS, () => loadAiSettings());
  handle(IPC.AI_SET_SETTINGS, (_e, s) => updateSettings(s));
  handle(IPC.AI_ASK, async (e, history: AiMessage[], context?: string[], modelId?: string, conn?: { id: string; label: string; kind?: string; db?: string }) => {
    const requestId = `ai-${Date.now().toString(36)}`;
    const full = await aiAsk(
      history,
      context,
      (delta) => {
        e.sender.send(IPC.AI_CHUNK, { requestId, delta });
      },
      modelId,
      conn,
    );
    e.sender.send(IPC.AI_DONE, { requestId });
    return full;
  });
}
