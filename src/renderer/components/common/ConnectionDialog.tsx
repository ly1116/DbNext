import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import { KindIcon } from './KindIcon';
import { OtpManagerDialog } from './OtpManagerDialog';
import type { ConnectionConfig, ConnectionKind, EnvironmentTag, OtpEntryView } from '@shared/types';
import { Icon } from '@renderer/components/common/icons';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@renderer/components/ui/select';

/**
 * 连接编辑模态对话框（共享组件，参考专业客户端的弹窗形态）。
 *
 * 由「连接树 + / 右键编辑」与连接管理列表共同复用：
 * shadcn Dialog + 连接类型宫格 + 基本/SSH 隧道标签页 + 底部 测试/取消/保存。
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
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">
        {required && <span className="text-destructive">*</span>}
        {label}
      </span>
      <div className="min-w-0 flex-1">
        {children}
        {hint && <div className="mt-1 text-[10px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

/** 左侧分类按钮（数据库 / 主机分区列表项） */
function CatBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full px-4 py-1.5 text-left text-[12px] transition-colors ${
        active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] max-w-[700px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <DialogTitle className="text-[length:var(--fs-body)]">{form.id ? '编辑连接' : '新建连接'}</DialogTitle>
          <DialogDescription className="text-[length:var(--fs-caption)]">
            {step === 'type' ? '选择要创建的连接类型' : '填写连接参数，保存后凭据经主进程加密存储'}
          </DialogDescription>
        </DialogHeader>

        {step === 'type' ? (
          <>
            {/* 第一步：类型选择器（DBeaver 式：左侧分类 + 搜索 + 分组宫格） */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 flex-1">
                {/* 左侧分类过滤：按 数据库 / 主机 两大域分区，且只列出当前范围覆盖的分类 */}
                <div className="w-32 shrink-0 overflow-y-auto border-r border-border py-2.5">
                  <button
                    onClick={() => setTypeGroup(null)}
                    className={`block w-full px-4 py-1.5 text-left text-[12px] transition-colors ${
                      typeGroup === null ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    全部
                  </button>
                  {dbCats.length > 0 && <div className="px-4 pb-1 pt-2.5 text-[10px] text-muted-foreground/70">数据库</div>}
                  {dbCats.map(({ group }) => (
                    <CatBtn key={group} label={group} active={typeGroup === group} onClick={() => setTypeGroup(group)} />
                  ))}
                  {regCats.length > 0 && <div className="px-4 pb-1 pt-2.5 text-[10px] text-muted-foreground/70">注册与配置</div>}
                  {regCats.map(({ group }) => (
                    <CatBtn key={group} label={group} active={typeGroup === group} onClick={() => setTypeGroup(group)} />
                  ))}
                  {hostCats.length > 0 && <div className="px-4 pb-1 pt-2.5 text-[10px] text-muted-foreground/70">主机</div>}
                  {hostCats.map(({ group }) => (
                    <CatBtn key={group} label={group} active={typeGroup === group} onClick={() => setTypeGroup(group)} />
                  ))}
                </div>
                {/* 搜索 + 分组宫格 */}
                <div className="flex min-w-0 flex-1 flex-col p-4">
                  <div className="relative mb-3 shrink-0">
                    <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      autoFocus
                      value={typeKw}
                      onChange={(e) => setTypeKw(e.target.value)}
                      className="h-8 pl-8 text-[12px]"
                      placeholder="搜索类型"
                    />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                    {chooserGroups.map(({ group, items }, gi) => (
                      <div key={group} className="mb-4">
                        {/* 全部视图：数据库与主机之间加醒目分隔，避免两类混在一起 */}
                        {typeGroup === null && group === '注册与配置' && gi > 0 && (
                          <div className="mb-3 mt-1 flex items-center gap-2">
                            <div className="h-px flex-1 bg-border" />
                            <span className="text-[10px] tracking-wide text-muted-foreground">注册与配置</span>
                            <div className="h-px flex-1 bg-border" />
                          </div>
                        )}
                        {typeGroup === null && group === '主机连接' && gi > 0 && (
                          <div className="mb-3 mt-1 flex items-center gap-2">
                            <div className="h-px flex-1 bg-border" />
                            <span className="text-[10px] tracking-wide text-muted-foreground">主 机</span>
                            <div className="h-px flex-1 bg-border" />
                          </div>
                        )}
                        <div className="mb-2 text-[11px] text-muted-foreground">{group}</div>
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
                                  on ? 'border-primary bg-secondary shadow-sm' : 'border-border hover:bg-secondary'
                                }`}
                              >
                                <KindIcon kind={it.icon ?? it.kind} className="h-8 w-8" />
                                <span className={`text-[12px] ${on ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{it.label}</span>
                                {it.hint && <span className="text-[9px] leading-tight text-muted-foreground">{it.hint}</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {chooserGroups.length === 0 && <div className="py-12 text-center text-[12px] text-muted-foreground">无匹配类型</div>}
                  </div>
                </div>
              </div>
              {/* 第一步底部：已选择 + 下一步 */}
              <DialogFooter className="shrink-0 border-t border-border px-4 py-2.5 sm:justify-between">
                <div className="flex items-center gap-2">
                  <KindIcon kind={selIcon ?? form.kind ?? 'mysql'} className="h-4 w-4" />
                  <span className="text-[length:var(--fs-body)] text-muted-foreground">
                    已选择: <span className="font-medium text-foreground">{selLabel ?? '—'}</span>
                    {scoped && <span className="ml-2 text-[length:var(--fs-caption)] text-muted-foreground">（当前栏限定了可选类型）</span>}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={onClose}>
                    取消
                  </Button>
                  <Button size="sm" className="h-8 text-[12px]" onClick={() => setStep('form')} disabled={!selLabel}>
                    下一步 →
                  </Button>
                </div>
              </DialogFooter>
              </div>
            </>
          ) : (
            <>
              <div className="flex min-h-0 flex-1 flex-col">
                {/* 类型区：编辑保留宫格可换类型；新建来自第一步选择器，展示选中类型 + 重选入口 */}
                {form.id ? (
                  <div className="shrink-0 px-4 pt-3">
                    <div className="mb-1.5 text-[11px] text-muted-foreground">
                      连接类型{scoped ? '（当前栏仅可新建以下类型）' : ''}
                    </div>
                    <div className={`grid gap-2 ${scoped ? 'grid-cols-3' : 'grid-cols-6'}`}>
                      {visibleKinds.map((k) => (
                        <button
                          key={k.id}
                          onClick={() => switchKind(k.id)}
                          className={`flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2.5 transition-colors ${
                            form.kind === k.id ? 'border-primary bg-secondary' : 'border-border hover:bg-secondary'
                          }`}
                        >
                          <KindIcon kind={k.id} className="h-7 w-7" />
                          <span className={`text-[10px] ${form.kind === k.id ? 'text-foreground' : 'text-muted-foreground'}`}>{k.label}</span>
                        </button>
                      ))}
                      {!scoped && (
                        <div className="flex cursor-not-allowed flex-col items-center gap-1.5 rounded-lg border border-dashed border-border px-1 py-2.5 opacity-40">
                          <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-[14px] text-muted-foreground">+</span>
                          <span className="text-[10px] text-muted-foreground">更多</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="shrink-0 px-4 pt-3">
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
                      <KindIcon kind={selIcon ?? form.kind ?? 'mysql'} className="h-5 w-5" />
                      <span className="text-[12px] font-medium text-foreground">{selLabel ?? kindMeta?.label ?? '—'}</span>
                      {scoped && <span className="text-[10px] text-muted-foreground">（当前栏仅可新建以下类型）</span>}
                      <div className="flex-1" />
                      <button onClick={() => setStep('type')} className="text-[11px] text-primary hover:underline">
                        重选类型
                      </button>
                    </div>
                  </div>
                )}

                {/* 标签页（仅展示已真实实现的页） */}
                <div className="mt-3 flex shrink-0 gap-4 border-b border-border px-4 text-[12px]">
                  {([
                    ['basic', '基本'],
                    ...(isDb ? ([['tunnel', 'SSH 隧道']] as const) : []),
                    ...(isSsh ? ([['otp', '双因素认证']] as const) : []),
                  ] as [typeof tab, string][]).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setTab(id)}
                      className={`-mb-px border-b-2 pb-2 pt-1 ${
                        tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
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
                        <Input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} className="h-8 text-[12px]" placeholder="如 web-prod-01" />
                      </Field>
                      <Field label="主机" required>
                        <div className="flex w-full gap-2">
                          <Input value={form.host ?? ''} onChange={(e) => set('host', e.target.value)} className="h-8 min-w-0 text-[12px]" style={{ width: '80%' }} placeholder="10.0.1.5 或主机名" />
                          <Input type="number" value={form.port ?? ''} onChange={(e) => set('port', Number(e.target.value))} className="h-8 min-w-0 text-[12px]" style={{ width: '20%' }} placeholder="22" />
                        </div>
                      </Field>
                      <Field label="用户">
                        <Input value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} className="h-8 text-[12px]" placeholder={isNacos ? '用户名（未开启鉴权可留空）' : '用户名'} />
                      </Field>
                      {isDb && form.kind === 'oracle' && (
                        <>
                          <Field label="服务名">
                            <Input value={form.database ?? ''} onChange={(e) => set('database', e.target.value)} className="h-8 text-[12px]" placeholder="如 ORCLPDB（Easy Connect 服务名）" />
                          </Field>
                          <Field label="SID">
                            <Input value={form.sid ?? ''} onChange={(e) => set('sid', e.target.value)} className="h-8 text-[12px]" placeholder="（与服务名二选一）如 ORCL" />
                          </Field>
                        </>
                      )}
                      {isDb && form.kind !== 'oracle' && (
                        <Field label="数据库">
                          <Input value={form.database ?? ''} onChange={(e) => set('database', e.target.value)} className="h-8 text-[12px]" placeholder="（可选）默认库" />
                        </Field>
                      )}
                      {isNacos && (
                        <Field label="上下文">
                          <Input value={form.contextPath ?? ''} onChange={(e) => set('contextPath', e.target.value)} className="h-8 text-[12px]" placeholder="（默认 /nacos）" />
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
                                    ? 'border-primary bg-secondary ring-1 ring-primary'
                                    : 'border-border bg-muted hover:bg-secondary'
                                }`}
                              >
                                <div className={`text-[12px] font-medium ${(form.apiVersion ?? 'nacos2') === id ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</div>
                                <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{desc}</div>
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
                                  (form.authType ?? 'password') === id ? 'border-primary bg-secondary text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
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
                              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            />
                          </Field>
                          <Field label="私钥口令">
                            <Input type="password" value={form.passphrase ?? ''} onChange={(e) => set('passphrase', e.target.value)} className="h-8 text-[12px]" placeholder={form.id ? '留空则沿用已存' : '（可选）'} />
                          </Field>
                        </>
                      ) : (
                        <Field label="密码">
                          <Input type="password" value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} className="h-8 text-[12px]" placeholder={form.id ? '留空则沿用已存口令' : '••••••••'} />
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
                                    ? 'border-destructive text-destructive'
                                    : 'border-primary text-foreground'
                                  : 'border-border text-muted-foreground hover:text-foreground'
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
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Switch id="use-tunnel" checked={!!form.useTunnel} onCheckedChange={(v) => set('useTunnel', v)} />
                        <label htmlFor="use-tunnel" className="cursor-pointer text-[12px]">通过 SSH 跳板机连接（端口转发）</label>
                      </div>
                      {form.useTunnel && (
                        <Field label="跳板机">
                          <Select
                            value={form.tunnelId || '__none__'}
                            onValueChange={(v) => set('tunnelId', v === '__none__' ? '' : v)}
                          >
                            <SelectTrigger className="h-8 text-[12px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">选择 SSH 连接…</SelectItem>
                              {sshList.map((c) => (
                                <SelectItem key={c.id} value={c.id}>{c.name} · {c.host}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                      {form.useTunnel && sshList.length === 0 && (
                        <p className="rounded border border-border bg-muted px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                          尚无可用跳板机：请先在左侧「SSH / 堡垒机」面板新建一条 SSH 连接（主机/账号/密钥都配在那条连接里），再回到这里选择。
                        </p>
                      )}
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        启用后，主进程会先建立到跳板机的 SSH 连接，再通过 forwardOut 端口转发连接目标 {kindMeta?.label ?? '数据库'}，凭据全程加密。
                      </p>
                    </div>
                  ) : (
                    /* 双因素认证页：OTP 动态码免输入登录（SSH 连接） */
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Switch
                          id="otp-autofill"
                          checked={!!form.otp?.autoFill}
                          onCheckedChange={(v) =>
                            set('otp', { entryId: form.otp?.entryId ?? '', autoFill: v })
                          }
                        />
                        <label htmlFor="otp-autofill" className="cursor-pointer text-[12px]">自动填入验证码（免输入登录）</label>
                      </div>
                      <Field label="OTP 条目">
                        <div className="flex w-full gap-2">
                          <Select
                            value={form.otp?.entryId || '__none__'}
                            onValueChange={(v) =>
                              set('otp', { entryId: v === '__none__' ? '' : v, autoFill: form.otp?.autoFill ?? true })
                            }
                            disabled={!form.otp?.autoFill}
                          >
                            <SelectTrigger className="h-8 min-w-0 flex-1 text-[12px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">选择 OTP 条目…</SelectItem>
                              {otpViews.map((v) => (
                                <SelectItem key={v.id} value={v.id}>
                                  {v.label}（TOTP · {(v.algorithm ?? 'sha1').toUpperCase()} · {v.digits ?? 6}）
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 shrink-0 text-[11px]"
                            onClick={() => setOtpMgrOpen(true)}
                          >
                            管理…
                          </Button>
                        </div>
                      </Field>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        连接时若服务器要求双因素验证（keyboard-interactive 动态码提示，或登录后 shell 内的
                        「MFA验证码 / Verification code」提示），将自动按所选条目的 TOTP 密钥计算当前验证码并填入，
                        无需手动打开 Authenticator。OTP 密钥经本机加密存储，验证码仅在内存中即时计算。
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* 底部操作条：左测试 / 右取消+保存 */}
              <DialogFooter className="shrink-0 border-t border-border px-4 py-2.5 sm:justify-between">
                <div className="flex items-center gap-3">
                  <Button variant="outline" size="sm" className="h-8 border-border text-[12px]" onClick={() => void test()} disabled={busy}>
                    → 测试连接
                  </Button>
                  {msg && <span className={`text-[length:var(--fs-caption)] ${msg.ok ? 'text-success' : 'text-destructive'}`}>{msg.text}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={onClose}>
                    取消
                  </Button>
                  <Button size="sm" className="h-8 text-[12px]" onClick={() => void save()} disabled={busy}>
                    保存
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}

          {/* OTP 条目管理器（模态浮层，关闭后刷新下拉数据） */}
          {otpMgrOpen && <OtpManagerDialog onClose={() => setOtpMgrOpen(false)} onChanged={() => {}} />}
        </DialogContent>
      </Dialog>
  );
}
