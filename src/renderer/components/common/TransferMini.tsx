import { useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { TransferProgress, TransferTask } from '@shared/types';

/**
 * 传输队列迷你面板（真实进度 · 上传/下载共用）。
 *
 * 订阅 `api.onTransferProgress` 实时显示：文件名、进度条、百分比、
 * 已传/总大小、实时速度（按分片回调采样差值计算，EMA 平滑）。
 * 可嵌入 SFTP 侧栏与全屏文件管理器底部。
 *
 * @since 0.1.0
 */

/** 速度采样：上次回调的字节与时间戳 */
interface Sample { bytes: number; ts: number; speed: number }

export function TransferMini() {
  const [tasks, setTasks] = useState<Record<string, TransferTask>>({});
  /** 每个任务的速度采样（ref 避免频繁重渲染） */
  const samples = useRef<Record<string, Sample>>({});
  /** 展示用速度（每任务） */
  const [speeds, setSpeeds] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    api.listTransfers().then((list) => alive && setTasks(Object.fromEntries(list.map((t) => [t.id, t])))).catch(() => undefined);
    const off = api.onTransferProgress((p: TransferProgress) => {
      if (!alive) return;
      setTasks((prev) => ({
        ...prev,
        [p.id]: { ...(prev[p.id] ?? { id: p.id, remotePath: '', localPath: '', direction: 'upload', total: 0, transferred: 0, status: p.status }), ...p },
      }));
      // 速度：差值 / 时间差，EMA 平滑（alpha=0.3），完成时清零
      const now = Date.now();
      const last = samples.current[p.id];
      if (p.status === 'done' || p.status === 'error') {
        delete samples.current[p.id];
        setSpeeds((s) => ({ ...s, [p.id]: 0 }));
        return;
      }
      if (last && now > last.ts) {
        const inst = Math.max(0, (p.transferred - last.bytes) / ((now - last.ts) / 1000));
        const speed = last.speed ? last.speed * 0.7 + inst * 0.3 : inst;
        samples.current[p.id] = { bytes: p.transferred, ts: now, speed };
        setSpeeds((s) => ({ ...s, [p.id]: speed }));
      } else {
        samples.current[p.id] = { bytes: p.transferred, ts: now, speed: last?.speed ?? 0 };
      }
    });
    return () => { alive = false; off(); };
  }, []);

  const list = Object.values(tasks);
  const active = list.filter((t) => t.status === 'active');
  const failed = list.filter((t) => t.status === 'error');
  const done = list.filter((t) => t.status === 'done').length;
  const cur = active[0];

  return (
    <div className="shrink-0 border-t border-line">
      <div className="flex h-7 items-center gap-2 bg-panel2 px-2 text-[10px]">
        <span className="text-dim2">传输</span>
        {active.length > 0 && <span className="rounded bg-accent/20 px-1 text-accent2">{active.length} 进行</span>}
        <span className="rounded bg-ok/15 px-1 text-ok">{done} 完成</span>
        {failed.length > 0 && <span className="rounded bg-prod/15 px-1 text-prod">{failed.length} 失败</span>}
      </div>
      {cur && (
        <div className="space-y-1 border-t border-line px-2 py-1.5">
          <div className="flex items-center gap-2 text-[10px] mono">
            <svg className="h-3 w-3 shrink-0 text-accent2" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path d={cur.direction === 'upload' ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M19 12l-7 7-7-7'} />
            </svg>
            <span className="flex-1 truncate text-fg" title={cur.direction === 'upload' ? cur.localPath : cur.remotePath}>
              {(cur.direction === 'upload' ? cur.localPath : cur.remotePath).split(/[\\/]/).pop()}
            </span>
            <span className="text-dim2">{formatSize(cur.transferred)}/{formatSize(cur.total)}</span>
            <span className="w-8 text-right text-accent2">{pctOf(cur)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-panel3">
            <div className="h-full bg-accent2 transition-[width] duration-150" style={{ width: `${pctOf(cur)}%` }} />
          </div>
          <div className="flex items-center justify-between text-[10px] text-dim2 mono">
            <span>{cur.direction === 'upload' ? '上传' : '下载'}</span>
            <span>{speeds[cur.id] ? `${formatSize(speeds[cur.id])}/s` : '--'}</span>
          </div>
        </div>
      )}
      {failed.slice(-2).map((t) => (
        <div key={t.id} className="border-t border-line px-2 py-1 text-[10px] text-prod mono" title={t.error}>
          失败：{(t.localPath || t.remotePath).split(/[\\/]/).pop()}{t.error ? ` · ${t.error}` : ''}
        </div>
      ))}
    </div>
  );
}

function pctOf(t: TransferTask): number {
  return t.total ? Math.min(100, Math.round((t.transferred / t.total) * 100)) : 0;
}

function formatSize(n: number): string {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}G`;
}
