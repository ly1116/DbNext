import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import { KindIcon } from './KindIcon';
import { OtpManagerDialog } from './OtpManagerDialog';
import type { ConnectionConfig, ConnectionKind, EnvironmentTag, OtpEntryView } from '@shared/types';
import { Icon } from '@renderer/components/common/icons';

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
  { id: 'oracle', label: 'Oracle', badge: 'O', color: 'bg-[#c74634]' },
  { id: 'redis', label: 'Redis', badge: 'R', color: 'bg-[#d82c20]' },
  { id: 'ssh', label: 'SSH', badge: '⇅', color: 'bg-[#3f7f4f]' },
];

export const DEFAULT_PORT: Record<ConnectionKind, number> = { mysql: 3306, postgres: 5432, oracle: 1521, redis: 6379, ssh: 22, bastion: 22, nacos: 8848 };

/**
 * 新建连接类型目录（DBeaver 式分组宫格，第一步选择器）。
 * 仅收录本客户端真实接入的类型；`kind` 为实际建连用的 ConnectionKind——
 * Vastbase/openGauss 走 PostgreSQL 协议接入，卡片只是展示别名（kind 仍为 postgres）。
 */
const TYPE_CATALOG: { group: string; items: { kind: ConnectionKind; label: string; hint?: string; /** 图标覆盖（如同 kind 多品牌别名，如 Vastbase 用 openGauss 图标） */ icon?: string }[] }[] = [
  {
    group: '关系型数据库',
    items: [
      { kind: 'mysql', label: 'MySQL' },
      { kind: 'postgres', label: 'PostgreSQL' },
      { kind: 'oracle', label: 'Oracle' },
    ],
  },
  {
    group: '国产数据库',
    items: [{ kind: 'postgres', label: 'openGauss', icon: 'opengauss' }],
  },
  {
    group: 'NoSQL / 缓存',
    items: [{ kind: 'redis', label: 'Redis' }],
  },
  {
    /** 注册与配置中心（架构上预留多类型：etcd / ZooKeeper / Consul 后续按需接入） */
    group: '注册与配置',
    items: [{ kind: 'nacos', label: 'Nacos' }],
  },
  {
    group: '主机连接',
    items: [{ kind: 'ssh', label: 'SSH 主机' }],
  },
];

const CATALOG_FLAT = TYPE_CATALOG.flatMap((c) => c.items.map((it) => ({ ...it, group: c.group })));

const ENV_LABEL: Record<EnvironmentTag, string> = { dev: '开发', staging: '预发', prod: '生产', bastion: '堡垒机' };
const ENV_ORDER: EnvironmentTag[] = ['dev', 'staging', 'prod'];

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right text-[11px] text-dim">
        {required && <span className="text-prod">*</span>}
        {label}
      </span>
      <div className="min-w-0 flex-1">
        {children}
        {hint && <div className="mt-1 text-[10px] leading-snug text-dim2">{hint}</div>}
      </div>
    </label>
  );
}

/** 左侧分类按钮（数据库 / 主机分区列表项） */
function CatBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-4 py-1.5 text-left text-[12px] transition-colors ${
        active ? 'bg-panel3 font-medium text-fg' : 'text-dim hover:text-fg'
      }`}
    >
      {label}
    </button>
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
  const [tab, setTab] = useState<'basic' | 'tunnel' | 'otp'>('basic');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [otpViews, setOtpViews] = useState<OtpEntryView[]>([]);
  const [otpMgrOpen, setOtpMgrOpen] = useState(false);
  /** 两步流（DBeaver 式）：新建一律先选类型再填表单（SSH 主机同样走选择页）；仅编辑直达表单 */
  const [step, setStep] = useState<'type' | 'form'>(() => (form.id ? 'form' : 'type'));
  /** 第一步选中项（按目录 label 区分同 kind 别名，如 PostgreSQL 与 Vastbase） */
  const [selLabel, setSelLabel] = useState<string | null>(
    () => CATALOG_FLAT.find((it) => it.kind === (preset?.kind ?? initial.kind))?.label ?? null,
  );
  /** 第一步左侧分类过滤（null = 全部）与搜索关键字 */
  const [typeGroup, setTypeGroup] = useState<string | null>(null);
  const [typeKw, setTypeKw] = useState('');

  const set = <K extends keyof ConnectionConfig>(k: K, v: ConnectionConfig[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const isDb = form.kind === 'mysql' || form.kind === 'postgres' || form.kind === 'oracle' || form.kind === 'redis';
  const isSsh = form.kind === 'ssh' || form.kind === 'bastion';
  const isNacos = form.kind === 'nacos';
  const kindMeta = KINDS.find((k) => k.id === form.kind);
  /** 类型选择器可见项：有 kindScope 时仅展示范围内类型（按侧栏分类新建） */
  const scoped = !!preset?.kindScope;
  const visibleKinds = scoped ? KINDS.filter((k) => preset!.kindScope!.includes(k.id)) : KINDS;
  /** 第一步目录：kindScope 过滤 + 左侧分类 / 搜索关键字过滤 */
  const scopeKinds = preset?.kindScope;
  const chooserGroups = TYPE_CATALOG.filter((c) => !typeGroup || c.group === typeGroup)
    .map((c) => ({
      group: c.group,
      items: c.items.filter(
        (it) =>
          (!scopeKinds || scopeKinds.includes(it.kind)) &&
          (!typeKw || it.label.toLowerCase().includes(typeKw.toLowerCase())),
      ),
    }))
    .filter((c) => c.items.length > 0);
  /** 左侧分类只显示当前范围覆盖的分组——主机与数据库彻底分开：数据库入口不见主机分类，反之亦然 */
  const scopeCatalog = TYPE_CATALOG.filter((c) => !scopeKinds || c.items.some((it) => scopeKinds.includes(it.kind)));
  const dbCats = scopeCatalog.filter((c) => c.group !== '主机连接' && c.group !== '注册与配置');
  const regCats = scopeCatalog.filter((c) => c.group === '注册与配置');
  const hostCats = scopeCatalog.filter((c) => c.group === '主机连接');
  /** 选中项的图标覆盖（同 kind 多品牌时按目录 label 区分，如 Vastbase → openGauss 图标） */
  const selIcon = CATALOG_FLAT.find((it) => it.label === selLabel)?.icon;

  const sshList = connections
    .filter((c) => c.kind === 'ssh' || c.kind === 'bastion')
    .map((c) => ({ id: c.id, name: c.name, host: c.host }));

  const switchKind = (k: ConnectionKind) => {
    setForm((f) => ({ ...f, kind: k, port: DEFAULT_PORT[k] }));
    setTab('basic');
  };

  // OTP 条目下拉数据：进入双因素页签 / 关闭管理器时刷新
  useEffect(() => {
    if (tab === 'otp') {
      void api.otpList().then(setOtpViews).catch(() => {});
    }
  }, [tab, otpMgrOpen]);

  const save = async () => {
    if (!form.name || !form.host) {
      setMsg({ ok: false, text: '名称与主机为必填' });
      return;
    }
    // 启用了 SSH 隧道但没选跳板机：直接保存会导致连接时静默直连（隧道被跳过），这里拦截
    if (isDb && form.useTunnel && !form.tunnelId) {
      setMsg({ ok: false, text: '已启用 SSH 隧道，请选择跳板机（SSH 连接）' });
      setTab('tunnel');
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
        sid: form.sid,
        contextPath: form.contextPath,
        environment: (form.environment as EnvironmentTag) ?? 'dev',
        group: form.group,
        useTunnel: form.useTunnel,
        tunnelId: form.tunnelId,
        remark: form.remark,
        // 双因素认证：仅在已关联条目且开启自动填入时保存
        otp: form.otp?.autoFill && form.otp?.entryId ? { entryId: form.otp.entryId, autoFill: true } : undefined,
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-6" onMouseDown={onClose}>
      <div
        className={`flex ${step === 'type' ? 'h-[500px]' : 'max-h-full'} w-[640px] flex-col overflow-hidden rounded-xl border border-line2 bg-panel shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
          <span className="text-[13px] font-medium text-fg">{form.id ? '编辑连接' : '新建连接'}</span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-dim hover:bg-panel3 hover:text-fg" title="关闭">
            <Icon name="close" className="h-3.5 w-3.5"  />
          </button>
        </div>

        {step === 'type' ? (
          <>
            {/* 第一步：类型选择器（DBeaver 式：左侧分类 + 搜索 + 分组宫格） */}
            <div className="flex min-h-0 flex-1">
              {/* 左侧分类过滤：按 数据库 / 主机 两大域分区，且只列出当前范围覆盖的分类 */}
              <div className="w-32 shrink-0 overflow-y-auto border-r border-line py-2.5">
                <button
                  onClick={() => setTypeGroup(null)}
                  className={`block w-full px-4 py-1.5 text-left text-[12px] transition-colors ${
                    typeGroup === null ? 'bg-panel3 font-medium text-fg' : 'text-dim hover:text-fg'
                  }`}
                >
                  全部
                </button>
                {dbCats.length > 0 && <div className="px-4 pb-1 pt-2.5 text-[10px] text-dim2/70">数据库</div>}
                {dbCats.map(({ group }) => (
                  <CatBtn key={group} label={group} active={typeGroup === group} onClick={() => setTypeGroup(group)} />
                ))}
                {regCats.length > 0 && <div className="px-4 pb-1 pt-2.5 text-[10px] text-dim2/70">注册与配置</div>}
                {regCats.map(({ group }) => (
                  <CatBtn key={group} label={group} active={typeGroup === group} onClick={() => setTypeGroup(group)} />
                ))}
                {hostCats.length > 0 && <div className="px-4 pb-1 pt-2.5 text-[10px] text-dim2/70">主机</div>}
                {hostCats.map(({ group }) => (
                  <CatBtn key={group} label={group} active={typeGroup === group} onClick={() => setTypeGroup(group)} />
                ))}
              </div>
              {/* 搜索 + 分组宫格 */}
              <div className="flex min-w-0 flex-1 flex-col p-4">
                <div className="relative mb-3 shrink-0">
                  <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-dim2"  />
                  <input
                    autoFocus
                    value={typeKw}
                    onChange={(e) => setTypeKw(e.target.value)}
                    /* .ipt 是未分层 CSS，优先级高于 Tailwind 工具类，pl-8 会被其 padding 覆盖，故用内联样式留出图标位 */
                    className="ipt w-full"
                    style={{ paddingLeft: 32 }}
                    placeholder="搜索类型"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  {chooserGroups.map(({ group, items }, gi) => (
                    <div key={group} className="mb-4">
                      {/* 全部视图：数据库与主机之间加醒目分隔，避免两类混在一起 */}
                      {typeGroup === null && group === '注册与配置' && gi > 0 && (
                        <div className="mb-3 mt-1 flex items-center gap-2">
                          <div className="h-px flex-1 bg-line2" />
                          <span className="text-[10px] tracking-wide text-dim2">注册与配置</span>
                          <div className="h-px flex-1 bg-line2" />
                        </div>
                      )}
                      {typeGroup === null && group === '主机连接' && gi > 0 && (
                        <div className="mb-3 mt-1 flex items-center gap-2">
                          <div className="h-px flex-1 bg-line2" />
                          <span className="text-[10px] tracking-wide text-dim2">主 机</span>
                          <div className="h-px flex-1 bg-line2" />
                        </div>
                      )}
                      <div className="mb-2 text-[11px] text-dim2">{group}</div>
                      <div className="grid grid-cols-4 gap-2.5">
                        {items.map((it) => {
                          const on = selLabel === it.label;
                          return (
                            <button
                              key={it.label}
                              onClick={() => {
                                setSelLabel(it.label);
                                switchKind(it.kind);
                              }}
                              onDoubleClick={() => {
                                setSelLabel(it.label);
                                switchKind(it.kind);
                                setStep('form');
                              }}
                              title={it.hint}
                              className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-3.5 transition-colors ${
                                on ? 'border-accent bg-panel3 shadow-sm' : 'border-line2 hover:border-dim2 hover:bg-panel3'
                              }`}
                            >
                              <KindIcon kind={it.icon ?? it.kind} className="h-8 w-8" />
                              <span className={`text-[12px] ${on ? 'font-medium text-fg' : 'text-dim'}`}>{it.label}</span>
                              {it.hint && <span className="text-[9px] leading-tight text-dim2">{it.hint}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {chooserGroups.length === 0 && <div className="py-12 text-center text-[12px] text-dim2">无匹配类型</div>}
                </div>
              </div>
            </div>
            {/* 第一步底部：已选择 + 下一步 */}
            <div className="flex h-12 shrink-0 items-center gap-2 border-t border-line bg-panel2 px-4">
              <KindIcon kind={selIcon ?? form.kind ?? 'mysql'} className="h-4 w-4" />
              <span className="text-[12px] text-dim">
                已选择: <span className="font-medium text-fg">{selLabel ?? '—'}</span>
                {scoped && <span className="ml-2 text-[11px] text-dim2">（当前栏限定了可选类型）</span>}
              </span>
              <div className="flex-1" />
              <button onClick={onClose} className="rounded px-3 py-1.5 text-[12px] text-dim hover:text-fg">
                取消
              </button>
              <button
                onClick={() => setStep('form')}
                disabled={!selLabel}
                className="rounded bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:bg-accent2 disabled:opacity-50"
              >
                下一步 →
              </button>
            </div>
          </>
        ) : (
          <>
            {/* 类型区：编辑保留宫格可换类型；新建来自第一步选择器，展示选中类型 + 重选入口 */}
            {form.id ? (
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
                      <KindIcon kind={k.id} className="h-7 w-7" />
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
            ) : (
              <div className="shrink-0 px-4 pt-3">
                <div className="flex items-center gap-2 rounded-lg border border-line2 bg-panel2 px-3 py-2">
                  <KindIcon kind={selIcon ?? form.kind ?? 'mysql'} className="h-5 w-5" />
                  <span className="text-[12px] font-medium text-fg">{selLabel ?? kindMeta?.label ?? '—'}</span>
                  {scoped && <span className="text-[10px] text-dim2">（当前栏仅可新建以下类型）</span>}
                  <div className="flex-1" />
                  <button onClick={() => setStep('type')} className="text-[11px] text-accent2 hover:underline">
                    重选类型
                  </button>
                </div>
              </div>
            )}

        {/* 标签页（仅展示已真实实现的页） */}
        <div className="mt-3 flex shrink-0 gap-4 border-b border-line px-4 text-[12px]">
          {([
            ['basic', '基本'],
            ...(isDb ? ([['tunnel', 'SSH 隧道']] as const) : []),
            ...(isSsh ? ([['otp', '双因素认证']] as const) : []),
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
                <input value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} className="ipt w-full" placeholder={isNacos ? '用户名（未开启鉴权可留空）' : '用户名'} />
              </Field>
              {isDb && form.kind === 'oracle' && (
                <>
                  <Field label="服务名">
                    <input value={form.database ?? ''} onChange={(e) => set('database', e.target.value)} className="ipt w-full" placeholder="如 ORCLPDB（Easy Connect 服务名）" />
                  </Field>
                  <Field label="SID">
                    <input value={form.sid ?? ''} onChange={(e) => set('sid', e.target.value)} className="ipt w-full" placeholder="（与服务名二选一）如 ORCL" />
                  </Field>
                </>
              )}
              {isDb && form.kind !== 'oracle' && (
                <Field label="数据库">
                  <input value={form.database ?? ''} onChange={(e) => set('database', e.target.value)} className="ipt w-full" placeholder="（可选）默认库" />
                </Field>
              )}
              {isNacos && (
                <Field label="上下文">
                  <input value={form.contextPath ?? ''} onChange={(e) => set('contextPath', e.target.value)} className="ipt w-full" placeholder="（默认 /nacos）" />
                </Field>
              )}
              {isNacos && (
                <Field
                  label="连接方案"
                  hint="按 Nacos 服务器版本选择（决定走哪套 REST 接口）。注意：Nacos 2.x 服务器用的也是 v1 REST 接口（/v1/**），只有 3.x 才提供 /v3/console/**；不存在 /v2/ REST 接口。"
                >
                  <div className="flex gap-2">
                    {([
                      ['nacos2', 'Nacos 1.x / 2.x', 'REST 接口 /v1/**（2.x 服务器通用，gRPC 协议虽升级但 HTTP API 仍是 v1）'],
                      ['nacos3', 'Nacos 3.x', 'REST 接口 /v3/console/**（3.x 专用，统一响应体 + 新版鉴权）'],
                      ['rnacos', 'r-nacos', 'REST 接口 /v1/**（Rust 实现版 Nacos，兼容 v1）'],
                    ] as const).map(([id, label, desc]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => set('apiVersion', id)}
                        className={`flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                          (form.apiVersion ?? 'nacos2') === id
                            ? 'border-accent bg-panel3 ring-1 ring-accent'
                            : 'border-line2 bg-panel2 hover:border-line2 hover:bg-panel3'
                        }`}
                      >
                        <div className={`text-[12px] font-medium ${(form.apiVersion ?? 'nacos2') === id ? 'text-fg' : 'text-dim'}`}>{label}</div>
                        <div className="mt-0.5 text-[10px] leading-snug text-dim2">{desc}</div>
                      </button>
                    ))}
                  </div>
                </Field>
              )}
              {!isNacos && (
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
              )}
              {!isNacos && (form.authType ?? 'password') === 'privateKey' ? (
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
          ) : tab === 'tunnel' ? (
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
              {form.useTunnel && sshList.length === 0 && (
                <p className="rounded border border-line2 bg-panel2 px-3 py-2 text-[11px] leading-relaxed text-dim2">
                  尚无可用跳板机：请先在左侧「SSH / 堡垒机」面板新建一条 SSH 连接（主机/账号/密钥都配在那条连接里），再回到这里选择。
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-dim2">
                启用后，主进程会先建立到跳板机的 SSH 连接，再通过 forwardOut 端口转发连接目标 {kindMeta?.label ?? '数据库'}，凭据全程加密。
              </p>
            </div>
          ) : (
            /* 双因素认证页：OTP 动态码免输入登录（SSH 连接） */
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-dim">
                <input
                  type="checkbox"
                  checked={!!form.otp?.autoFill}
                  onChange={(e) =>
                    set('otp', { entryId: form.otp?.entryId ?? '', autoFill: e.target.checked })
                  }
                />
                自动填入验证码（免输入登录）
              </label>
              <Field label="OTP 条目">
                <div className="flex w-full gap-2">
                  <select
                    value={form.otp?.entryId ?? ''}
                    onChange={(e) =>
                      set('otp', { entryId: e.target.value, autoFill: form.otp?.autoFill ?? true })
                    }
                    className="ipt min-w-0 flex-1"
                    disabled={!form.otp?.autoFill}
                  >
                    <option value="">选择 OTP 条目…</option>
                    {otpViews.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}（TOTP · {(v.algorithm ?? 'sha1').toUpperCase()} · {v.digits ?? 6}）
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => setOtpMgrOpen(true)}
                    className="shrink-0 rounded border border-line2 px-3 py-1 text-[11px] text-dim hover:text-fg"
                  >
                    管理…
                  </button>
                </div>
              </Field>
              <p className="text-[11px] leading-relaxed text-dim2">
                连接时若服务器要求双因素验证（keyboard-interactive 动态码提示，或登录后 shell 内的
                「MFA验证码 / Verification code」提示），将自动按所选条目的 TOTP 密钥计算当前验证码并填入，
                无需手动打开 Authenticator。OTP 密钥经本机加密存储，验证码仅在内存中即时计算。
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
          </>
        )}
      </div>

      {/* OTP 条目管理器（模态浮层，关闭后刷新下拉数据） */}
      {otpMgrOpen && <OtpManagerDialog onClose={() => setOtpMgrOpen(false)} onChanged={() => {}} />}
    </div>
  );
}
