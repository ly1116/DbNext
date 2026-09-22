import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox, Loading } from '@renderer/components/common/States';
import type { FileNode } from '@shared/types';

/**
 * SFTP 全屏文件管理器（真实实现）。
 *
 * 双栏：左侧真实本地文件系统（`api.localList`），右侧真实远端 SFTP（`api.listDir`，需选一台已连 SSH 主机）。
 * 支持进入目录、刷新，以及真实的「上传 / 下载」（走 sftp，带进度）。
 * 由连接树右键 / SFTP 面板按钮以弹层打开，可预选连接。
 *
 * @since 0.1.0
 */
interface LocalNode { name: string; path: string; isDir: boolean; size: number; modifiedAt: string }

const fmtSize = (n: number) => (!n ? '0B' : n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1024 / 1024).toFixed(1)}M`);

export function SftpFullscreenScreen({ initialConnectionId }: { initialConnectionId?: string }) {
  const [connId, setConnId] = useState<string | null>(initialConnectionId ?? null);
  const [localDir, setLocalDir] = useState('C:\\');
  const [remoteDir, setRemoteDir] = useState('/');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickLocalDir = async () => {
    const p = await api.openDialog({ kind: 'folder', title: '选择本地目录' });
    if (p) setLocalDir(p);
  };
  const pickRemoteDir = async () => {
    const p = await api.openDialog({ kind: 'folder', title: '选择远端目录（需手工输入）' });
    if (p) setRemoteDir(p);
  };

  const upload = async (local: LocalNode) => {
    if (!connId) { setError('请先选择并连上一台 SSH 主机'); return; }
    setBusy('upload'); setError(null);
    try {
      const remotePath = `${remoteDir.replace(/\/$/, '')}/${local.name}`;
      await api.upload(connId, local.path, remotePath);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const download = async (remote: FileNode) => {
    if (!connId) { setError('请先选择并连上一台 SSH 主机'); return; }
    const save = await api.openDialog({ kind: 'save', title: '下载另存为', defaultPath: remote.name });
    if (!save) return;
    setBusy('download'); setError(null);
    try {
      await api.download(connId, remote.path, save);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-line2 bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">SFTP 文件管理器</span>
        <ConnectionPicker kind={['ssh', 'bastion']} value={connId} onChange={setConnId} placeholder="选择 SSH 主机…" />
        <div className="ml-auto flex gap-2">
          <button disabled={busy === 'upload'} onClick={() => void pickLocalDir()} className="rounded border border-line2 px-2.5 py-1 text-dim hover:text-fg">选择本地目录</button>
          <button disabled={busy === 'download'} onClick={() => void pickRemoteDir()} className="rounded border border-line2 px-2.5 py-1 text-dim hover:text-fg">选择远端目录</button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="flex min-h-0 flex-1">
        <LocalPane dir={localDir} onNavigate={setLocalDir} onUpload={upload} />
        {connId ? (
          <RemotePane connId={connId} dir={remoteDir} onNavigate={setRemoteDir} onDownload={download} />
        ) : (
          <div className="flex flex-1 flex-col border-l border-line bg-panel">
            <Empty text="选择一台已连接的 SSH / 堡垒机主机，即可在右侧浏览真实远端文件系统。" />
          </div>
        )}
      </div>
    </div>
  );
}

function LocalPane({ dir, onNavigate, onUpload }: { dir: string; onNavigate: (p: string) => void; onUpload: (n: LocalNode) => void }) {
  const [nodes, setNodes] = useState<LocalNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.localList(dir)
      .then((l) => alive && setNodes(l))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dir]);

  return (
    <div className="flex min-w-0 flex-1 flex-col border-r border-line bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-3 text-[11px]">
        <span className="font-medium text-fg">本地</span>
        <span className="mono truncate text-dim2">{dir}</span>
        <span className="ml-auto text-[10px] text-dim2">{nodes.length} 项</span>
      </div>
      {loading && <Loading text="读取本地目录…" />}
      {error && <ErrorBox message={error} />}
      <div className="flex-1 overflow-y-auto py-1 text-[12px] mono">
        {!loading && !error && nodes.map((n) => (
          <div key={n.path} className="flex items-center gap-2 px-3 py-1 hover:bg-panel3">
            <button className="flex flex-1 items-center gap-2 text-left" onClick={() => n.isDir && onNavigate(n.path)}>
              <span className={n.isDir ? 'text-warn' : 'text-ok'}>{n.isDir ? '📁' : '📄'}</span>
              <span className={n.isDir ? 'text-warn' : 'text-fg'}>{n.name}</span>
              {!n.isDir && <span className="ml-auto text-[10px] text-dim2">{fmtSize(n.size)}</span>}
            </button>
            {!n.isDir && <button className="rounded border border-line2 px-1.5 text-[10px] text-accent2 hover:bg-accent/10" onClick={() => void onUpload(n)}>↑</button>}
          </div>
        ))}
        {!loading && !error && nodes.length === 0 && <div className="px-3 py-4 text-[11px] text-dim2">空目录</div>}
      </div>
    </div>
  );
}

function RemotePane({ connId, dir, onNavigate, onDownload }: { connId: string; dir: string; onNavigate: (p: string) => void; onDownload: (n: FileNode) => void }) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.listDir(connId, dir)
      .then((l) => alive && setNodes(l))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [connId, dir]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel2 px-3 text-[11px]">
        <span className="font-medium text-fg">远端</span>
        <span className="mono truncate text-dim2">{dir}</span>
        <span className="ml-auto text-[10px] text-dim2">{nodes.length} 项</span>
      </div>
      {loading && <Loading text="读取远端目录…" />}
      {error && <ErrorBox message={error} onRetry={() => onNavigate(dir)} />}
      <div className="flex-1 overflow-y-auto py-1 text-[12px] mono">
        {!loading && !error && nodes.map((n) => (
          <div key={n.path} className="flex items-center gap-2 px-3 py-1 hover:bg-panel3">
            <button className="flex flex-1 items-center gap-2 text-left" onClick={() => n.type === 'dir' && onNavigate(n.path)}>
              <span className={n.type === 'dir' ? 'text-warn' : 'text-ok'}>{n.type === 'dir' ? '📁' : '📄'}</span>
              <span className={n.type === 'dir' ? 'text-warn' : 'text-fg'}>{n.name}</span>
              {n.type === 'file' && <span className="ml-auto text-[10px] text-dim2">{fmtSize(n.size)}</span>}
            </button>
            {n.type === 'file' && <button className="rounded border border-line2 px-1.5 text-[10px] text-ok hover:bg-ok/10" onClick={() => void onDownload(n)}>↓</button>}
          </div>
        ))}
        {!loading && !error && nodes.length === 0 && <div className="px-3 py-4 text-[11px] text-dim2">空目录</div>}
      </div>
    </div>
  );
}
