import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import { usePrefs } from '@renderer/store/prefsStore';
import { Empty, ErrorBox } from '@renderer/components/common/States';
import type { SyncConfigView, SyncResult } from '@shared/types';

/**
 * 云同步设置面板（基于 Gitee 代码片段 / gist）。
 *
 * 流程：
 * 1. 填入 Gitee 私人令牌（需 gists 权限）与「同步口令」（用于加密同步内容）；
 * 2. 「推送到云」——首次自动在 Gitee 创建私有 gist 并记下 id，之后增量更新；
 * 3. 「从云拉取」——读取 gist、用同步口令解密、合并回本地（含凭据，跨机可还原）；
 * 4. 额外保留「本地备份 / 恢复」卡片（导出/导入加密 profile 文件），用于离线迁移。
 *
 * 凭据安全：令牌与同步口令仅在主进程经 safeStorage 加密落盘；gist 内容整体经同步口令
 * 做 AES-256-GCM 加密，Gitee 侧只见密文。渲染端永不持有明文令牌/口令。
 *
 * @since 0.1.0
 */
export function CloudSyncPane() {
  const connections = useConnections((s) => s.connections);
  const refresh = useConnections((s) => s.load);
  const [cfg, setCfg] = useState<SyncConfigView | null>(null);
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // 本地备份
  const [localBusy, setLocalBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [localInfo, setLocalInfo] = useState<string | null>(null);

  useEffect(() => {
    api.getSyncConfig().then(setCfg).catch((e) => setError((e as Error).message));
  }, []);

  const showResult = (r: SyncResult) => {
    if (r.ok) {
      setInfo(r.message + (r.syncedAt ? `（${new Date(r.syncedAt).toLocaleString()}）` : ''));
      setError(null);
    } else {
      setError(r.message);
      setInfo(null);
    }
  };

  const doSaveConfig = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.setSyncConfig(token, passphrase);
      setCfg(next);
      setSavedAt(new Date().toLocaleString());
      setInfo('配置已加密保存到本机。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doPush = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // 若本次填写了令牌/口令，先落盘使其后续可用
      if (token || passphrase) await api.setSyncConfig(token, passphrase).then(setCfg);
      const r = await api.pushSync(token, passphrase);
      if (r.ok) {
        const next = await api.getSyncConfig();
        setCfg(next);
      }
      showResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doPull = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (token || passphrase) await api.setSyncConfig(token, passphrase).then(setCfg);
      const r = await api.pullSync(token, passphrase);
      showResult(r);
      if (r.ok) {
        // 拉取改变了本地连接/偏好，刷新渲染端
        await refresh();
        usePrefs.getState().load();
        const next = await api.getSyncConfig();
        setCfg(next);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // ——— 本地备份 / 恢复（复用既有 profile 导入导出）———
  const doExport = async () => {
    setLocalBusy(true);
    setLocalErr(null);
    setLocalInfo(null);
    try {
      const json = await api.exportProfile();
      const path = await api.openDialog({ kind: 'save', title: '导出连接配置', defaultPath: 'dbnest-profile.json' });
      if (!path) return;
      await api.writeFile(path, json);
      setLocalInfo(`已导出 ${connections.length} 个连接到：${path}`);
    } catch (e) {
      setLocalErr((e as Error).message);
    } finally {
      setLocalBusy(false);
    }
  };

  const doImport = async () => {
    setLocalBusy(true);
    setLocalErr(null);
    setLocalInfo(null);
    try {
      const path = await api.openDialog({ kind: 'file', title: '导入连接配置' });
      if (!path) return;
      const json = await api.readFile(path);
      const imported = await api.importProfile(json);
      await refresh();
      setLocalInfo(`已导入 ${imported.length} 个连接（重复 id 已覆盖）。`);
    } catch (e) {
      setLocalErr((e as Error).message);
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-[12px]">
      {connections.length === 0 && <Empty text="当前没有任何连接可同步。先在工作台新建连接。" />}

      {/* —— Gitee 云同步 —— */}
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-fg">Gitee 云同步</span>
          <Badge ok={!!cfg?.hasToken}>令牌{cfg?.hasToken ? '已配置' : '未配置'}</Badge>
          <Badge ok={!!cfg?.hasPassphrase}>口令{cfg?.hasPassphrase ? '已配置' : '未配置'}</Badge>
          {cfg?.gistId && <Badge ok>已绑定 gist</Badge>}
        </div>

        <div className="space-y-2.5">
          <Field label="Gitee 令牌">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="ipt w-full"
              placeholder={cfg?.hasToken ? '已保存（留空则沿用）' : '私人令牌，需 gists 权限'}
              autoComplete="off"
            />
          </Field>
          <Field label="同步口令">
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="ipt w-full"
              placeholder={cfg?.hasPassphrase ? '已保存（留空则沿用）' : '用于加密同步内容，跨机需一致'}
              autoComplete="off"
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-dim2">
            令牌在 <span className="text-fg">gitee.com → 设置 → 私人令牌</span> 生成，勾选 <b>gists</b> 权限。
            同步内容整体经「同步口令」AES-256-GCM 加密后写入私有 gist，Gitee 仅存密文；跨机恢复需使用同一口令。
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button disabled={busy} onClick={() => void doSaveConfig()} className="rounded border border-line2 px-3 py-1.5 text-fg hover:bg-panel3 disabled:opacity-60">保存配置</button>
            <button disabled={busy} onClick={() => void doPush()} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent2 disabled:opacity-60">
              {cfg?.gistId ? '推送到云' : '初始化并推送'}
            </button>
            <button disabled={busy || !cfg?.gistId} onClick={() => void doPull()} className="rounded border border-line2 px-3 py-1.5 text-fg hover:bg-panel3 disabled:opacity-60">从云拉取</button>
          </div>

          {cfg?.gistId && (
            <div className="text-[11px] text-dim2">
              同步点 gist：<span className="font-mono text-dim">{cfg.gistId}</span>
              {cfg?.syncedAt && ` · 上次同步：${new Date(cfg.syncedAt).toLocaleString()}`}
            </div>
          )}
          {savedAt && <div className="text-[11px] text-ok">配置已保存（{savedAt}）</div>}
        </div>
      </div>

      {info && <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-ok">{info}</div>}
      {error && <ErrorBox message={error} />}

      {/* —— 本地备份 / 恢复 —— */}
      <div className="rounded-lg border border-line bg-panel p-4">
        <div className="mb-2 text-fg">本地备份与恢复</div>
        <div className="text-[11px] text-dim2">将连接配置导出为加密 profile 文件，或导入他人/他机的 profile（离线迁移用）。</div>
        <div className="mt-2 flex items-center gap-2">
          <button disabled={localBusy} onClick={() => void doExport()} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent2 disabled:opacity-60">导出</button>
          <button disabled={localBusy} onClick={() => void doImport()} className="rounded border border-line2 px-3 py-1.5 text-fg hover:bg-panel3 disabled:opacity-60">导入</button>
        </div>
        {localInfo && <div className="mt-2 rounded border border-ok/30 bg-ok/10 px-3 py-2 text-ok">{localInfo}</div>}
        {localErr && <ErrorBox message={localErr} />}
      </div>

      <p className="text-[11px] leading-relaxed text-dim2">
        凭据（口令/私钥/API Key）在本地经本机保险箱加密；云同步额外以「同步口令」整包加密，二者独立。
        请妥善保管同步口令——遗忘将无法解密云上配置。
      </p>
    </div>
  );
}

function Badge({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${ok ? 'bg-ok/15 text-ok' : 'bg-panel3 text-dim2'}`}>{children}</span>
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
