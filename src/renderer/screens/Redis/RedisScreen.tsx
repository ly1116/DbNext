import { useEffect, useState, type ReactNode } from 'react';
import { ConnectionPicker } from '@renderer/components/common/ConnectionPicker';
import { Empty, ErrorBox } from '@renderer/components/common/States';
import { JsonTree, isParseableJson } from '@renderer/components/common/JsonTree';
import { ConnIcon } from '@renderer/components/workbench/DbTree';
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
  // Java 序列化：format='java' 已反序列化；decodedVal 保存反序列化文本供「原始/反序列化」切换
  const [valFormat, setValFormat] = useState<string | null>(null);
  const [rawVal, setRawVal] = useState<string | null>(null);
  const [decodedVal, setDecodedVal] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  // 值展示模式：tree = JSON 折叠树视图（只读）；edit = 文本编辑。非 JSON 值自动落回 edit
  const [viewMode, setViewMode] = useState<'tree' | 'edit'>('tree');

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
      window.dispatchEvent(new CustomEvent('dataroost:redis-counts', { detail: { connId, info } }));
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
      setValFormat(r.format ?? null);
      setRawVal(r.raw ?? null);
      setDecodedVal(r.format === 'java' ? r.value : null);
      setShowRaw(false);
      setViewMode('tree');
      // 新值写入后重置格式化状态
      setFormatted(false);
    } catch (e) {
      setValue(`读取失败：${(e as Error).message}`);
    }
  };

  /** Java 序列化值：反序列化视图 ↔ 原始 HEX 切换 */
  const toggleRaw = () => {
    if (valFormat !== 'java' && valFormat !== 'java-raw') return;
    const next = !showRaw;
    setShowRaw(next);
    setValue(next ? (rawVal ?? '') : (decodedVal ?? ''));
    setViewMode(next ? 'edit' : 'tree');
  };

  /** 保存编辑后的值（按类型写回） */
  const saveValue = async () => {
    if (!connId || !selected) return;
    if (valFormat === 'java' && !window.confirm('该 key 是 Java 序列化数据。\n保存将以当前文本内容整体覆盖原值（不再进行序列化），确定继续？')) return;
    setSaving(true); setMsg(null);
    try {
      await api.redisSet(connId, selected.key, selected.type, value);
      setMsg('已保存');
      await reload();
      const r = await api.redisGet(connId, selected.key);
      setValue(r.value);
      setValFormat(r.format ?? null);
      setRawVal(r.raw ?? null);
      setDecodedVal(r.format === 'java' ? r.value : null);
      setShowRaw(false);
      setViewMode('tree');
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
      setValFormat(r.format ?? null);
      setRawVal(r.raw ?? null);
      setDecodedVal(r.format === 'java' ? r.value : null);
      setShowRaw(false);
      setViewMode('tree');
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

  /** 头部图标按钮（与表数据页工具条同款：h-7 图标钮，hover 浮起） */
  const IconBtn = ({ title, onClick, disabled, icon, spinning }: { title: string; onClick: () => void; disabled?: boolean; icon: ReactNode; spinning?: boolean }) => (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-panel3 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
    >
      <svg className={`h-3.5 w-3.5 ${spinning ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
    </button>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg">
      {/* 顶部工具条：身份 / 连接 / db 选择 / 刷新（对齐表数据页工具栏形态） */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <ConnIcon kind="redis" />
        <span className="shrink-0 text-[12px] font-semibold text-fg">Redis</span>
        {!connIdProp && <ConnectionPicker kind="redis" value={connId} onChange={setConnId} placeholder="选择 Redis…" />}
        <select
          value={currentDbIndex}
          onChange={(e) => setCurrentDbIndex(Number(e.target.value))}
          className="ipt h-6 w-auto shrink-0 py-0 text-[11px]"
          title="切换逻辑库"
        >
          {Array.from({ length: 16 }, (_, i) => (
            <option key={i} value={i}>
              db{i} {dbInfo?.[i] != null ? `(${dbInfo[i]})` : ''}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <IconBtn
            title="刷新 key 列表"
            onClick={() => void reload()}
            disabled={loading || !connId}
            spinning={loading}
            icon={<><path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v5h-5" /></>}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左侧：key 过滤 + 类型筛选 + key 列表 + 底部计数 */}
        <div className="flex w-[300px] shrink-0 flex-col border-r border-line bg-panel">
          <div className="shrink-0 border-b border-line p-2">
            <div className="relative">
              <svg className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-dim2" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void reload()}
                placeholder="过滤 key（如 session:*）"
                className="ipt h-7 w-full pl-6 pr-2 text-[11px]"
              />
            </div>
          </div>
          {/* 按类型过滤（值编辑 / 按类型） */}
          {types.length > 0 && (
            <div className="flex shrink-0 flex-wrap gap-1 border-b border-line px-2 py-1.5">
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
          <div className="min-h-0 flex-1 overflow-y-auto py-1 text-[12px] mono">
            {loading ? (
              <div className="px-3 py-4 text-[11px] text-dim2">扫描 key…</div>
            ) : error ? (
              <div className="p-3"><ErrorBox message={error} onRetry={reload} /></div>
            ) : (
              <>
                {filtered.map((k) => (
                  <button key={k.key} onClick={() => void open(k)} className={`tree-row flex w-full items-center gap-2 px-3 py-1.5 text-left ${selected?.key === k.key ? 'active' : ''}`}>
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${typeColor(k.type).replace('text-', 'bg-')}`} />
                    <span className="truncate text-fg">{k.key}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-dim2">{k.type}</span>
                  </button>
                ))}
                {filtered.length === 0 && <div className="px-3 py-4 text-[11px] text-dim2">无匹配 key</div>}
              </>
            )}
          </div>
          {/* 左侧底部计数条（对齐网格状态栏形态） */}
          <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel2 px-2 text-[10px] text-dim2">
            <span>共 <b className="font-semibold tabular-nums text-dim">{keys.length}</b> 个 key</span>
            {typeFilter !== 'all' && <span>筛选后 <b className="font-semibold tabular-nums text-dim">{filtered.length}</b></span>}
            <span className="ml-auto">db{currentDbIndex}</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-3">
          {selected ? (
            <>
              {/* 头部：key + 类型 / TTL / 元素 / Java 序列化徽标 */}
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12px]">
                <svg className="h-3.5 w-3.5 shrink-0 text-accent2" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                  <path d="M20.5 7.3 12 3 3.5 7.3v9.4L12 21l8.5-4.3V7.3Z" strokeLinejoin="round" />
                  <path d="M3.5 7.3 12 11.6l8.5-4.3M12 11.6V21" />
                </svg>
                <span className="min-w-0 truncate font-mono font-medium text-fg" title={selected.key}>{selected.key}</span>
                <span className={`shrink-0 rounded-full bg-panel3 px-2 text-[10px] leading-5 ${typeColor(selected.type)}`}>{selected.type}</span>
                <span className="shrink-0 rounded-full bg-panel3 px-2 text-[10px] leading-5 text-dim">
                  TTL {selected.ttl === -1 ? '永久' : `${selected.ttl}s`}
                </span>
                {selected.size != null && (
                  <span className="shrink-0 rounded-full bg-panel3 px-2 text-[10px] leading-5 text-dim">元素 {selected.size}</span>
                )}
                {(valFormat === 'java' || valFormat === 'java-raw') && (
                  <span className={`shrink-0 rounded-full bg-panel3 px-2 text-[10px] leading-5 ${valFormat === 'java' ? 'text-ok' : 'text-prod'}`}>
                    {valFormat === 'java' ? 'Java 序列化 · 已反序列化' : 'Java 序列化 · 解析失败'}
                  </span>
                )}
              </div>

              {/* 工具条：视图/编辑分段控件 + 操作 */}
              {(() => {
                const canTree = !showRaw && isParseableJson(value);
                const treeView = canTree && viewMode === 'tree';
                return (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <div className="flex overflow-hidden rounded-lg border border-line2/70">
                      <button
                        onClick={() => setViewMode('tree')}
                        disabled={!canTree}
                        title={!canTree ? '值不是合法 JSON，无树视图' : 'JSON 树视图'}
                        className={`px-2.5 py-1 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${treeView ? 'bg-accent2/15 text-accent2' : 'text-dim hover:bg-panel3'}`}
                      >
                        视图
                      </button>
                      <button
                        onClick={() => setViewMode('edit')}
                        className={`border-l border-line2/70 px-2.5 py-1 text-[10px] transition-colors ${!treeView ? 'bg-accent2/15 text-accent2' : 'text-dim hover:bg-panel3'}`}
                      >
                        编辑
                      </button>
                    </div>
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      <button
                        onClick={() => { void navigator.clipboard?.writeText(value).then(() => setMsg('已复制到剪贴板')).catch(() => setMsg('复制失败')); }}
                        className="btn"
                      >
                        复制
                      </button>
                      {(valFormat === 'java' || valFormat === 'java-raw') && (
                        <button onClick={toggleRaw} className="btn" title="在反序列化视图与原始 HEX 间切换">
                          {showRaw ? '反序列化' : '原始'}
                        </button>
                      )}
                      {!treeView && (
                        <button onClick={toggleFormat} className="btn" title="格式化 JSON">
                          {formatted ? '折叠' : '格式化'}
                        </button>
                      )}
                      <button onClick={() => void saveValue()} disabled={saving} className="btn-primary">保存</button>
                      <button onClick={() => void doRename()} className="btn">重命名</button>
                      <button onClick={() => void doExpire()} className="btn">TTL</button>
                      <button onClick={() => void doDelete()} className="btn">删除</button>
                    </div>
                  </div>
                );
              })()}

              {/* 值主体：JSON 树视图（只读）/ 文本编辑 */}
              {(() => {
                const treeView = !showRaw && isParseableJson(value) && viewMode === 'tree';
                return treeView ? (
                  <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-bg p-3">
                    <JsonTree text={value} />
                  </div>
                ) : (
                  <textarea
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    spellCheck={false}
                    className="min-h-0 flex-1 resize-none rounded-lg border border-line bg-bg p-3 text-[12px] text-num mono outline-none transition-colors focus:border-accent2 focus:ring-2 focus:ring-accent2/25"
                  />
                );
              })()}

              {selected.type !== 'string' && (
                <div className="mt-1 text-[10px] text-dim2">
                  结构化类型按 JSON 编辑后保存：hash=对象；list/set=数组；zset=[成员, 分数, …]（与上方显示格式一致）。
                </div>
              )}
              {msg && <div className={`mt-1 text-[10px] ${msg.startsWith('保存失败') || msg.startsWith('重命名失败') || msg.startsWith('设置失败') || msg.startsWith('删除失败') ? 'text-prod' : 'text-ok'}`}>{msg}</div>}
            </>
          ) : (
            <Empty text="从左侧选择一个 key，查看 / 编辑其值、TTL 与类型信息。" />
          )}
        </div>
      </div>
    </div>
  );
}
