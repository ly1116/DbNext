import { useState, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { ConnectionConfig, ConnectionKind, EnvironmentTag } from '@shared/types';

/**
 * 连接编辑模态对话框（共享组件，参考专业客户端的弹窗形态）。
 *
 * 由「连接树 + / 右键编辑」与连接管理列表共同复用：
 * 遮罩层 + 连接类型宫格 + 基本/SSH 隧道标签页 + 底部 测试/取消/保存。
 * 保存走 `api.saveConnection()`（主进程加密凭据后落盘），测试走真实建连。
 *
 * @since 0.1.0
 */
export const KINDS: { id: ConnectionKind; label: string; badge: string; color: string }[] = [
  { id: 'mysql', label: 'MySQL', badge: 'M', color: 'bg-[#00758f]' },
  { id: 'postgres', label: 'PostgreSQL', badge: 'P', color: 'bg-[#336791]' },
  { id: 'redis', label: 'Redis', badge: 'R', color: 'bg-[#d82c20]' },
  { id: 'ssh', label: 'SSH', badge: '⇅', color: 'bg-[#3f7f4f]' },
  { id: 'bastion', label: '堡垒机', badge: '⛨', color: 'bg-[#8a6d1f]' },
];

export const DEFAULT_PORT: Record<ConnectionKind, number> = { mysql: 3306, postgres: 5432, redis: 6379, ssh: 22, bastion: 22 };

const ENV_LABEL: Record<EnvironmentTag, string> = { dev: '开发', staging: '预发', prod: '生产', bastion: '堡垒机' };
const ENV_ORDER: EnvironmentTag[] = ['dev', 'staging', 'prod', 'bastion'];

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right text-[11px] text-dim">
        {required && <span className="text-prod">*</span>}
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

export function ConnectionDialog({
  initial,
  preset,
  onClose,
  onSaved,
}: {
  initial: Partial<ConnectionConfig>;
  /** 预置：按侧栏分类新建时限定可选择的连接类型范围（如 SSH 栏只给 ssh/堡垒机） */
  preset?: { kind?: ConnectionKind; kindScope?: ConnectionKind[]; group?: string };
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const connections = useConnections((s) => s.connections);
  const refresh = useConnections((s) => s.load);

  const [form, setForm] = useState<Partial<ConnectionConfig>>(initial);
  const [tab, setTab] = useState<'basic' | 'tunnel'>('basic');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const isDb = form.kind === 'mysql' || form.kind === 'postgres' || form.kind === 'redis';
  const kindMeta = KINDS.find((k) => k.id === form.kind);
  /** 类型选择器可见项：有 kindScope 时仅展示范围内类型（按侧栏分类新建） */
  const scoped = !!preset?.kindScope;
  const visibleKinds = scoped ? KINDS.filter((k) => preset!.kindScope!.includes(k.id)) : KINDS;

  const sshList = connections
    .filter((c) => c.kind === 'ssh' || c.kind === 'bastion')
    .map((c) => ({ id: c.id, name: c.name, host: c.host }));

  const switchKind = (k: ConnectionKind) => {
    setForm((f) => ({ ...f, kind: k, port: DEFAULT_PORT[k] }));
    setTab('basic');
  };

  const save = async () => {
    if (!form.name || !form.host) {
      setMsg({ ok: false, text: '名称与主机为必填' });
      return;
    }
    setBusy(true);
    try {
      const cfg: ConnectionConfig = {
        id: form.id ?? '',
        name: form.name,
        kind: form.kind ?? 'mysql',
        host: form.host,
        port: form.port ?? DEFAULT_PORT[form.kind ?? 'mysql'],
        username: form.username ?? '',
        authType: form.authType,
        password: form.password,
        privateKey: form.privateKey,
        passphrase: form.passphrase,
        database: form.database,
        environment: (form.environment as EnvironmentTag) ?? 'dev',
        group: form.group,
        useTunnel: form.useTunnel,
        tunnelId: form.tunnelId,
        remark: form.remark,
      };
      const saved = await api.saveConnection(cfg);
      void refresh();
      onSaved(`已保存：${saved.name}`);
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setMsg({ ok: false, text: '测试中…' });
    try {
      const r = await api.testConnection(form as ConnectionConfig);
      setMsg({ ok: r.ok, text: r.latencyMs != null ? `${r.message}（${r.latencyMs}ms）` : r.message });
    } catch (e) {
      setMsg({ ok: false, text: `测试失败：${(e as Error).message}` });
    }
  };

  return (
    /* 遮罩：点击空白处关闭 */
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={onClose}>
      <div
        className="flex max-h-full w-[640px] flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
          <span className="text-[13px] font-medium text-fg">{form.id ? '编辑连接' : '新建连接'}</span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-dim hover:bg-panel3 hover:text-fg" title="关闭">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* 连接类型宫格（按侧栏分类新建时仅展示范围内类型） */}
        <div className="shrink-0 px-4 pt-3">
          <div className="mb-1.5 text-[11px] text-dim">
            连接类型{scoped ? '（当前栏仅可新建以下类型）' : ''}
          </div>
          <div className={`grid gap-2 ${scoped ? 'grid-cols-3' : 'grid-cols-6'}`}>
            {visibleKinds.map((k) => (
              <button
                key={k.id}
                onClick={() => switchKind(k.id)}
                className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 transition-colors ${
                  form.kind === k.id ? 'border-accent bg-panel3' : 'border-line2 hover:border-dim2 hover:bg-panel3'
                }`}
              >
                <span className={`flex h-7 w-7 items-center justify-center rounded-md text-[12px] font-bold text-white ${k.color}`}>
                  {k.badge}
                </span>
                <span className={`text-[10px] ${form.kind === k.id ? 'text-fg' : 'text-dim'}`}>{k.label}</span>
              </button>
            ))}
            {!scoped && (
              <div className="flex cursor-not-allowed flex-col items-center gap-1.5 rounded-lg border border-dashed border-line2 px-1 py-2.5 opacity-40">
                <span className="flex h-7 w-7 items-center justify-center rounded-md border border-line2 text-[14px] text-dim">+</span>
                <span className="text-[10px] text-dim">更多</span>
              </div>
            )}
          </div>
        </div>

        {/* 标签页（仅展示已真实实现的页） */}
        <div className="mt-3 flex shrink-0 gap-4 border-b border-line px-4 text-[12px]">
          {([
            ['basic', '基本'],
            ...(isDb ? ([['tunnel', 'SSH 隧道']] as const) : []),
          ] as [typeof tab, string][]).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 pb-2 pt-1 ${
                tab === id ? 'border-accent text-fg' : 'border-transparent text-dim hover:text-fg'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 表单区 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          {tab === 'basic' ? (
            <div className="flex flex-col gap-3">
              <Field label="名称" required>
                <input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} className="ipt w-full" placeholder="如 web-prod-01" />
              </Field>
              <Field label="主机" required>
                <div className="flex w-full gap-2">
                  <input value={form.host ?? ''} onChange={(e) => set('host', e.target.value)} className="ipt min-w-0" style={{ width: '80%' }} placeholder="10.0.1.5 或主机名" />
                  <input type="number" value={form.port ?? ''} onChange={(e) => set('port', Number(e.target.value))} className="ipt min-w-0" style={{ width: '20%' }} placeholder="22" />
                </div>
              </Field>
              <Field label="用户">
                <input value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} className="ipt w-full" placeholder="用户名" />
              </Field>
              {isDb && (
                <Field label="数据库">
                  <input value={form.database ?? ''} onChange={(e) => set('database', e.target.value)} className="ipt w-full" placeholder="（可选）默认库" />
                </Field>
              )}
              <Field label="认证方式">
                <div className="flex gap-1.5">
                  {([
                    ['password', '密码'],
                    ['privateKey', '密钥文件'],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => set('authType', id)}
                      className={`rounded border px-3 py-1 text-[11px] ${
                        (form.authType ?? 'password') === id ? 'border-accent bg-panel3 text-fg' : 'border-line2 text-dim hover:text-fg'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
              {(form.authType ?? 'password') === 'privateKey' ? (
                <>
                  <Field label="私钥">
                    <textarea
                      value={form.privateKey ?? ''}
                      onChange={(e) => set('privateKey', e.target.value)}
                      className="ipt h-20 w-full font-mono"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    />
                  </Field>
                  <Field label="私钥口令">
                    <input type="password" value={form.passphrase ?? ''} onChange={(e) => set('passphrase', e.target.value)} className="ipt w-full" placeholder={form.id ? '留空则沿用已存' : '（可选）'} />
                  </Field>
                </>
              ) : (
                <Field label="密码">
                  <input type="password" value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} className="ipt w-full" placeholder={form.id ? '留空则沿用已存口令' : '••••••••'} />
                </Field>
              )}
              <Field label="环境">
                <div className="flex gap-1.5">
                  {ENV_ORDER.map((e) => (
                    <button
                      key={e}
                      onClick={() => set('environment', e)}
                      className={`rounded border px-3 py-1 text-[11px] ${
                        (form.environment ?? 'dev') === e
                          ? e === 'prod'
                            ? 'border-prod text-prod'
                            : 'border-accent text-fg'
                          : 'border-line2 text-dim hover:text-fg'
                      }`}
                    >
                      {ENV_LABEL[e]}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          ) : (
            /* SSH 隧道页：数据库经跳板机端口转发 */
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-dim">
                <input type="checkbox" checked={!!form.useTunnel} onChange={(e) => set('useTunnel', e.target.checked)} />
                通过 SSH 跳板机连接（端口转发）
              </label>
              {form.useTunnel && (
                <Field label="跳板机">
                  <select value={form.tunnelId ?? ''} onChange={(e) => set('tunnelId', e.target.value)} className="ipt w-full">
                    <option value="">选择 SSH 连接…</option>
                    {sshList.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} · {c.host}</option>
                    ))}
                  </select>
                </Field>
              )}
              <p className="text-[11px] leading-relaxed text-dim2">
                启用后，主进程会先建立到跳板机的 SSH 连接，再通过 forwardOut 端口转发连接目标 {kindMeta?.label ?? '数据库'}，凭据全程加密。
              </p>
            </div>
          )}
        </div>

        {/* 底部操作条：左测试 / 右取消+保存 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-panel2 px-4">
          <button onClick={() => void test()} disabled={busy} className="rounded border border-line2 px-3 py-1.5 text-[12px] text-dim hover:text-fg disabled:opacity-50">
            → 测试连接
          </button>
          {msg && <span className={`text-[11px] ${msg.ok ? 'text-ok' : 'text-prod'}`}>{msg.text}</span>}
          <div className="flex-1" />
          <button onClick={onClose} className="rounded px-3 py-1.5 text-[12px] text-dim hover:text-fg">
            取消
          </button>
          <button onClick={() => void save()} disabled={busy} className="rounded bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:bg-accent2 disabled:opacity-50">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
