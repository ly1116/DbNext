import { useEffect, useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox } from '@renderer/components/common/States';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { TransferProgress, TransferTask } from '@shared/types';

/**
 * 文件传输（真实实现）。
 *
 * 选一台已连接的 SSH 主机，选择本地文件 + 填写远端路径，经 `api.upload / download`
 * 走真实 sftp 传输；进度经 `api.onTransferProgress` 实时显示。
 * 不再作为常驻屏幕——由连接树右键「传输文件…」以弹层打开，可预选连接。
 *
 * @since 0.1.0
 */
export function TransferScreen({ initialConnectionId }: { initialConnectionId?: string }) {
  const selectedId = useConnections((s) => s.selectedId);
  const [connId, setConnId] = useState<string | null>(initialConnectionId ?? null);
  const [localPath, setLocalPath] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [tasks, setTasks] = useState<Record<string, TransferTask>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (selectedId && !connId) setConnId(selectedId); }, [selectedId, connId]);

  useEffect(() => {
    let alive = true;
    api.listTransfers().then((l) => alive && setTasks(Object.fromEntries(l.map((t) => [t.id, t])))).catch(() => undefined);
    const off = api.onTransferProgress((p: TransferProgress) => {
      if (!alive) return;
      setTasks((prev) => ({
        ...prev,
        [p.id]: { ...(prev[p.id] ?? { id: p.id, remotePath, localPath, direction: 'upload', total: 0, transferred: 0, status: p.status }), ...p },
      }));
    });
    return () => { alive = false; off(); };
  }, []);

  const pickLocal = async () => {
    const p = await api.openDialog({ kind: 'file', title: '选择要上传的本地文件' });
    if (p) { setLocalPath(p); setRemotePath((r) => r || `/${p.split(/[\\/]/).pop()}`); }
  };

  const upload = async () => {
    if (!connId || !localPath || !remotePath) { setError('请选择本地文件并填写远端路径'); return; }
    setError(null);
    try { await api.upload(connId, localPath, remotePath); } catch (e) { setError((e as Error).message); }
  };
  const download = async () => {
    if (!connId || !remotePath || !localPath) { setError('请填写远端路径并选择本地保存位置'); return; }
    setError(null);
    try { await api.download(connId, remotePath, localPath); } catch (e) { setError((e as Error).message); }
  };

  const list = Object.values(tasks);
  const pct = (t: TransferTask) => (t.total ? Math.round((t.transferred / t.total) * 100) : 0);

  return (
    <div className="mx-auto flex h-full w-full max-w-[1100px] flex-col overflow-hidden rounded-xl border border-line2 bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">文件传输</span>
        <ConnectionPicker kind={['ssh', 'bastion']} value={connId} onChange={setConnId} placeholder="选择 SSH 主机…" />
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 text-[12px]">
        {!connId ? (
          <Empty text="请选择一台已连接的 SSH / 堡垒机主机再进行传输。" />
        ) : (
          <div className="space-y-3">
            <Row label="本地文件">
              <button onClick={() => void pickLocal()} className="rounded border border-line2 px-2 py-1 text-dim hover:text-fg">选择…</button>
              <span className="ml-2 break-all text-fg">{localPath || '（未选择）'}</span>
            </Row>
            <Row label="远端路径">
              <input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/var/www/upload.tar.gz" className="ipt flex-1" />
            </Row>
            <div className="flex gap-2">
              <button onClick={() => void upload()} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent2">↑ 上传</button>
              <button onClick={() => void download()} className="rounded bg-ok px-3 py-1.5 font-medium text-black hover:opacity-90">↓ 下载</button>
            </div>

            {error && <ErrorBox message={error} />}

            <div className="mt-2">
              <div className="mb-1 text-[11px] uppercase tracking-wider text-dim">传输任务</div>
              {list.length === 0 && <div className="text-[11px] text-dim2">暂无任务</div>}
              {list.map((t) => (
                <div key={t.id} className="mb-2 rounded border border-line bg-panel p-2">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-panel3 px-1.5 text-[10px]">{t.direction === 'upload' ? '上传' : '下载'}</span>
                    <span className="truncate text-fg">{t.remotePath.split('/').pop() || t.remotePath}</span>
                    <span className="ml-auto text-[10px] text-dim2">{t.status}</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-panel3">
                    <div className="h-full bg-accent2" style={{ width: `${pct(t)}%` }} />
                  </div>
                  {t.error && <div className="mt-1 text-[10px] text-prod">{t.error}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-dim">{label}</span>
      <div className="flex flex-1 items-center gap-2">{children}</div>
    </div>
  );
}
