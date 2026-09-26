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
export function RedisScreen({ connId: connIdProp, dbIndex: dbIndexProp }: { connId?: string; dbIndex?: number }) {
  const selectedId = useConnections((s) => s.selectedId);
  const [connId, setConnId] = useState<string | null>(connIdProp ?? null);
  const [currentDbIndex, setCurrentDbIndex] = useState<number>(dbIndexProp ?? 0);
  const [pattern, setPattern] = useState('*');
  const [keys, setKeys] = useState<RedisEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RedisEntry | null>(null);
  const [value, setValue] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 各 db 的 key 数量统计
  const [dbInfo, setDbInfo] = useState<Record<number, number> | null>(null);
  // 值编辑器的格式化状态（默认 false，即原始文本）
  const [formatted, setFormatted] = useState(false);

  // 作为标签页打开时由父级直接注入连接；独立屏时回退到当前选中连接
  useEffect(() => { if (connIdProp) setConnId(connIdProp); }, [connIdProp]);
  useEffect(() => { if (!connIdProp && selectedId && !connId) setConnId(selectedId); }, [selectedId, connId, connIdProp]);
  useEffect(() => { if (dbIndexProp !== undefined) setCurrentDbIndex(dbIndexProp); }, [dbIndexProp]);

  // 加载各 db 的 key 数量统计（同时广播给左侧树，保持 db 节点上的计数同步）
  const loadDbInfo = async () => {
    if (!connId) return;
    try {
      const info = await api.redisDbInfo(connId);
      setDbInfo(info);
      window.dispatchEvent(new CustomEvent('dbnest:redis-counts', { detail: { connId, info } }));
    } catch { /* ignore */ }
  };

  const reload = async () => {
    if (!connId) return;
    setLoading(true); setError(null); setSelected(null); setMsg(null);
    try {
      await api.redisSelectDb(connId, currentDbIndex);
      setKeys(await api.redisKeys(connId, pattern));
    } catch (e) {
      setError((e as Error).message); setKeys([]);
    } finally { setLoading(false); }
  };

  // 连接或 db 切换时重新加载统计和 keys
  useEffect(() => {
    if (!connId) return;
    const timer = setTimeout(() => {
      void loadDbInfo();
      void reload();
    }, 100);
    return () => clearTimeout(timer);
    /* eslint-disable-next-line */
  }, [connId, currentDbIndex]);

  const open = async (k: RedisEntry) => {
    if (!connId) return;
    setSelected(k); setValue('读取中…'); setMsg(null);
    try {
      const r = await api.redisGet(connId, k.key);
      setValue(r.value);
      // 新值写入后重置格式化状态
      setFormatted(false);
    } catch (e) {
      setValue(`读取失败：${(e as Error).message}`);
    }
  };

  /** 保存编辑后的值（按类型写回） */
  const saveValue = async () => {
    if (!connId || !selected) return;
    setSaving(true); setMsg(null);
    try {
      await api.redisSet(connId, selected.key, selected.type, value);
      setMsg('已保存');
      await reload();
      const r = await api.redisGet(connId, selected.key);
      setValue(r.value);
      setFormatted(false);
    } catch (e) {
      setMsg(`保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const doRename = async () => {
    if (!connId || !selected) return;
    const nk = window.prompt('重命名 key 为：', selected.key);
    if (!nk || nk === selected.key) return;
    try {
      await api.redisRename(connId, selected.key, nk);
      setMsg('已重命名');
      const r = await api.redisGet(connId, nk);
      setSelected({ ...selected, key: nk });
      setValue(r.value);
      setFormatted(false);
      await reload();
    } catch (e) {
      setMsg(`重命名失败：${(e as Error).message}`);
    }
  };

  const doExpire = async () => {
    if (!connId || !selected) return;
    const input = window.prompt('设置 TTL（秒；-1 表示永久）：', String(selected.ttl ?? -1));
    if (input === null) return;
    const ttl = Number(input);
    if (!Number.isFinite(ttl)) { setMsg('TTL 须为数字'); return; }
    try {
      await api.redisExpire(connId, selected.key, ttl);
      setMsg(`TTL 已设为 ${ttl < 0 ? '永久' : `${ttl}s`}`);
      await reload();
    } catch (e) {
      setMsg(`设置失败：${(e as Error).message}`);
    }
  };

  const doDelete = async () => {
    if (!connId || !selected) return;
    if (!window.confirm(`确认删除 key：${selected.key}？`)) return;
    try {
      await api.redisDel(connId, selected.key);
      setMsg('已删除');
      setSelected(null);
      await reload();
    } catch (e) {
      setMsg(`删除失败：${(e as Error).message}`);
    }
  };

  // JSON 格式化
  const formatJson = (text: string): string => {
    try {
      const obj = JSON.parse(text);
      return JSON.stringify(obj, null, 2);
    } catch {
      return text; // 非 JSON 原样返回
    }
  };

  // JSON 折叠（压缩为一行）
  const compactJson = (text: string): string => {
    try {
      const obj = JSON.parse(text);
      return JSON.stringify(obj);
    } catch {
      return text;
    }
  };

  const toggleFormat = () => {
    if (!value) return;
    try {
      JSON.parse(value);
      // 当前是格式化状态 → 折叠；当前未格式化 → 格式化
      setFormatted((prev) => {
        const next = !prev;
        setValue(next ? formatJson(value) : compactJson(value));
        return next;
      });
    } catch {
      setMsg('当前值不是合法 JSON，无法格式化');
    }
  };

  const typeColor = (t: string) => ({ string: 'text-ok', hash: 'text-warn', list: 'text-ai2', set: 'text-ai', zset: 'text-purple' }[t] ?? 'text-fg');
  const types = Array.from(new Set(keys.map((k) => k.type))).sort();
  const counts = (t: string) => keys.filter((k) => k.type === t).length;
  const filtered = typeFilter === 'all' ? keys : keys.filter((k) => k.type === typeFilter);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel2 px-3 text-[12px]">
        <span className="font-medium">Redis</span>
        {!connIdProp && <ConnectionPicker kind="redis" value={connId} onChange={setConnId} placeholder="选择 Redis…" />}
        <select
          value={currentDbIndex}
          onChange={(e) => setCurrentDbIndex(Number(e.target.value))}
          className="rounded border border-line bg-bg px-1.5 text-[10px] text-fg outline-none"
        >
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i} value={i}>
              db{i} {dbInfo?.[i] != null ? `(${dbInfo[i]})` : ''}
            </option>
          ))}
        </select>
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
          {/* 按类型过滤（值编辑 / 按类型） */}
          {types.length > 0 && (
            <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1.5">
              <button
                onClick={() => setTypeFilter('all')}
                className={`rounded px-1.5 py-0.5 text-[10px] ${typeFilter === 'all' ? 'bg-accent text-white' : 'border border-line text-dim hover:bg-panel3'}`}
              >
                全部 {keys.length}
              </button>
              {types.map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  className={`rounded px-1.5 py-0.5 text-[10px] ${typeFilter === t ? 'bg-accent text-white' : 'border border-line text-dim hover:bg-panel3'}`}
                >
                  {t} {counts(t)}
                </button>
              ))}
            </div>
          )}
          {loading ? <div className="p-4"><Loading text="扫描 key…" /></div> : error ? <div className="p-4"><ErrorBox message={error} onRetry={reload} /></div> : (
            <div className="overflow-y-auto py-1 text-[12px] mono">
              {filtered.map((k) => (
                <button key={k.key} onClick={() => void open(k)} className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${selected?.key === k.key ? 'bg-panel3' : 'hover:bg-panel3'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${typeColor(k.type).replace('text-', 'bg-')}`} />
                  <span className="truncate text-fg">{k.key}</span>
                  <span className="ml-auto text-[10px] text-dim2">{k.type}</span>
                </button>
              ))}
              {filtered.length === 0 && <div className="px-3 py-4 text-[11px] text-dim2">无匹配 key</div>}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-3">
          {selected ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-medium text-fg">{selected.key}</span>
                <span className={`rounded bg-panel3 px-1.5 text-[10px] ${typeColor(selected.type)}`}>{selected.type}</span>
                <span className="text-dim">TTL: {selected.ttl === -1 ? '永久' : `${selected.ttl}s`}</span>
                {selected.size != null && <span className="text-dim">元素: {selected.size}</span>}
                <div className="ml-auto flex gap-1.5">
                  <button onClick={toggleFormat} className="rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3" title="格式化 JSON">
                    {formatted ? '折叠' : '格式化'}
                  </button>
                  <button onClick={() => void saveValue()} disabled={saving} className="rounded bg-accent px-2 py-0.5 text-[10px] text-white hover:opacity-90 disabled:opacity-40">保存</button>
                  <button onClick={() => void doRename()} className="rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3">重命名</button>
                  <button onClick={() => void doExpire()} className="rounded border border-line px-2 py-0.5 text-[10px] text-dim hover:bg-panel3">TTL</button>
                  <button onClick={() => void doDelete()} className="rounded border border-line px-2 py-0.5 text-[10px] text-prod hover:bg-panel3">删除</button>
                </div>
              </div>
              <textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded border border-line bg-bg p-3 text-[12px] text-num mono outline-none"
              />
              {selected.type !== 'string' && (
                <div className="mt-1 text-[10px] text-dim2">
                  结构化类型按 JSON 编辑后保存：hash=对象；list/set=数组；zset=[成员, 分数, …]（与上方显示格式一致）。
                </div>
              )}
              {msg && <div className={`mt-1 text-[10px] ${msg.startsWith('保存失败') || msg.startsWith('重命名失败') || msg.startsWith('设置失败') || msg.startsWith('删除失败') ? 'text-prod' : 'text-ok'}`}>{msg}</div>}
            </>
          ) : (
            <Empty text="选择左侧一个 key 查看 / 编辑真实类型 / TTL / 值。" />
          )}
        </div>
      </div>
    </div>
  );
}
