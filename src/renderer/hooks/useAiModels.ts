import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { usePrefs } from '@renderer/store/prefsStore';
import type { AiModelConfig } from '@shared/types';

/**
 * 读取已配置的 AI 模型列表（设置 → AI 助手）。
 *
 * 返回「全部模型」与「默认模型 ID」。默认优先级：
 * 1. 设置里显式选择的默认模型（defaultModelId，引用有效时）；
 * 2. 模型列表中的「默认」标记；
 * 3. 列表第一条。
 *
 * 供聊天界面在发送时指定使用哪个自定义模型。
 *
 * @since 0.1.0
 */
export function useAiModels() {
  const [models, setModels] = useState<AiModelConfig[]>([]);
  const defaultModelId = usePrefs((s) => s.prefs.defaultModelId);

  useEffect(() => {
    api
      .getAiSettings()
      .then((s) => setModels(s.models))
      .catch(() => setModels([]));
  }, []);

  const defaultId =
    models.find((m) => m.id === defaultModelId)?.id ??
    models.find((m) => m.isDefault)?.id ??
    models[0]?.id ??
    null;
  const enabled = models.length > 0;
  return { models, defaultId, enabled };
}
