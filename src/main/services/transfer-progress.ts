/**
 * 目录传输的聚合进度器：多个并发传输各自回报 step，
 * 汇总为「已完成字节 + 各在途字节」，并通过微任务合帧减少 IPC 推送频率。
 *
 * @since 0.1.0
 */

export interface AggregateProgress {
  /** 第 i 号传输开始（占位 0 字节） */
  begin(i: number): void;
  /** 第 i 号传输已传 transferred 字节 */
  step(i: number, transferred: number): void;
  /** 第 i 号传输完成（累计 size 字节，移出在途表） */
  finish(i: number, size: number): void;
}

/** @param total 全部文件总字节 @param onProgress 聚合回调（合帧，每微任务一轮至多一次） */
export function createAggregateProgress(
  total: number,
  onProgress: (transferred: number, total: number) => void,
): AggregateProgress {
  let completed = 0;
  const inflight = new Map<number, number>();
  let pending = false;
  const report = (): void => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      let t = completed;
      for (const v of inflight.values()) t += v;
      onProgress(Math.min(t, total), total);
    });
  };
  return {
    begin(i: number): void {
      inflight.set(i, 0);
      report();
    },
    step(i: number, transferred: number): void {
      inflight.set(i, transferred);
      report();
    },
    finish(i: number, size: number): void {
      inflight.delete(i);
      completed += size;
      report();
    },
  };
}
