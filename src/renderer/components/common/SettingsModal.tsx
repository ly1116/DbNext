import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { usePrefs } from '@renderer/store/prefsStore';
import type { AiModelConfig, AiSettings, GeneralPrefs, ThemeName } from '@shared/types';
import { CloudSyncPane } from './CloudSyncPane';

/**
 * 设置弹窗（模态，非页面跳转）—— 左侧分类 + 右侧表单，所有修改**即时生效**：
 *
 * - 无「应用 / 确认 / 取消」按钮：表单 onChange 即写回主进程持久化；
 * - 分类：系统（常规/外观）/ AI 助手（模型管理）/ 数据库 / SSH / 同步（导入导出）。
 *
 * @since 0.1.0
 */
type Category = 'general' | 'ai' | 'db' | 'ssh' | 'sync';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'general', label: '系统' },
  { id: 'ai', label: 'AI 助手' },
  { id: 'db', label: '数据库' },
  { id: 'ssh', label: 'SSH' },
  { id: 'sync', label: '同步' },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cat, setCat] = useState<Category>('general');

  return (
    /* 遮罩：点击空白处关闭 */
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={onClose}>
      <div
        className="flex h-[520px] w-[720px] overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 左侧分类导航 */}
        <div className="flex w-[148px] shrink-0 flex-col border-r border-line bg-panel2 py-2">
          <div className="px-4 pb-2 pt-1 text-[13px] font-medium text-fg">设置</div>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={`mx-2 flex items-center rounded-md px-3 py-1.5 text-left text-[12px] transition-colors ${
                cat === c.id ? 'bg-panel3 text-fg' : 'text-dim hover:bg-panel3/60 hover:text-fg'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* 右侧表单区（随分类切换） */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
            <span className="text-[12px] font-medium text-fg">{CATEGORIES.find((c) => c.id === cat)?.label}</span>
            <span className="ml-3 text-[10px] text-dim2">修改即时生效，自动保存</span>
            <button onClick={onClose} className="ml-auto rounded p-1 text-dim hover:bg-panel3 hover:text-fg" title="关闭">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {cat === 'general' && <GeneralPane />}
            {cat === 'ai' && <AiSettingsPane />}
            {cat === 'db' && <DbPane />}
            {cat === 'ssh' && <SshPane />}
            {cat === 'sync' && <CloudSyncPane />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ———————————————————————— 通用偏好：读取 + 即时写回 ———————————————————————— */

/**
 * 偏好读写（走全局 prefsStore：修改即时传播到终端 / AI 等消费方并落盘）。
 * 表单 onChange 即 patch，无「应用」按钮。
 */
function usePrefsForm(): [GeneralPrefs, (patch: Partial<GeneralPrefs>) => void] {
  const prefs = usePrefs((s) => s.prefs);
  const patch = usePrefs((s) => s.patch);
  return [prefs, patch];
}

/* ———————————————————————— 系统：常规 + 外观 ———————————————————————— */
function GeneralPane() {
  const [prefs, patch] = usePrefsForm();

  return (
    <div className="max-w-[460px] space-y-3.5 text-[12px]">
      <Row label="默认终端">
        <Select
          value={prefs.defaultShell}
          onChange={(v) => patch({ defaultShell: v as GeneralPrefs['defaultShell'] })}
          options={[
            ['bash', 'bash'],
            ['zsh', 'zsh'],
            ['sh', 'sh'],
            ['powershell', 'powershell'],
          ]}
        />
      </Row>
      <Row label="启动时确认连接">
        <Toggle checked={prefs.confirmOnStartup} onChange={(v) => patch({ confirmOnStartup: v })} />
      </Row>
      <Row label="自动保存间隔（秒）">
        <NumberInput value={prefs.autoSaveIntervalSec} min={0} max={600} onChange={(v) => patch({ autoSaveIntervalSec: v })} hint="0 = 关闭" />
      </Row>
      <Row label="会话保留（分钟）">
        <NumberInput value={prefs.sessionRetentionMin} min={0} max={10080} onChange={(v) => patch({ sessionRetentionMin: v })} hint="0 = 不保留历史" />
      </Row>

      <Divider />
      <div className="text-[11px] font-medium text-dim">外观</div>
      <Row label="字体大小">
        <NumberInput value={prefs.fontSize} min={10} max={24} onChange={(v) => patch({ fontSize: v })} />
      </Row>
      <Row label="配色方案">
        <Select
          value={prefs.theme}
          onChange={(v) => patch({ theme: v as ThemeName })}
          options={[
            ['darcula', 'Darcula'],
            ['dracula', 'Dracula'],
            ['nord', 'Nord'],
            ['monokai', 'Monokai'],
            ['gruvbox', 'Gruvbox'],
          ]}
        />
      </Row>
    </div>
  );
}

/* ———————————————————————— AI 助手：默认模型 + 模型管理 ———————————————————————— */
function AiSettingsPane() {
  const [prefs, patch] = usePrefsForm();
  const [s, setS] = useState<AiSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在编辑的模型（null=未打开编辑器；'new'=新增；否则为模型 id） */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiModelConfig | null>(null);

  useEffect(() => {
    api.getAiSettings().then(setS).catch((e) => setMsg(`读取设置失败：${(e as Error).message}`));
  }, []);

  if (!s) return <div className="text-[12px] text-dim2">{msg ?? '加载中…'}</div>;

  const save = async (next: AiSettings) => {
    setBusy(true);
    setMsg(null);
    try {
      const saved = await api.setAiSettings(next);
      setS(saved);
      setEditing(null);
      setDraft(null);
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** 打开「新增模型」编辑器 */
  const openNew = () =>
    setDraft({ id: `m-${Date.now().toString(36)}`, name: '', baseURL: 'https://api.openai.com/v1', model: '', apiKey: '', isDefault: s.models.length === 0 });

  /** 打开「编辑」编辑器 */
  const openEdit = (id: string) => {
    const m = s.models.find((x) => x.id === id);
    if (m) {
      setDraft({ ...m });
      setEditing(id);
    }
  };

  /** 提交编辑器（新增或更新） */
  const submitEdit = () => {
    if (!draft || !draft.name.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
      setMsg('请填写名称、模型 ID 与 API Key');
      return;
    }
    let models = s.models.slice();
    if (editing === 'new' || !s.models.some((x) => x.id === draft.id)) {
      models.push(draft);
    } else {
      models = models.map((x) => (x.id === draft.id ? draft : x));
    }
    // 若勾选默认，确保仅该条为默认
    if (draft.isDefault) models = models.map((x) => ({ ...x, isDefault: x.id === draft.id }));
    save({ ...s, models });
  };

  /** 设为默认 */
  const makeDefault = (id: string) =>
    save({ ...s, models: s.models.map((x) => ({ ...x, isDefault: x.id === id })) });

  /** 删除模型 */
  const remove = (id: string) => save({ ...s, models: s.models.filter((x) => x.id !== id) });

  return (
    <div className="max-w-[520px] space-y-3 text-[12px]">
      <Row label="默认模型">
        <Select
          value={prefs.defaultModelId}
          onChange={(v) => patch({ defaultModelId: v })}
          options={s.models.map((m) => [m.id, m.name || m.model] as [string, string])}
          emptyLabel="跟随模型列表中的默认标记"
        />
      </Row>

      {/* 模型列表 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-dim">自定义模型（{s.models.length}）</span>
          <button
            onClick={openNew}
            className="rounded border border-line2 px-2 py-0.5 text-[11px] text-accent hover:bg-panel3"
          >
            + 新增模型
          </button>
        </div>
        {s.models.length === 0 && (
          <div className="rounded border border-dashed border-line2 px-3 py-4 text-center text-[11px] text-dim2">
            还没有配置任何模型。点击「+ 新增模型」添加 OpenAI 兼容的接口（如 GPT / 自建 Qwen 网关）。
          </div>
        )}
        {s.models.map((m) => (
          <div key={m.id} className="rounded border border-line2 bg-bg px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-fg">{m.name || '(未命名)'}</span>
              {m.isDefault && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">默认</span>}
              <div className="ml-auto flex items-center gap-2 text-[11px]">
                {!m.isDefault && (
                  <button onClick={() => makeDefault(m.id)} className="text-dim2 hover:text-fg">设为默认</button>
                )}
                <button onClick={() => openEdit(m.id)} className="text-dim2 hover:text-fg">编辑</button>
                <button onClick={() => remove(m.id)} className="text-prod hover:underline">删除</button>
              </div>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-dim2">{m.model} · {m.baseURL}</div>
          </div>
        ))}
      </div>

      {/* 新增/编辑编辑器 */}
      {draft && (
        <div className="space-y-2 rounded border border-line2 bg-panel p-3">
          <div className="text-[11px] font-medium text-fg">{editing === 'new' ? '新增模型' : '编辑模型'}</div>
          <Field label="名称">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="ipt w-full" placeholder="如 GPT-4o / 自建 Qwen-32B" />
          </Field>
          <Field label="接口地址">
            <input value={draft.baseURL} onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} className="ipt w-full" placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label="模型 ID">
            <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} className="ipt w-full" placeholder="gpt-4o-mini" />
          </Field>
          <Field label="API Key">
            <input type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} className="ipt w-full" placeholder="sk-…（保存后加密落盘）" />
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />
            <span className="text-dim">设为默认模型（对话默认使用）</span>
          </label>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={submitEdit} disabled={busy} className="rounded bg-accent px-3 py-1 text-[11px] font-medium text-white hover:bg-accent2 disabled:opacity-50">保存</button>
            <button onClick={() => { setEditing(null); setDraft(null); }} className="rounded border border-line2 px-3 py-1 text-[11px] text-dim hover:bg-panel3">取消</button>
          </div>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-dim2">
        兼容任何 OpenAI 格式接口（含自建网关）。每条模型的 Key 仅存储在本机加密配置中，不会随连接导出文件外泄。
      </p>
      {msg && <div className="text-[11px] text-dim">{msg}</div>}
    </div>
  );
}

/* ———————————————————————— 数据库 ———————————————————————— */
function DbPane() {
  return (
    <div className="max-w-[460px] space-y-3 text-[12px]">
      <div className="rounded border border-line2 bg-bg px-3 py-3 text-[11px] leading-relaxed text-dim">
        <p className="mb-1.5 font-medium text-fg">数据库连接说明</p>
        <p>· MySQL / PostgreSQL 连接支持经 SSH 跳板机建立加密隧道（编辑连接 → SSH 隧道）。</p>
        <p>· SQL 编辑器与数据网格针对真实驱动执行（mysql2 / pg），结果集由数据库返回。</p>
        <p>· 结构对比基于 information_schema 真实内省，逐表展示增 / 改 / 删。</p>
      </div>
      <p className="text-[11px] text-dim2">数据库专属偏好（如默认结果集行数限制）将在后续版本提供。</p>
    </div>
  );
}

/* ———————————————————————— SSH ———————————————————————— */
function SshPane() {
  const [prefs, patch] = usePrefsForm();

  return (
    <div className="max-w-[460px] space-y-3.5 text-[12px]">
      <Row label="默认 SFTP 目录">
        <input
          value={prefs.defaultSftpDir}
          onChange={(e) => patch({ defaultSftpDir: e.target.value })}
          className="ipt w-full"
          placeholder="/root"
        />
      </Row>
      <Row label="默认命令目录">
        <input
          value={prefs.defaultCmdDir}
          onChange={(e) => patch({ defaultCmdDir: e.target.value })}
          className="ipt w-full"
          placeholder="/"
        />
      </Row>
      <p className="text-[11px] leading-relaxed text-dim2">
        新开 SSH / SFTP 会话时以此为初始路径。终端字体大小与配色方案在「系统 → 外观」中调整。
      </p>
    </div>
  );
}

/* ———————————————————————— 通用控件 ———————————————————————— */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-4">
      <span className="w-[130px] shrink-0 text-right text-[11px] text-dim">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right text-[11px] text-dim">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-line" />;
}

function Select({
  value,
  onChange,
  options,
  emptyLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
  emptyLabel?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="ipt w-full">
      {emptyLabel && <option value="">{emptyLabel}</option>}
      {options.map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  );
}

function NumberInput({
  value,
  min,
  max,
  onChange,
  hint,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
        className="ipt w-24"
      />
      {hint && <span className="text-[10px] text-dim2">{hint}</span>}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line2'}`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  );
}
