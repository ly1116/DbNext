import { useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import type { TransferProgress, TransferTask } from '@shared/types';
import { Icon } from '@renderer/components/common/icons';

/**
 * 传输队列迷你面板（真实进度 · 上传/下载共用）。
 *
 * 订阅 `api.onTransferProgress` 实时显示**所有进行中任务**的列表：
 * 文件名、进度条、百分比、已传/总大小、实时速度（按分片回调采样差值计算，EMA 平滑）。
 * 完成的条目 8 秒后自动移除（徽标计数保留），失败条目常驻提示。
 * 可嵌入 SFTP 侧栏与全屏文件管理器底部。
 *
 * @since 0.1.0
 */

/** 速度采样：上次回调的字节与时间戳 */
interface Sample { bytes: number; ts: number; speed: number }

/** 完成条目保留时长（ms），超过后从列表移除（徽标计数不受影响） */
const DONE_TTL = 8000;

export function TransferMini() {
  const [tasks, setTasks] = useState<Record<string, TransferTask>>({});
  /** 每个任务的速度采样（ref 避免频繁重渲染） */
  const samples = useRef<Record<string, Sample>>({});
  /** 展示用速度（每任务） */
  const [speeds, setSpeeds] = useState<Record<string, number>>({});
  /** 累计完成/失败数（条目被清除后徽标数不丢） */
  const [doneCount, setDoneCount] = useState(0);
  const [failCount, setFailCount] = useState(0);

  useEffect(() => {
    let alive = true;
    /** 完成条目超时清除 */
    const pruneLater = (id: string) => {
      setTimeout(() => {
        if (!alive) return;
        setTasks((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, DONE_TTL);
    };
    api.listTransfers().then((list) => {
      if (!alive) return;
      setTasks(Object.fromEntries(list.map((t) => [t.id, t])));
      // 历史已完成/失败任务折算进累计徽标
      setDoneCount(list.filter((t) => t.status === 'done').length);
      setFailCount(list.filter((t) => t.status === 'error').length);
      for (const t of list) if (t.status === 'done') pruneLater(t.id);
    }).catch(() => undefined);
    const off = api.onTransferProgress((p: TransferProgress) => {
      if (!alive) return;
      setTasks((prev) => ({
        ...prev,
        [p.id]: { ...(prev[p.id] ?? { id: p.id, remotePath: '', localPath: '', direction: 'upload', total: 0, transferred: 0, status: p.status }), ...p },
      }));
      if (p.status === 'done') { setDoneCount((c) => c + 1); pruneLater(p.id); }
      if (p.status === 'error') setFailCount((c) => c + 1);
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

  return (
    <div className="shrink-0 border-t border-border">
      <div className="flex h-7 items-center gap-2 bg-muted px-2 text-[10px]">
        <span className="text-muted-foreground">传输</span>
        {active.length > 0 && <span className="rounded bg-primary/20 px-1 text-primary">{active.length} 进行</span>}
        <span className="rounded bg-success/15 px-1 text-success">{doneCount} 完成</span>
        {failCount > 0 && <span className="rounded bg-destructive/15 px-1 text-destructive">{failCount} 失败</span>}
      </div>
      {active.length > 0 && (
        <div className="max-h-44 overflow-y-auto border-t border-border">
          {active.map((t) => (
            <div key={t.id} className="space-y-1 px-2 py-1.5">
              <div className="flex items-center gap-2 text-[10px] mono">
                <Icon name={t.direction === 'upload' ? 'upload' : 'download'} className="h-3 w-3 shrink-0 text-primary" strokeWidth={1.8} />
                <span className="flex-1 truncate text-foreground" title={t.direction === 'upload' ? t.localPath : t.remotePath}>
                  {(t.direction === 'upload' ? t.localPath : t.remotePath).split(/[\\/]/).pop()}
                </span>
                <span className="text-muted-foreground">{formatSize(t.transferred)}/{formatSize(t.total)}</span>
                <span className="w-8 text-right text-primary">{pctOf(t)}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary transition-[width] duration-150" style={{ width: `${pctOf(t)}%` }} />
              </div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mono">
                <span>{t.direction === 'upload' ? '上传' : '下载'}</span>
                <span>{speeds[t.id] ? `${formatSize(speeds[t.id])}/s` : '--'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {failed.slice(-3).map((t) => (
        <div key={t.id} className="border-t border-border px-2 py-1 text-[10px] text-destructive mono" title={t.error}>
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
