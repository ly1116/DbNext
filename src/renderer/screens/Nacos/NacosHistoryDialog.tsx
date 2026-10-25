import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { Icon } from '@renderer/components/common/icons';
import { inferType } from './nacosShared';
import type { NacosConfigItem, NacosHistoryDetail, NacosHistoryItem } from '@shared/types';

/**
 * 配置历史弹窗（对齐 Nacos 官方控制台「历史版本」）。
 *
 * - 顶部：标题「配置历史」+ namespace / dataId / group 元信息一行；
 * - 表格：Data ID / Group / 更新时间 / 归属应用 / 操作类型 / 操作人 / 操作（查看 · 对比 · 回滚）；
 * - 底部：刷新 + 共 N 条 + 上一页 / 第 x 页 / 下一页；
 * - 查看：当次变更完整内容（只读 pre）；对比：历史版本 与 当前版本 左右两栏；
 * - 回滚：把该版本内容重新发布为当前配置（confirm 后执行）。
 *
 * 由父组件条件挂载（关闭即卸载 → 状态自然重置）。
 */
export function NacosHistoryDialog({ connectionId, tenant, item, showToast, onClose }: {
  connectionId: string;
  /** 命名空间（tenant，public 传空串） */
  tenant: string;
  /** 当前配置（定位 dataId / group） */
  item: NacosConfigItem;
  showToast: (text: string, ok?: boolean) => void;
  onClose: () => void;
}) {
  const PAGE_SIZE = 20;
  const [rows, setRows] = useState<NacosHistoryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 查看：历史版本详情 */
  const [viewing, setViewing] = useState<NacosHistoryDetail | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  /** 对比：历史版本 + 当前版本 */
  const [comparing, setComparing] = useState<{ hist: NacosHistoryDetail; current: string } | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  /** 回滚执行中 */
  const [rollbackId, setRollbackId] = useState<string | null>(null);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = async (p: number) => {
    setBusy(true);
    setError(null);
    try {
      const pg = await api.nacosHistoryList(connectionId, tenant, item.dataId, item.group, { pageNo: p, pageSize: PAGE_SIZE });
      setRows(pg.items);
      setTotal(pg.totalCount);
      setPageNo(p);
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 操作类型映射（v1/v3：insert/update/delete；部分版本返回 I/U/D） */
  const opTypeLabel = (op: string): { text: string; cls: string } => {
    const o = op.toLowerCase();
    if (o.startsWith('i') || o === 'insert') return { text: '新增', cls: 'border-success/40 text-success' };
    if (o.startsWith('u') || o === 'update') return { text: '更新', cls: 'border-primary/40 text-primary' };
    if (o.startsWith('d') || o === 'delete') return { text: '删除', cls: 'border-destructive/40 text-destructive' };
    return { text: op || '—', cls: 'border-border text-muted-foreground' };
  };

  /** 查看历史版本内容 */
  const viewRow = async (row: NacosHistoryItem) => {
    setViewLoading(true);
    try {
      const d = await api.nacosHistoryDetail(connectionId, tenant, item.dataId, item.group, row.id);
      setViewing(d);
    } catch (e) {
      showToast(`读取历史版本失败：${(e as Error).message}`, false);
    } finally {
      setViewLoading(false);
    }
  };

  /** 对比：历史版本 vs 当前版本（左右两栏） */
  const compareRow = async (row: NacosHistoryItem) => {
    setCompareLoading(true);
    try {
      const [hist, cur] = await Promise.all([
        api.nacosHistoryDetail(connectionId, tenant, item.dataId, item.group, row.id),
        api.nacosGetConfig(connectionId, tenant, item.dataId, item.group).catch(() => null),
      ]);
      setComparing({ hist, current: cur?.content ?? '（当前配置不存在，可能已被删除）' });
    } catch (e) {
      showToast(`读取版本内容失败：${(e as Error).message}`, false);
    } finally {
      setCompareLoading(false);
    }
  };

  /** 回滚：用该版本内容覆盖当前配置 */
  const rollbackRow = async (row: NacosHistoryItem) => {
    if (!window.confirm(`确认回滚到 ${row.createdTime ?? '该'} 的版本？\n\n当前配置内容将被该历史版本覆盖。`)) return;
    setRollbackId(row.id);
    try {
      const d = await api.nacosHistoryDetail(connectionId, tenant, item.dataId, item.group, row.id);
      await api.nacosPublishConfig(connectionId, {
        dataId: item.dataId,
        group: item.group,
        tenant,
        type: d.type || item.type || inferType(item.dataId),
        content: d.content,
      });
      showToast('已回滚到历史版本', true);
      void load(pageNo);
    } catch (e) {
      showToast(`回滚失败：${(e as Error).message}`, false);
    } finally {
      setRollbackId(null);
    }
  };

  const opBtn = 'inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div
        className="flex max-h-[82vh] w-[860px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 头：标题 + 元信息 */}
        <div className="flex shrink-0 items-start gap-2.5 px-5 pb-3 pt-4">
          <Icon name="history" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-foreground">配置历史</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
              <span className="truncate" title={tenant === '' ? 'public' : tenant}>namespace={tenant === '' ? 'public' : tenant}</span>
              <span className="truncate" title={item.dataId}>dataId={item.dataId}</span>
              <span className="shrink-0">group={item.group}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
            title="关闭"
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 主体：列表 / 查看 / 对比 */}
        <div className="flex min-h-0 flex-1 flex-col border-t border-border">
          {viewing ? (
            /* —— 查看详情：当次变更完整内容 —— */
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4">
                <button className={opBtn} onClick={() => setViewing(null)} title="返回历史列表">
                  <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                  返回列表
                </button>
                <span className="ml-2 truncate text-[11.5px] text-muted-foreground" title={viewing.createdTime ?? ''}>
                  {opTypeLabel(viewing.opType ?? '').text} · {viewing.createdTime ?? '—'} · 操作人 {viewing.srcUser || '—'}
                </span>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground" spellCheck={false}>
                {viewing.content}
              </pre>
            </div>
          ) : comparing ? (
            /* —— 对比：历史版本 vs 当前版本 —— */
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-4">
                <button className={opBtn} onClick={() => setComparing(null)} title="返回历史列表">
                  <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                  返回列表
                </button>
                <span className="ml-1 text-[11.5px] text-muted-foreground">
                  左 = 历史版本（{comparing.hist.createdTime ?? '—'}） · 右 = 当前版本
                </span>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border">
                <pre className="min-h-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground" spellCheck={false}>
                  {comparing.hist.content}
                </pre>
                <pre className="min-h-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground" spellCheck={false}>
                  {comparing.current}
                </pre>
              </div>
            </div>
          ) : (
            /* —— 历史列表 —— */
            <div className="min-h-0 flex-1 overflow-auto">
              {error ? (
                <div className="px-4 py-6 text-center text-[12px] text-destructive">{error}</div>
              ) : rows === null || (busy && rows !== null && rows.length === 0) ? (
                <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">加载历史…</div>
              ) : rows.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">该配置暂无历史版本</div>
              ) : (
                <table className="w-full border-collapse text-[12px]" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '26%' }} />
                    <col style={{ width: '17%' }} />
                    <col style={{ width: '17%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '10%' }} />
                    <col style={{ width: '12%' }} />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
                    <tr className="border-b border-border text-left">
                      <th className="px-4 py-2 font-normal">Data ID</th>
                      <th className="px-3 py-2 font-normal">Group</th>
                      <th className="px-3 py-2 font-normal">更新时间</th>
                      <th className="px-2 py-2 text-center font-normal">归属应用</th>
                      <th className="px-2 py-2 text-center font-normal">操作类型</th>
                      <th className="px-2 py-2 text-center font-normal">操作人</th>
                      <th className="px-4 py-2 text-right font-normal">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const op = opTypeLabel(row.opType);
                      return (
                        <tr key={row.id} className="border-b border-border/60 hover:bg-secondary/50">
                          <td className="truncate px-4 py-2 font-mono text-foreground" title={row.dataId}>{row.dataId}</td>
                          <td className="truncate px-3 py-2 font-mono text-muted-foreground" title={row.group}>{row.group}</td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.createdTime ?? '—'}</td>
                          <td className="px-2 py-2 text-center text-muted-foreground">{row.appName || '—'}</td>
                          <td className="px-2 py-2 text-center">
                            <span className={`inline-flex rounded border px-1.5 text-[11px] leading-4 ${op.cls}`}>{op.text}</span>
                          </td>
                          <td className="px-2 py-2 text-center text-muted-foreground">{row.srcUser || '—'}</td>
                          <td className="px-4 py-2">
                            <div className="flex items-center justify-end gap-0.5 whitespace-nowrap">
                              <button className={opBtn} disabled={viewLoading} onClick={() => void viewRow(row)} title="查看该版本内容">
                                <Icon name="eye" className="h-3 w-3" />
                                查看
                              </button>
                              <button className={opBtn} disabled={compareLoading} onClick={() => void compareRow(row)} title="与当前版本对比">
                                <Icon name="transfer" className="h-3 w-3" />
                                对比
                              </button>
                              <button
                                className={`${opBtn} hover:text-destructive`}
                                disabled={rollbackId != null}
                                onClick={() => void rollbackRow(row)}
                                title="用该版本内容覆盖当前配置"
                              >
                                <Icon name="refresh-2" className="h-3 w-3" />
                                {rollbackId === row.id ? '回滚中…' : '回滚'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* 底栏：刷新 + 分页 */}
          {!viewing && !comparing && (
            <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border px-4 text-[11.5px] text-muted-foreground">
              <button
                className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 transition-colors hover:text-foreground disabled:opacity-40"
                disabled={busy}
                onClick={() => void load(pageNo)}
                title="重新加载历史列表"
              >
                <Icon name="refresh-4" className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
                刷新
              </button>
              <span className="ml-auto">共 {total} 条</span>
              <button
                className="inline-flex h-6 items-center rounded-md border border-border bg-background px-2 transition-colors hover:text-foreground disabled:opacity-40"
                disabled={busy || pageNo <= 1}
                onClick={() => void load(pageNo - 1)}
              >
                上一页
              </button>
              <span className="tabular-nums">{pageNo} / {pages}</span>
              <button
                className="inline-flex h-6 items-center rounded-md border border-border bg-background px-2 transition-colors hover:text-foreground disabled:opacity-40"
                disabled={busy || pageNo >= pages}
                onClick={() => void load(pageNo + 1)}
              >
                下一页
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
