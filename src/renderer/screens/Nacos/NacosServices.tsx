import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { Loading, ErrorBox, Empty, InlineError } from '@renderer/components/common/States';
import { Button } from '@renderer/components/ui/button';
import { Icon } from '@renderer/components/common/icons';
import { Splitter, useSplitter } from './nacosShared';
import type { NacosInstanceInfo, NacosServiceDetail, NacosServiceItem, NacosServicePage } from '@shared/types';

/**
 * 服务发现浏览器（「服务」页签，一比一对齐参考实现）：
 * - 左：搜索行（服务名 / 全部分组 / + 服务 / 加载）+ 服务卡片列表（GROUP · 全部健康 x/y · 集群 N）+ 底栏翻页；
 * - 右：服务头（名称 + `GROUP · N 个已加载实例` + 刷新）+ 操作行（筛选实例群 | 服务设置·编辑·删除 | 实例·注册实例）+
 *   服务详情（实例/健康/集群/保护阈值）+ 实例卡片（ip:port · 健康 · 上线 · 临时实例 · 权重 · 元数据折叠 · 操作按钮）。
 * 实例写操作（编辑/下线/注销等）当前为占位。
 */
export function NacosServices({ connectionId, tenant, collapsed, showToast }: {
  connectionId: string;
  tenant: string;
  collapsed: boolean;
  showToast: (text: string, ok?: boolean) => void;
}) {
  const { splitRef, leftPct, onSplitDown, setLeftPct } = useSplitter(42);
  const [nameFilter, setNameFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [pageSize] = useState(20);
  const [list, setList] = useState<NacosServicePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<NacosServiceItem | null>(null);
  const [detail, setDetail] = useState<NacosServiceDetail | null>(null);
  const [instances, setInstances] = useState<NacosInstanceInfo[]>([]);
  const [instLoading, setInstLoading] = useState(false);
  const [instError, setInstError] = useState<string | null>(null);
  const [clusterFilter, setClusterFilter] = useState('');
  const [appliedCluster, setAppliedCluster] = useState('');
  /** 展开元数据的实例（instanceId 集合） */
  const [metaOpen, setMetaOpen] = useState<Set<string>>(new Set());
  /** 以表格视图查看元数据的实例 */
  const [metaTable, setMetaTable] = useState<Set<string>>(new Set());
  const [detailOpen, setDetailOpen] = useState(true);

  /** 新建服务对话框 */
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState('');
  const [cGroup, setCGroup] = useState('DEFAULT_GROUP');
  const [cThreshold, setCThreshold] = useState('0');
  const [cMeta, setCMeta] = useState('');
  const [creating, setCreating] = useState(false);

  /** 提交新建服务：校验 → 注册空服务 → 刷新列表并选中新服务 */
  const createService = async () => {
    const name = cName.trim();
    if (!name) {
      showToast('服务名不能为空', false);
      return;
    }
    let metadata: Record<string, string> | undefined;
    const metaRaw = cMeta.trim();
    if (metaRaw) {
      try {
        const parsed: unknown = JSON.parse(metaRaw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('须为 JSON 对象');
        metadata = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
      } catch {
        showToast('元数据须为合法的 JSON 对象，如 {"version":"1.0"}', false);
        return;
      }
    }
    const threshold = Number(cThreshold.trim() || '0');
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      showToast('保护阈值须为 0 ~ 1 之间的数字', false);
      return;
    }
    setCreating(true);
    try {
      await api.nacosCreateService(connectionId, tenant, { name, group: cGroup.trim() || 'DEFAULT_GROUP', protectThreshold: threshold, metadata });
      showToast(`服务 ${name} 创建成功`);
      setShowCreate(false);
      setCName('');
      setCMeta('');
      await load(1);
    } catch (e) {
      showToast(`新建服务失败：${(e as Error).message}`, false);
    } finally {
      setCreating(false);
    }
  };

  const pagesAvailable = list ? Math.max(1, Math.ceil(list.totalCount / Math.max(1, list.pageSize || pageSize))) : 1;

  /** 加载服务列表（服务名/分组过滤 + 分页） */
  const load = useCallback(
    async (page: number) => {
      setLoading(true);
      setError(null);
      try {
        const pg = await api.nacosServiceList(connectionId, tenant, {
          group: groupFilter.trim() || undefined,
          serviceName: nameFilter.trim() || undefined,
          pageNo: page,
          pageSize,
        });
        setList(pg);
        setPageNo(page);
      } catch (e) {
        setError((e as Error).message);
        setList(null);
      } finally {
        setLoading(false);
      }
    },
    [connectionId, tenant, groupFilter, nameFilter, pageSize],
  );

  // 命名空间变化 → 重新加载列表并清空右侧
  useEffect(() => {
    setSelected(null);
    setDetail(null);
    setInstances([]);
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  /** 单击服务 → 右侧加载详情 + 实例列表 */
  const openService = async (item: NacosServiceItem) => {
    setSelected(item);
    setDetail(null);
    setInstances([]);
    setInstError(null);
    setClusterFilter('');
    setAppliedCluster('');
    setInstLoading(true);
    try {
      const [d, inst] = await Promise.all([
        api.nacosServiceDetail(connectionId, tenant, item.name, item.group).catch(() => null),
        api.nacosInstanceList(connectionId, tenant, item.name, item.group),
      ]);
      setDetail(d);
      setInstances(inst);
    } catch (e) {
      setInstError((e as Error).message);
    } finally {
      setInstLoading(false);
    }
  };

  /** 刷新当前服务（详情 + 实例） */
  const refreshSelected = async () => {
    if (!selected) return;
    await openService(selected);
    showToast('服务数据已刷新');
  };

  const toggleSet = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const shownInstances = instances.filter((i) => !appliedCluster || i.clusterName === appliedCluster);
  const svcBtn = 'flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground';
  const instBtn = 'flex h-6.5 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground';
  const dangerInstBtn = 'flex h-6.5 items-center gap-1 rounded-md border border-prod/40 bg-background px-2.5 text-[11px] text-destructive transition-colors hover:bg-destructive/10';

  return (
    <div ref={splitRef} className="flex min-h-0 flex-1">
      {/* —— 左：服务列表 —— */}
      {!collapsed && (
        <div style={{ width: `${leftPct}%` }} className="flex min-w-0 shrink-0 flex-col">
          {/* 搜索行：服务名 / 全部分组 / + 服务 / 加载 */}
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
            <input
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void load(1)}
              placeholder="服务"
              className="h-7 min-w-[80px] flex-1 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />
            <input
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void load(1)}
              placeholder="全部分组"
              className="h-7 w-28 shrink-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />
            <button onClick={() => setShowCreate(true)} className={svcBtn} title="新建服务">
              <Icon name="plus" className="h-3 w-3" />
              服务
            </button>
            <button onClick={() => void load(pageNo)} className={svcBtn} title="加载服务列表">
              <Icon name="refresh" className="h-3 w-3" />
              加载
            </button>
          </div>

          {/* 服务卡片列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && <ErrorBox message={error} onRetry={() => void load(pageNo)} />}
            {loading && <Loading text="加载服务列表…" />}
            {!loading && !error && list && list.items.length === 0 && <Empty text="该命名空间下没有匹配的服务。" />}
            {!loading && !error &&
              list?.items.map((svc) => {
                const isSel = selected?.name === svc.name && selected?.group === svc.group;
                const allHealthy = svc.ipCount > 0 && svc.healthyCount >= svc.ipCount;
                const noInst = svc.ipCount === 0;
                return (
                  <div
                    key={`${svc.group}::${svc.name}`}
                    onClick={() => void openService(svc)}
                    className={`cursor-pointer border-b border-border/50 px-3 py-2 transition-colors ${isSel ? 'bg-primary/10' : 'hover:bg-muted'}`}
                  >
                    <div className="truncate text-[13px] font-medium text-foreground" title={svc.name}>
                      {svc.name}
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[10.5px]">
                      <Icon name="folder" className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="shrink-0 font-mono text-muted-foreground" title={svc.group}>
                        {svc.group}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-px font-medium ${
                          noInst ? 'bg-secondary text-muted-foreground' : allHealthy ? 'bg-success/15 text-success' : 'bg-warn/15 text-warning'
                        }`}
                      >
                        {noInst ? '无实例' : allHealthy ? '全部健康' : '部分健康'}: {svc.healthyCount}/{svc.ipCount}
                      </span>
                      <span className="shrink-0 text-muted-foreground">· 集群 {svc.clusterCount}</span>
                    </div>
                  </div>
                );
              })}
          </div>

          {/* 底栏：共 N 条 · 翻页（统一 statusbar 规范） */}
          <div className="statusbar">
            <span>{list ? `共 ${list.totalCount} 条` : '—'}</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                disabled={pageNo <= 1}
                onClick={() => void load(pageNo - 1)}
                className="rounded-md border border-border bg-background px-2 py-0.5 transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-30"
              >
                上一页
              </button>
              <span className="min-w-[2.5rem] text-center tabular-nums">
                {pageNo} / {pagesAvailable}
              </span>
              <button
                disabled={pageNo >= pagesAvailable}
                onClick={() => void load(pageNo + 1)}
                className="rounded-md border border-border bg-background px-2 py-0.5 transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-30"
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 分隔线 */}
      {!collapsed && <Splitter onDown={onSplitDown} onReset={() => setLeftPct(42)} />}

      {/* —— 右：服务详情 —— */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        {!selected ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Icon name="cluster" className="h-8 w-8 opacity-40" />
            <span className="text-[12px]">在左侧选择一个服务查看实例详情</span>
          </div>
        ) : (
          <>
            {/* 服务头：名称 + GROUP · N 个已加载实例 + 刷新 */}
            <div className="shrink-0 border-b border-border px-4 pb-2 pt-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground" title={selected.name}>
                  {selected.name}
                </span>
                <button
                  onClick={() => void refreshSelected()}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  title="刷新服务数据"
                >
                  <Icon name="refresh" className="h-3 w-3" />
                  刷新
                </button>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="font-mono">{selected.group}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{selected.ipCount} 个已加载实例</span>
              </div>
            </div>

            {/* 操作行：筛选实例群 | 服务设置·编辑·删除 | 实例·注册实例 */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2">
              <input
                value={clusterFilter}
                onChange={(e) => setClusterFilter(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && setAppliedCluster(clusterFilter.trim())}
                placeholder="筛选实例群"
                className="h-7 w-36 rounded-md border border-border bg-background px-2 text-[11.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
              />
              <button onClick={() => setAppliedCluster(clusterFilter.trim())} className={svcBtn}>
                筛选
              </button>
              <div className="ml-auto flex items-center gap-1.5">
                <button onClick={() => showToast('服务设置功能开发中', false)} className={svcBtn}>
                  服务设置
                </button>
                <button onClick={() => showToast('编辑服务功能开发中', false)} className={svcBtn}>
                  编辑
                </button>
                <button
                  onClick={() => showToast('删除服务功能开发中', false)}
                  className="flex h-7 items-center rounded-md border border-prod/40 bg-background px-2.5 text-[11.5px] text-destructive transition-colors hover:bg-destructive/10"
                >
                  删除
                </button>
                <div className="mx-1 h-4 w-px bg-border" />
                <span className="text-[11px] text-muted-foreground">实例</span>
                <Button
                  size="sm"
                  className="h-7"
                  onClick={() => showToast('注册实例功能开发中', false)}
                >
                  注册实例
                </Button>
              </div>
            </div>

            {/* 内容区：详情 + 实例卡片 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {instLoading && <Loading text="加载实例列表…" />}
              {instError && (
                <div className="mb-3">
                  <InlineError text={instError} tone="prod" />
                </div>
              )}
              {!instLoading && !instError && (
                <>
                  {/* 服务详情（可展开/收起） */}
                  <div className="mb-3">
                    <div className="flex items-center justify-between">
                      <button onClick={() => setDetailOpen((v) => !v)} className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
                        <Icon name="chevronRight-2" className={`h-3 w-3 transition-transform ${detailOpen ? 'rotate-90' : ''}`} />
                        服务详情
                      </button>
                      <button onClick={() => setDetailOpen((v) => !v)} className="text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                        {detailOpen ? '收起' : '展开'}
                      </button>
                    </div>
                    {detailOpen && (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
                        {[
                          ['实例', String(selected.ipCount)],
                          ['健康实例', String(selected.healthyCount)],
                          ['集群', detail ? String(detail.clusters.length || selected.clusterCount) : String(selected.clusterCount)],
                          ['保护阈值', detail ? String(detail.protectThreshold) : '—'],
                        ].map(([label, value]) => (
                          <span key={label} className="text-muted-foreground">{label} <span className="text-foreground">{value}</span></span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 实例卡片 */}
                  {shownInstances.length === 0 ? (
                    <Empty text={appliedCluster ? `集群「${appliedCluster}」下没有实例。` : '该服务暂无实例。'} />
                  ) : (
                    shownInstances.map((inst) => {
                      const id = inst.instanceId;
                      const metaExp = metaOpen.has(id);
                      const asTable = metaTable.has(id);
                      const metaKeys = Object.keys(inst.metadata ?? {});
                      return (
                        <div key={id} className="mb-3 rounded-lg border border-border bg-card p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-[13px] font-semibold text-foreground">
                              {inst.ip}:{inst.port}
                            </span>
                            <span className="font-mono text-[11px] text-muted-foreground">{inst.clusterName}</span>
                            <span className={`rounded-full px-2 py-px text-[10.5px] font-medium ${inst.healthy ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'}`}>
                              {inst.healthy ? '健康' : '不健康'}
                            </span>
                            <span className={`rounded-full px-2 py-px text-[10.5px] font-medium ${inst.enabled ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                              {inst.enabled ? '上线' : '已下线'}
                            </span>
                            <span className="text-[11px] text-muted-foreground">{inst.ephemeral ? '临时实例' : '永久实例'}</span>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-[11px] text-muted-foreground">权重</span>
                            <input
                              value={inst.weight}
                              readOnly
                              className="h-6 w-16 rounded-md border border-border bg-muted px-2 text-[11.5px] text-foreground outline-none"
                              title="权重（修改功能开发中）"
                            />
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              onClick={() => setMetaOpen((s) => toggleSet(s, id))}
                              className="flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <Icon name="chevronRight-2" className={`h-3 w-3 transition-transform ${metaExp ? 'rotate-90' : ''}`} />
                              元数据（{metaKeys.length} 项）
                            </button>
                            <button
                              onClick={() => setMetaTable((s) => toggleSet(s, id))}
                              className="flex items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
                              title="切换元数据视图（JSON / 表格）"
                            >
                              <Icon name="table-2" className="h-3 w-3" />
                              表格查看
                            </button>
                          </div>
                          {metaExp && metaKeys.length > 0 && (
                            <div className="mt-2">
                              {asTable ? (
                                <table className="w-full border-collapse text-[11.5px]">
                                  <tbody>
                                    {metaKeys.map((k) => (
                                      <tr key={k} className="border-b border-border/50">
                                        <td className="w-1/3 py-1 pr-2 align-top font-mono text-muted-foreground">{k}</td>
                                        <td className="break-all py-1 font-mono text-foreground/90">{inst.metadata[k]}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : (
                                <pre className="overflow-x-auto rounded-md bg-muted p-2.5 font-mono text-[11px] leading-relaxed text-foreground/90">
                                  {JSON.stringify(inst.metadata, null, 2)}
                                </pre>
                              )}
                            </div>
                          )}
                          {metaExp && metaKeys.length === 0 && <div className="mt-2 text-[11px] text-muted-foreground">（无元数据）</div>}
                          <div className="mt-2.5 flex items-center gap-1.5">
                            <button onClick={() => showToast('实例编辑功能开发中', false)} className={instBtn}>
                              编辑
                            </button>
                            <button
                              onClick={() => showToast('实例上/下线功能开发中', false)}
                              className={inst.enabled ? dangerInstBtn : instBtn}
                            >
                              {inst.enabled ? '下线' : '上线'}
                            </button>
                            <button onClick={() => showToast('标记不健康功能开发中', false)} className={instBtn}>
                              标记不健康
                            </button>
                            <button onClick={() => showToast('实例注销功能开发中', false)} className={dangerInstBtn}>
                              注销
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* 新建服务对话框 */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={() => !creating && setShowCreate(false)}>
          <div className="w-[420px] rounded-lg border border-border bg-card p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[13px] font-semibold text-foreground">新建服务</span>
              <span className="text-[11px] text-muted-foreground">注册一个空服务（命名空间：{tenant === '' ? 'public' : tenant}）</span>
            </div>
            <div className="flex flex-col gap-2.5">
              <label className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[12px] text-muted-foreground">服务名</span>
                <input
                  autoFocus
                  value={cName}
                  onChange={(e) => setCName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void createService()}
                  placeholder="如 com.example.userservice"
                  className="h-7 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[12px] text-muted-foreground">分组</span>
                <input
                  value={cGroup}
                  onChange={(e) => setCGroup(e.target.value)}
                  placeholder="DEFAULT_GROUP"
                  className="h-7 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
              </label>
              <label className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[12px] text-muted-foreground">保护阈值</span>
                <input
                  value={cThreshold}
                  onChange={(e) => setCThreshold(e.target.value)}
                  placeholder="0"
                  className="h-7 w-24 rounded-md border border-border bg-background px-2 text-[12px] tabular-nums text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
                <span className="text-[11px] text-muted-foreground">0 ~ 1，健康实例比例低于该值时触发保护</span>
              </label>
              <label className="flex items-start gap-2">
                <span className="w-16 shrink-0 pt-1.5 text-[12px] text-muted-foreground">元数据</span>
                <textarea
                  value={cMeta}
                  onChange={(e) => setCMeta(e.target.value)}
                  rows={3}
                  placeholder='可选，JSON 对象，如 {"version":"1.0"}'
                  className="min-h-0 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" size="sm" disabled={creating} onClick={() => setShowCreate(false)}>
                取消
              </Button>
              <Button size="sm" disabled={creating} onClick={() => void createService()}>
                创建
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
