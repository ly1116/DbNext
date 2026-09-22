import type { AiModelConfig } from '@shared/types';

/**
 * AI 模型选择下拉（WorkBuddy 式：从设置里已配置的自定义模型中选择本次对话使用的模型）。
 *
 * @since 0.1.0
 */
export function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: AiModelConfig[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (!models.length) {
    return <span className="text-[10px] text-dim2">未配置模型</span>;
  }
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-line2 bg-bg px-1.5 py-0.5 text-[10px] text-dim hover:text-fg focus:outline-none"
      title="选择本次对话使用的模型"
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.isDefault ? ' ·默认' : ''}
        </option>
      ))}
    </select>
  );
}
