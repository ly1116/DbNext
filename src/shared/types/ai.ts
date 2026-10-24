/**
 * AI 领域类型（单一职责：AI 对话消息与自定义模型配置）。
 *
 * @since 0.1.0
 */

/** AI 消息角色 */
export type AiRole = 'user' | 'assistant';

/** AI 对话单条消息 */
export interface AiMessage {
  id: string;
  role: AiRole;
  content: string;
  /** 助手侧引用的上下文（文件/路径/SQL） */
  context?: string[];
  /** 时间戳 */
  ts: number;
}

/** AI 单个自定义模型配置（持久化；apiKey 加密落盘） */
export interface AiModelConfig {
  /** 模型配置唯一 ID */
  id: string;
  /** 展示名称，如「GPT-4o」「自建 Qwen-32B」 */
  name: string;
  /** 接口地址（OpenAI 兼容，含 /v1），如 https://api.openai.com/v1 或自建网关 */
  baseURL: string;
  /** 模型 ID，如 gpt-4o-mini / qwen2.5-32b-instruct */
  model: string;
  /** API Key（仅主进程内存；落盘加密） */
  apiKey: string;
  /** 是否默认（AI 对话默认使用该模型；列表中至多一个为 true） */
  isDefault: boolean;
}

/** AI 设置（持久化；每条模型的 apiKey 单独加密落盘） */
export interface AiSettings {
  /** 是否启用 AI 功能 */
  enabled: boolean;
  /** 自定义模型列表（可多条，类似 WorkBuddy 的「增加自定义模型」） */
  models: AiModelConfig[];
}
