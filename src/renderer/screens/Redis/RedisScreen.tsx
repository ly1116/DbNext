import { useEffect, useState } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox, Loading } from '@renderer/components/common/States';
import { api } from '@renderer/api';
import { useConnections } from '@renderer/store/connectionStore';
import type { RedisEntry } from '@shared/types';

/**
 * ④ Redis 屏幕（真实实现）。
 *
 * 选一条已连接的 Redis，按前缀（默认 *）经 `api.redisKeys()` 拉取真实 key 列表，
 * 点 key 经 `api.redisGet()` 读取真实类型 / TTL / 值。
 *
 * @since 0.1.0
 */
export function RedisScreen() {
  const selectedId = useConnections((s) => s.selectedId);
  const [connId, setConnId] = useState<string | null>(null);
  const [pattern, setPattern] = useState('*');
  const [keys, setKeys] = useState<RedisEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RedisEntry | null>(null);
  const [value, setValue] = useState('');

  useEffect(() => { if (selectedId && !connId) setConnId(selectedId); }, [selectedId, connId]);

  const reload = async () => {
    if (!connId) return;
    setLoading(true); setError(null); setSelected(null);
    try {
      setKeys(await api.redisKeys(connId, pattern));
    } catch (e) {
      setError((e as Error).message); setKeys([]);
    } finally { setLoading(false); }
  };
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [connId]);

  const open = async (k: RedisEntry) => {
    if (!connId) return;
    setSelected(k); setValue('读取中…');
    try {
      const r = await api.redisGet(connId, k.key);
      setValue(r.value);
    } catch (e) {
      setValue(`读取失败：${(e as Error).message}`);
    }
  };

  const typeColor = (t: string) => ({ string: 'text-ok', hash: 'text-warn', list: 'text-ai2', set: 'text-ai', zset: 'text-purple' }[t] ?? 'text-fg');

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">Redis</span>
        <ConnectionPicker kind="redis" value={connId} onChange={setConnId} placeholder="选择 Redis…" />
        <span className="rounded bg-panel3 px-1.5 text-[10px] text-dim">db0</span>
        <button onClick={() => void reload()} className="ml-auto rounded border border-line2 px-2 py-1 text-dim hover:text-fg">刷新</button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-[320px] shrink-0 border-r border-line bg-panel">
          <div className="border-b border-line p-2">
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void reload()}
              placeholder="过滤 key（如 session:*）"
              className="h-6 w-full rounded border border-line bg-bg px-2 text-[11px] text-fg outline-none"
            />
          </div>
          {loading ? <div className="p-4"><Loading text="扫描 key…" /></div> : error ? <div className="p-4"><ErrorBox message={error} onRetry={reload} /></div> : (
            <div className="overflow-y-auto py-1 text-[12px] mono">
              {keys.map((k) => (
                <button key={k.key} onClick={() => void open(k)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${selected?.key === k.key ? 'bg-panel3' : 'hover:bg-panel3'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${typeColor(k.type).replace('text-', 'bg-')}`} />
                  <span className="truncate text-fg">{k.key}</span>
                  <span className="ml-auto text-[10px] text-dim2">{k.type}</span>
                </button>
              ))}
              {keys.length === 0 && <div className="px-3 py-4 text-[11px] text-dim2">无匹配 key</div>}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-3">
          {selected ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3 text-[12px]">
                <span className="font-medium text-fg">{selected.key}</span>
                <span className={`rounded bg-panel3 px-1.5 text-[10px] ${typeColor(selected.type)}`}>{selected.type}</span>
                <span className="text-dim">TTL: {selected.ttl === -1 ? '永久' : `${selected.ttl}s`}</span>
                {selected.size != null && <span className="text-dim">元素: {selected.size}</span>}
              </div>
              <pre className="flex-1 overflow-auto rounded border border-line bg-bg p-3 text-[12px] text-num mono">{value}</pre>
            </>
          ) : (
            <Empty text="选择左侧一个 key 查看真实类型 / TTL / 值。" />
          )}
        </div>
      </div>
    </div>
  );
}
