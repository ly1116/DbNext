import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Icon } from '@renderer/components/common/icons';
import { useConnections } from '@renderer/store/connectionStore';
import { inferType } from './nacosShared';
import type { NacosConfigItem, NacosNamespace } from '@shared/types';

/**
 * 配置同步弹窗（单向复制：源命名空间 → 目标集群/命名空间）。
 *
 * - 配置范围：已选配置 / 当前筛选结果 / 当前命名空间全部（全量分页拉取）；
 * - 目标：目标集群（任意 Nacos 连接，支持跨集群）+ 目标命名空间 + 可选目标 Group（留空 = 与源相同）；
 * - 冲突策略：遇冲突终止 / 跳过冲突 / 覆盖目标；
 * - 两步：预览（比对目标同名配置）→ 执行（逐条读源写目标，失败不中断）。
 *
 * 由父组件条件挂载（关闭即卸载 → 状态自然重置）。
 */
export function NacosSyncDialog({ connectionId, tenant, shownConfigs, checkedKeys, showToast, onClose }: {
  connectionId: string;
  /** 源命名空间（tenant） */
  tenant: string;
  /** 当前筛选后的配置列表（「当前筛选结果」范围取此） */
  shownConfigs: NacosConfigItem[];
  /** 列表勾选 key 集合（`group::dataId`） */
  checkedKeys: Set<string>;
  showToast: (text: string, ok?: boolean) => void;
  onClose: () => void;
}) {
  type SyncStrategy = 'abort' | 'skip' | 'overwrite';
  type SyncPlanRow = { item: NacosConfigItem; targetGroup: string; exists: boolean };

  const allConns = useConnections((s) => s.connections);
  const nacosConns = allConns.filter((c) => c.kind === 'nacos');

  const [syncScope, setSyncScope] = useState<'checked' | 'filtered' | 'all'>(checkedKeys.size > 0 ? 'checked' : 'filtered');
  /** 默认目标 = 第一个其他 Nacos 集群（无则当前集群） */
  const [syncTargetConn, setSyncTargetConn] = useState(() => (nacosConns.find((c) => c.id !== connectionId) ?? nacosConns[0])?.id ?? '');
  const [syncTargetNs, setSyncTargetNs] = useState('');
  const [syncTargetNsOpts, setSyncTargetNsOpts] = useState<NacosNamespace[]>([]);
  const [syncNsLoading, setSyncNsLoading] = useState(false);
  const [syncTargetGroup, setSyncTargetGroup] = useState('');
  const [syncStrategy, setSyncStrategy] = useState<SyncStrategy>('abort');
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncErr, setSyncErr] = useState<string | null>(null);
  const [syncPlan, setSyncPlan] = useState<SyncPlanRow[] | null>(null);
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number } | null>(null);

  const syncCheckedCount = shownConfigs.filter((i) => checkedKeys.has(`${i.group}::${i.dataId}`)).length;
  const syncConn = nacosConns.find((c) => c.id === syncTargetConn);
  const syncConflictCount = syncPlan?.filter((r) => r.exists).length ?? 0;

  // 目标集群变化 → 加载其命名空间列表（默认选 public / 第一个）
  useEffect(() => {
    if (!syncTargetConn) return;
    let alive = true;
    setSyncNsLoading(true);
    setSyncTargetNsOpts([]);
    setSyncPlan(null);
    api
      .nacosNamespaces(syncTargetConn)
      .then((nsList) => {
        if (!alive) return;
        setSyncTargetNsOpts(nsList);
        setSyncTargetNs(nsList[0]?.namespaceId ?? '');
      })
      .catch((e) => alive && setSyncErr(`读取目标命名空间失败：${(e as Error).message}`))
      .finally(() => alive && setSyncNsLoading(false));
    return () => {
      alive = false;
    };
  }, [syncTargetConn]);

  /** 拉取指定连接+命名空间的**全量**配置（分页循环，每页 500） */
  const fetchAllConfigs = async (cid: string, ns: string): Promise<NacosConfigItem[]> => {
    const out: NacosConfigItem[] = [];
    let page = 1;
    for (;;) {
      const pg = await api.nacosListConfigs(cid, ns, { pageNo: page, pageSize: 500 });
      out.push(...pg.items);
      const total = pg.totalCount ?? out.length;
      if (out.length >= total || pg.items.length === 0) break;
      page += 1;
      if (page > 50) break; // 保险丝：最多 25000 条
    }
    return out;
  };

  /** 当前同步范围对应的源配置清单（勾选 / 筛选结果 / 全量拉取） */
  const syncSourceItems = async (): Promise<NacosConfigItem[]> => {
    if (syncScope === 'checked') return shownConfigs.filter((i) => checkedKeys.has(`${i.group}::${i.dataId}`));
    if (syncScope === 'filtered') return shownConfigs;
    return fetchAllConfigs(connectionId, tenant);
  };

  /** 预览：拉取目标全量配置，比对同名（dataId + 目标 Group）冲突 */
  const doPreview = async () => {
    if (!syncTargetConn || syncBusy) return;
    if (syncTargetConn === connectionId && syncTargetNs === tenant) {
      setSyncErr('目标命名空间与源相同，无需同步');
      return;
    }
    setSyncErr(null);
    setSyncBusy(true);
    try {
      const source = await syncSourceItems();
      if (source.length === 0) {
        setSyncErr('同步范围为空：请先勾选配置或调整筛选条件');
        setSyncPlan(null);
        return;
      }
      const targetItems = await fetchAllConfigs(syncTargetConn, syncTargetNs);
      const targetKeys = new Set(targetItems.map((i) => `${i.group}::${i.dataId}`));
      const gOverride = syncTargetGroup.trim();
      setSyncPlan(
        source.map((item) => {
          const tg = gOverride || item.group;
          return { item, targetGroup: tg, exists: targetKeys.has(`${tg}::${item.dataId}`) };
        }),
      );
    } catch (e) {
      setSyncErr(`预检失败：${(e as Error).message}`);
      setSyncPlan(null);
    } finally {
      setSyncBusy(false);
    }
  };

  /** 执行同步：按冲突策略逐条「读源 → 写目标」，全部成功后关闭弹窗 */
  const doSync = async () => {
    if (!syncPlan || !syncConn || syncBusy) return;
    const conflicts = syncPlan.filter((r) => r.exists);
    if (syncStrategy === 'abort' && conflicts.length > 0) {
      setSyncErr(`预检发现 ${conflicts.length} 个同名冲突，策略为「遇冲突终止」，已停止写入。请改用「跳过冲突 / 覆盖目标」或先处理目标配置。`);
      return;
    }
    const todo = syncPlan.filter((r) => syncStrategy !== 'skip' || !r.exists);
    setSyncBusy(true);
    setSyncErr(null);
    setSyncProgress({ done: 0, total: todo.length });
    let ok = 0;
    const failed: string[] = [];
    try {
      for (let i = 0; i < todo.length; i++) {
        const r = todo[i];
        setSyncProgress({ done: i, total: todo.length });
        try {
          const d = await api.nacosGetConfig(connectionId, tenant, r.item.dataId, r.item.group);
          await api.nacosPublishConfig(syncTargetConn, {
            dataId: r.item.dataId,
            group: r.targetGroup,
            tenant: syncTargetNs,
            type: d.type || r.item.type || inferType(r.item.dataId),
            content: d.content,
          });
          ok += 1;
        } catch (e) {
          failed.push(`${r.item.group}::${r.item.dataId}：${(e as Error).message}`);
        }
      }
    } finally {
      setSyncProgress(null);
      setSyncBusy(false);
    }
    if (failed.length === 0) {
      showToast(`同步完成：成功写入 ${ok} 个配置`);
      onClose();
    } else {
      setSyncErr(`同步完成：成功 ${ok} 个，失败 ${failed.length} 个。\n${failed.slice(0, 5).join('\n')}${failed.length > 5 ? `\n…等共 ${failed.length} 条失败` : ''}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={() => !syncBusy && onClose()}>
      <div className="flex max-h-[85vh] w-[560px] flex-col rounded-lg border border-border bg-card shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        {/* 头 */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <span className="text-[13px] font-semibold text-foreground">同步配置到其他命名空间</span>
          <button
            onClick={() => !syncBusy && onClose()}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="关闭"
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-[11.5px] leading-relaxed text-muted-foreground">
            同步采用单向复制语义，不会删除或修改源配置；目标配置按所选冲突策略处理。
          </p>

          {/* 配置范围 */}
          <div className="mb-1 text-[12px] font-medium text-foreground">配置范围</div>
          <div className="mb-3 flex flex-col gap-1.5">
            {([
              ['checked', `已选配置（${syncCheckedCount}）`],
              ['filtered', `当前筛选结果（预计 ${shownConfigs.length}）`],
              ['all', '当前命名空间全部'],
            ] as const).map(([v, label]) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
                <input
                  type="radio"
                  name="syncScope"
                  className="h-3.5 w-3.5 accent-primary"
                  checked={syncScope === v}
                  disabled={syncBusy || (v === 'checked' && syncCheckedCount === 0)}
                  onChange={() => {
                    setSyncScope(v);
                    setSyncPlan(null);
                  }}
                />
                {label}
              </label>
            ))}
          </div>

          {/* 目标集群 / 命名空间 / Group */}
          <div className="mb-3 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-foreground">目标集群</span>
              <select
                value={syncTargetConn}
                disabled={syncBusy}
                onChange={(e) => {
                  setSyncTargetConn(e.target.value);
                  setSyncPlan(null);
                }}
                className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px] text-foreground outline-none focus:border-primary"
              >
                {nacosConns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.host}:{c.port})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-foreground">目标命名空间</span>
              <select
                value={syncTargetNs}
                disabled={syncBusy || syncNsLoading}
                onChange={(e) => {
                  setSyncTargetNs(e.target.value);
                  setSyncPlan(null);
                }}
                className="h-7 rounded-md border border-border bg-background px-1.5 text-[12px] text-foreground outline-none focus:border-primary"
              >
                {syncNsLoading && <option value="">加载中…</option>}
                {!syncNsLoading &&
                  syncTargetNsOpts.map((ns) => (
                    <option key={ns.namespaceId || 'public'} value={ns.namespaceId}>
                      {ns.namespaceId === '' ? 'public' : ns.namespaceShowName || ns.namespaceId}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label className="mb-1 flex flex-col gap-1">
            <span className="text-[12px] font-medium text-foreground">目标 Group（可选）</span>
            <input
              value={syncTargetGroup}
              disabled={syncBusy}
              onChange={(e) => {
                setSyncTargetGroup(e.target.value);
                setSyncPlan(null);
              }}
              placeholder="与源 Group 相同"
              className="h-7 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />
          </label>
          <p className="mb-3 text-[11px] text-muted-foreground">同步采用单向复制语义，源命名空间中的配置将保持不变。</p>

          {/* 冲突策略 */}
          <div className="mb-1 text-[12px] font-medium text-foreground">冲突策略</div>
          <div className="mb-3 grid grid-cols-3 gap-2">
            {([
              ['abort', '遇冲突终止', '预检发现冲突时停止写入'],
              ['skip', '跳过冲突', '仅创建目标中不存在的配置'],
              ['overwrite', '覆盖目标', '用源配置覆盖同名目标配置'],
            ] as const).map(([v, title, desc]) => (
              <button
                key={v}
                type="button"
                disabled={syncBusy}
                onClick={() => {
                  setSyncStrategy(v);
                  setSyncPlan(null);
                }}
                className={`rounded-md border px-2.5 py-2 text-left transition-colors ${
                  syncStrategy === v ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                }`}
              >
                <span className="flex items-center gap-1.5 text-[12px] text-foreground">
                  <input type="radio" name="syncStrategy" readOnly checked={syncStrategy === v} className="h-3 w-3 accent-primary" />
                  {title}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-4 text-muted-foreground">{desc}</span>
              </button>
            ))}
          </div>

          {/* 预览结果 */}
          {syncPlan && (
            <div className="rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
                <span>
                  预检共 <b className="text-foreground">{syncPlan.length}</b> 项：新增 <b className="text-foreground">{syncPlan.length - syncConflictCount}</b> · 冲突{' '}
                  <b className={syncConflictCount > 0 ? 'text-warning' : 'text-foreground'}>{syncConflictCount}</b>
                </span>
                <span className="ml-auto">
                  目标：{syncConn ? `${syncConn.host}:${syncConn.port}` : ''} / {syncTargetNs === '' ? 'public' : syncTargetNs}
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto px-2.5 py-1 font-mono text-[11px] leading-5">
                {syncPlan.map((r) => (
                  <div key={`${r.item.group}::${r.item.dataId}`} className="flex items-center gap-2">
                    <span className={`shrink-0 ${r.exists ? 'text-warning' : 'text-success'}`}>{r.exists ? '冲突' : '新增'}</span>
                    <span className="shrink-0 text-muted-foreground">{r.targetGroup}</span>
                    <span className="truncate text-foreground" title={r.item.dataId}>
                      {r.item.dataId}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 进度 / 错误 */}
          {syncProgress && (
            <div className="mt-2 text-[11.5px] text-muted-foreground">
              同步中 {syncProgress.done}/{syncProgress.total}…
            </div>
          )}
          {syncErr && <div className="mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-destructive">{syncErr}</div>}
        </div>

        {/* 底部按钮 */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" disabled={syncBusy} onClick={onClose}>
            关闭
          </Button>
          <Button variant="outline" size="sm" disabled={syncBusy} onClick={() => void doPreview()}>
            {syncBusy && !syncPlan ? '预检中…' : syncPlan ? '重新预览' : '预览'}
          </Button>
          {syncPlan && (
            <Button size="sm" disabled={syncBusy} onClick={() => void doSync()}>
              {syncStrategy === 'skip' && syncConflictCount > 0 ? `执行同步（跳过 ${syncConflictCount} 冲突）` : '执行同步'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
