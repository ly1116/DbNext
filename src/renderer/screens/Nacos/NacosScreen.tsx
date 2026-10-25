import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnections } from '@renderer/store/connectionStore';
import { api } from '@renderer/api';
import { Loading, ErrorBox, Empty } from '@renderer/components/common/States';
import { Button } from '@renderer/components/ui/button';
import { Icon } from '@renderer/components/common/icons';
import { NacosConfigDetailPane } from './NacosConfigDetailPane';
import { NacosHistoryDialog } from './NacosHistoryDialog';
import { NacosServices } from './NacosServices';
import { NacosSyncDialog } from './NacosSyncDialog';
import { downloadText, PAGE_SIZE_OPTIONS, Splitter, fmtToneClass, inferType, useSplitter } from './nacosShared';
import type { NacosConfigItem, NacosConfigPage, NacosNamespace } from '@shared/types';

/**
 * Nacos 配置中心浏览器（嵌在工作台主区域标签页内，**非弹窗**）。
 *
 * 布局一比一对齐参考实现：
 * - 顶部一行：左侧地址栏（cloud 图标 + `http://host:port` + 用户名），
 *   右侧功能按钮组：打开控制台 · 展开工作台 · 全文搜索 · 全局替换 · 批量导出 · 批量导入 · 配置同步；
 * - 左面板：「配置 / 服务」胶囊页签 + 搜索行（dataId / 分组 / 应用 + 刷新 + 新建）+
 *   带**复选框**的配置表（DATAID / GROUP / 应用 / 格式）+ 底栏（共 N 条 · 每页条数 · 翻页）；
 * - 右面板：dataId 标题 + `命名空间 / GROUP` 副标题 + 已发布徽标 + **高级配置折叠区** +
 *   配置内容格式 chips + 操作行（复制 · 导出 · 历史 · 另存为 | 校验 · 保存 · 删除）+ 折叠编辑器。
 *
 * 子模块（本文件只保留「配置页」主流程与状态编排）：
 * - `nacosShared.tsx`：格式常量 / 类型推断 / 编辑器语言扩展 / 下载 / 分栏拖拽；
 * - `NacosConfigEditor.tsx`：CodeMirror 6 内容编辑器；
 * - `NacosServices.tsx`：服务发现页（服务列表 + 实例 + 新建服务）；
 * - `NacosSyncDialog.tsx`：配置同步弹窗（跨集群 / 跨命名空间单向复制）。
 *
 * @since 0.2.3
 */

export function NacosBrowser({ connectionId, initialNamespace }: { connectionId: string; initialNamespace?: string }) {
  /** 连接信息（地址栏展示 host:port / username） */
  const conn = useConnections((s) => s.connections.find((c) => c.id === connectionId));
  const address = conn ? `http://${conn.host}:${conn.port}` : '';

  const [namespaces, setNamespaces] = useState<NacosNamespace[]>([]);
  const [nsLoading, setNsLoading] = useState(true);
  const [nsError, setNsError] = useState<string | null>(null);

  const [activeNs, setActiveNs] = useState<string>('');
  const [configs, setConfigs] = useState<NacosConfigPage | null>(null);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);

  /** 主页签：配置 / 服务 */
  const [mainTab, setMainTab] = useState<'config' | 'service'>('config');

  const [dataIdFilter, setDataIdFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [appFilter, setAppFilter] = useState('');

  const [selected, setSelected] = useState<NacosConfigItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  /** 编辑器缓冲：mode=new 时 dataId/group 可编辑；edit 时锁定；view=未选中 */
  const [mode, setMode] = useState<'view' | 'edit' | 'new'>('view');
  const [edDataId, setEdDataId] = useState('');
  const [edGroup, setEdGroup] = useState('DEFAULT_GROUP');
  const [edType, setEdType] = useState<string>('text');
  const [edContent, setEdContent] = useState('');
  const [edDirty, setEdDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  /** 高级配置折叠区 */
  const [advOpen, setAdvOpen] = useState(false);
  /** 左列表折叠（「展开工作台」按钮） */
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  /** 左列表宽度百分比（分隔线可拖拽调节 20%~70%，双击回默认）——复用公共分栏 hook */
  const { splitRef, leftPct, onSplitDown, setLeftPct } = useSplitter(42);

  /** 列表勾选（批量导出用），key = `${group}::${dataId}` */
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  /** 顶部浮动提示（toast） */
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((text: string, ok = true) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const pagesAvailable = configs ? Math.max(1, Math.ceil(configs.totalCount / Math.max(1, configs.pageSize || pageSize))) : 1;

  /** 客户端模糊过滤：dataId / 分组 / 应用 输入即筛（包含匹配，不区分大小写），不走服务端查询 */
  const shownConfigs = useMemo(() => {
    if (!configs) return [];
    const kw = dataIdFilter.trim().toLowerCase();
    const gw = groupFilter.trim().toLowerCase();
    const aw = appFilter.trim().toLowerCase();
    if (!kw && !gw && !aw) return configs.items;
    return configs.items.filter(
      (i) =>
        (!kw || i.dataId.toLowerCase().includes(kw)) &&
        (!gw || i.group.toLowerCase().includes(gw)) &&
        (!aw || (i.appName ?? '').toLowerCase().includes(aw)),
    );
  }, [configs, dataIdFilter, groupFilter, appFilter]);

  /** 配置同步弹窗开关（弹窗关闭即卸载，内部状态自然重置） */
  const [syncOpen, setSyncOpen] = useState(false);
  /** 配置历史弹窗（针对当前选中配置） */
  const [historyOpen, setHistoryOpen] = useState(false);

  /** 加载命名空间列表（服务端鉴权时仅返回/保留有权限的空间） */
  const loadNamespaces = useCallback(async () => {
    setNsLoading(true);
    setNsError(null);
    try {
      const ns = await api.nacosNamespaces(connectionId);
      setNamespaces(ns);
      // 初始命名空间（树节点点进来）优先；否则默认 public / 第一个
      if (initialNamespace != null && (ns.some((x) => x.namespaceId === initialNamespace) || initialNamespace !== '')) {
        setActiveNs(initialNamespace);
      } else {
        const pub = ns.find((x) => x.namespaceId === '');
        setActiveNs(pub ? '' : ns[0]?.namespaceId ?? '');
      }
    } catch (e) {
      setNsError((e as Error).message);
    } finally {
      setNsLoading(false);
    }
  }, [connectionId, initialNamespace]);

  useEffect(() => {
    void loadNamespaces();
  }, [loadNamespaces]);

  /** 加载某命名空间下的配置列表（含搜索条件 + 翻页） */
  const loadConfigs = useCallback(
    async (tenant: string, page: number, size: number) => {
      setCfgLoading(true);
      setCfgError(null);
      setCheckedKeys(new Set());
      try {
        // dataId/分组/应用 改为客户端模糊过滤（输入即筛），服务端始终拉全量当前页
        const page2 = await api.nacosListConfigs(connectionId, tenant, {
          pageNo: page,
          pageSize: size,
        });
        setConfigs(page2);
        setPageNo(page);
      } catch (e) {
        setCfgError((e as Error).message);
        setConfigs(null);
      } finally {
        setCfgLoading(false);
      }
    },
    [connectionId],
  );

  // 命名空间切换 / 初次加载完成 → 拉取列表（权限过滤后无任何可见空间时不发必败请求）
  const nsReady = !nsLoading && !nsError;
  useEffect(() => {
    if (nsReady && (namespaces.length > 0 || activeNs !== '')) void loadConfigs(activeNs, 1, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNs, nsReady]);

  /** 单击某行 → 右侧详情（主从布局，非弹窗） */
  const openConfig = useCallback(
    async (item: NacosConfigItem) => {
      setSelected(item);
      setMode('edit');
      setDetailError(null);
      setDetailLoading(true);
      try {
        const d = await api.nacosGetConfig(connectionId, activeNs, item.dataId, item.group);
        setEdDataId(d.dataId);
        setEdGroup(d.group);
        setEdType(d.type || item.type || inferType(d.dataId));
        setEdContent(d.content);
        setEdDirty(false);
      } catch (e) {
        setDetailError((e as Error).message);
      } finally {
        setDetailLoading(false);
      }
    },
    [connectionId, activeNs],
  );

  /** 新建配置：右侧清空进入 new 模式 */
  const newConfig = () => {
    setSelected(null);
    setMode('new');
    setEdDataId('');
    setEdGroup('DEFAULT_GROUP');
    setEdType('text');
    setEdContent('');
    setEdDirty(false);
    setDetailError(null);
  };

  /** 发布 / 新建后保存 */
  const publish = async () => {
    if (mode === 'new' && !edDataId.trim()) {
      setDetailError('dataId 不能为空');
      return;
    }
    if (!edGroup.trim()) {
      setDetailError('group 不能为空');
      return;
    }
    setSaving(true);
    setDetailError(null);
    try {
      await api.nacosPublishConfig(connectionId, {
        dataId: edDataId.trim(),
        group: edGroup.trim(),
        tenant: activeNs,
        type: edType || 'text',
        content: edContent,
      });
      setEdDirty(false);
      showToast(mode === 'new' ? '配置已发布' : '已保存并发布');
      await loadConfigs(activeNs, pageNo, pageSize);
      // 新建后自动选中刚发布的条目（列表里能找到 → 进 edit 态）
      if (mode === 'new') {
        setMode('edit');
        setSelected({ dataId: edDataId.trim(), group: edGroup.trim(), type: edType } as NacosConfigItem);
      }
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 删除当前配置 */
  /** 删除指定 dataId/group 的配置（删除当前选中行之外的行也适用，弹窗确认） */
  const deleteConfig = async (dataId: string, group: string) => {
    if (!window.confirm(`确认删除配置 ${group}::${dataId} ？`)) return;
    setSaving(true);
    setDetailError(null);
    try {
      await api.nacosDeleteConfig(connectionId, activeNs, dataId, group);
      showToast('配置已删除');
      // 若被删的正是当前打开的详情，则清空右侧
      if (selected && selected.dataId === dataId && selected.group === group) {
        setSelected(null);
        setMode('view');
        setEdDataId('');
        setEdContent('');
      }
      await loadConfigs(activeNs, pageNo, pageSize);
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 删除当前选中的配置（详情区删除按钮调用） */
  const removeConfig = () => {
    if (!selected) return;
    void deleteConfig(selected.dataId, selected.group);
  };

  /** 批量删除：删除勾选的配置（未勾选则提示先勾选）；一次确认后逐个删除 */
  const batchDelete = async () => {
    if (!configs) return;
    const targets = shownConfigs.filter((i) => checkedKeys.has(`${i.group}::${i.dataId}`));
    if (targets.length === 0) {
      showToast('请先勾选要删除的配置', false);
      return;
    }
    const label = targets.length === 1 ? targets[0].dataId : `${targets.length} 个配置`;
    if (!window.confirm(`确认删除 ${label}？`)) return;
    setSaving(true);
    setDetailError(null);
    try {
      let ok = 0;
      for (const t of targets) {
        try {
          await api.nacosDeleteConfig(connectionId, activeNs, t.dataId, t.group);
          ok += 1;
        } catch {
          /* 单个失败继续删除其余 */
        }
      }
      showToast(`已删除 ${ok}/${targets.length} 个配置`);
      // 被删的若是当前打开的详情则清空右侧
      if (selected && targets.some((t) => t.dataId === selected.dataId && t.group === selected.group)) {
        setSelected(null);
        setMode('view');
        setEdDataId('');
        setEdContent('');
      }
      setCheckedKeys(new Set());
      await loadConfigs(activeNs, pageNo, pageSize);
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** 复制配置内容到剪贴板 */
  const copyContent = async () => {
    try {
      await navigator.clipboard.writeText(edContent);
      showToast('内容已复制到剪贴板');
    } catch {
      showToast('复制失败', false);
    }
  };

  /** 导出当前配置为文件 */
  const exportCurrent = () => {
    if (!edDataId) return;
    downloadText(edDataId, edContent);
    showToast(`已导出 ${edDataId}`);
  };

  /** 另存为（克隆为副本）：进入 new 模式，dataId 预填「原名.copy」，分组/格式/内容保留，保存后才真正发布 */
  const saveAs = () => {
    if (!edDataId) return;
    setSelected(null);
    setMode('new');
    setEdDataId(`${edDataId}.copy`);
    // edGroup / edType / edContent 保留当前值不动
    setEdDirty(true);
    setDetailError(null);
    showToast('已创建副本草稿，可修改 Data ID / Group 后保存发布');
  };

  /** 批量导出：勾选优先，未勾选则导出当前筛选后的全部 */
  const batchExport = async () => {
    if (shownConfigs.length === 0) {
      showToast('当前列表为空，无可导出配置', false);
      return;
    }
    const targets = checkedKeys.size > 0 ? shownConfigs.filter((i) => checkedKeys.has(`${i.group}::${i.dataId}`)) : shownConfigs;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      showToast(`批量导出中 ${i + 1}/${targets.length}：${t.dataId}`);
      try {
        const d = await api.nacosGetConfig(connectionId, activeNs, t.dataId, t.group);
        downloadText(t.dataId, d.content);
        await new Promise((r) => setTimeout(r, 200)); // 下载队列错峰
      } catch (e) {
        showToast(`导出 ${t.dataId} 失败：${(e as Error).message}`, false);
        return;
      }
    }
    showToast(`已导出 ${targets.length} 个配置文件`);
  };

  /** 语法校验（json 深校验；yaml 查 Tab 缩进；xml 标签配对粗校验；其余查空） */
  const validateContent = () => {
    const text = edContent;
    if (!text.trim()) {
      showToast('校验失败：内容为空', false);
      return;
    }
    try {
      const t = (edType || '').toLowerCase();
      if (t === 'json') JSON.parse(text);
      else if (t === 'yaml') {
        if (/\t/.test(text)) throw new Error('YAML 不应包含 Tab 缩进，请使用空格');
      } else if (t === 'xml') {
        const opens = text.match(/<[^/!?][^>]*[^/]?>/g)?.length ?? 0;
        const closes = text.match(/<\/[^>]+>/g)?.length ?? 0;
        if (opens !== closes) throw new Error(`标签不配对（开 ${opens} / 闭 ${closes}）`);
      }
      showToast('校验通过：语法正确');
    } catch (err) {
      showToast(`校验失败：${(err as Error).message}`, false);
    }
  };

  /** 切换每页条数（回到第 1 页） */
  const changePageSize = (size: number) => {
    setPageSize(size);
    void loadConfigs(activeNs, 1, size);
  };

  const nsLabel = useMemo(() => {
    if (activeNs === '') return 'public';
    return namespaces.find((x) => x.namespaceId === activeNs)?.namespaceShowName || activeNs;
  }, [activeNs, namespaces]);

  const allChecked = shownConfigs.length > 0 && shownConfigs.every((i) => checkedKeys.has(`${i.group}::${i.dataId}`));
  const toggleCheck = (key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** 顶部功能按钮组（右侧，对齐参考实现） */
  const toolbarBtn = 'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground';
  /** 详情操作行按钮（复制/导出/历史/另存为/校验） */
  const actionBtn = 'flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-40';

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* —— 顶部一行：地址栏 + 功能按钮组 —— */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <Icon name="cloud" className="h-4 w-4 shrink-0 text-primary" />
        <span className="shrink-0 font-mono text-[12.5px] text-foreground" title="Nacos 服务地址">
          {address || '—'}
        </span>
        <div className="h-4 w-px shrink-0 bg-border" />
        <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground" title="登录用户">
          <Icon name="user" className="h-3.5 w-3.5" />
          {conn?.username || '—'}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            className={toolbarBtn}
            title="在系统默认浏览器中打开 Nacos 控制台（自动携带登录 token；官方控制台不认 URL 参数时需首次手动登录）"
            onClick={() => {
              void (async () => {
                let url = `${address}/nacos/index.html`;
                try {
                  url = await api.nacosConsoleUrl(connectionId);
                } catch {
                  /* 无凭据/未连接：直接开控制台首页 */
                }
                try {
                  await api.openExternal(url);
                } catch {
                  window.open(url, '_blank'); // 浏览器预览模式兜底
                }
              })();
            }}
          >
            <Icon name="externalLink" className="h-3.5 w-3.5" />
            打开控制台
          </button>
          <button className={toolbarBtn} title="展开 / 收起左侧配置列表" onClick={() => setLeftCollapsed((v) => !v)}>
            <Icon name="moveH" className="h-3.5 w-3.5" />
            {leftCollapsed ? '展开工作台' : '收起工作台'}
          </button>
          <button className={toolbarBtn} title="跨配置全文搜索（开发中）" onClick={() => showToast('全文搜索功能开发中', false)}>
            <Icon name="search-2" className="h-3.5 w-3.5" />
            全文搜索
          </button>
          <button className={toolbarBtn} title="跨配置全局替换（开发中）" onClick={() => showToast('全局替换功能开发中', false)}>
            <Icon name="redirect" className="h-3.5 w-3.5" />
            全局替换
          </button>
          <button className={toolbarBtn} title="导出勾选的配置（未勾选则导出当前页全部）" onClick={() => void batchExport()}>
            <Icon name="arrowDown" className="h-3.5 w-3.5" />
            批量导出
          </button>
          <button className={toolbarBtn} title="从本地文件批量导入配置（开发中）" onClick={() => showToast('批量导入功能开发中', false)}>
            <Icon name="arrowUp" className="h-3.5 w-3.5" />
            批量导入
          </button>
          <button className={toolbarBtn} title="同步配置到其他集群 / 命名空间（单向复制，按冲突策略处理目标）" onClick={() => setSyncOpen(true)}>
            <Icon name="sync" className="h-3.5 w-3.5" />
            配置同步
          </button>
          {/* 删除配置：仅勾选后出现，红色（destructive 语义令牌，同规格于工具条按钮） */}
          {checkedKeys.size > 0 && (
            <button
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-destructive/50 bg-background px-2.5 text-[11.5px] text-destructive transition-colors hover:border-destructive hover:bg-destructive/10"
              title="删除勾选的配置"
              onClick={() => void batchDelete()}
            >
              <Icon name="trash" className="h-3.5 w-3.5" />
              删除配置
            </button>
          )}
        </div>
      </div>

      {mainTab === 'service' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 页签行（服务视图下也保留，可切回配置） */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <button
              onClick={() => setMainTab('config')}
              className="h-7 rounded-md border border-border bg-background px-3 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              配置
            </button>
            <button className="h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground">服务</button>
          </div>
          <NacosServices connectionId={connectionId} tenant={activeNs} collapsed={leftCollapsed} showToast={showToast} />
        </div>
      ) : (
        <div ref={splitRef} className="flex min-h-0 flex-1">
          {/* —— 左：配置列表（宽度可拖拽，可收起）—— */}
          {!leftCollapsed && (
            <div style={{ width: `${leftPct}%` }} className="flex min-w-0 shrink-0 flex-col">
              {/* 页签行：配置 / 服务 */}
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <button className="h-7 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground">配置</button>
                <button
                  onClick={() => setMainTab('service')}
                  className="h-7 rounded-md border border-border bg-background px-3 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  服务
                </button>
              </div>

              {/* 搜索行：dataId / 分组 / 应用（客户端模糊过滤，输入即筛）+ 刷新 + 新建 */}
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
                <input
                  value={dataIdFilter}
                  onChange={(e) => setDataIdFilter(e.target.value)}
                  placeholder="dataId"
                  title="输入即模糊过滤（包含匹配，不区分大小写）"
                  className="h-7 min-w-[100px] flex-1 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
                <input
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                  placeholder="分组"
                  title="输入即模糊过滤（包含匹配，不区分大小写）"
                  className="h-7 w-24 shrink-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
                <input
                  value={appFilter}
                  onChange={(e) => setAppFilter(e.target.value)}
                  placeholder="应用"
                  title="输入即模糊过滤（包含匹配，不区分大小写）"
                  className="h-7 w-20 shrink-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
                <button
                  onClick={() => {
                    void loadNamespaces();
                    void loadConfigs(activeNs, pageNo, pageSize);
                  }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  title="刷新"
                >
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                </button>
                <Button
                  size="sm"
                  className="h-7 w-7 shrink-0 p-0"
                  onClick={newConfig}
                  title="新建配置"
                >
                  <Icon name="plus" className="h-3.5 w-3.5" strokeWidth={2.2} />
                </Button>
              </div>

              {/* 列表 */}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {nsError && <ErrorBox message={nsError} onRetry={() => void loadNamespaces()} />}
                {cfgLoading && <Loading text="加载配置列表…" />}
                {cfgError && !nsError && <ErrorBox message={cfgError} onRetry={() => void loadConfigs(activeNs, pageNo, pageSize)} />}
                {!nsLoading && !nsError && !cfgLoading && !cfgError && configs && configs.items.length === 0 && (
                  <Empty text="该命名空间暂无配置。点右上角「+」新建第一条。" />
                )}
                {!nsLoading && !nsError && !cfgLoading && !cfgError && configs && configs.items.length > 0 && shownConfigs.length === 0 && (
                  <Empty text="无匹配的配置，请调整筛选关键字。" />
                )}
                {!nsLoading && !nsError && configs && shownConfigs.length > 0 && (
                  <table className="w-full border-collapse text-[12.5px]">
                    <thead className="sticky top-0 z-10 bg-muted">
                      <tr className="border-b border-border text-[11px] tracking-wide text-muted-foreground">
                        <th className="w-8 pl-3 pr-0 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            onChange={() => {
                              const keys = shownConfigs.map((i) => `${i.group}::${i.dataId}`);
                              setCheckedKeys(allChecked ? new Set() : new Set(keys));
                            }}
                            className="h-3 w-3 cursor-pointer accent-primary"
                            title="全选当页（筛选后）"
                          />
                        </th>
                        <th className="px-2 py-2 text-left font-medium">DATAID</th>
                        <th className="w-28 px-2 py-2 text-left font-medium">GROUP</th>
                        <th className="w-16 px-2 py-2 text-left font-medium">应用</th>
                        <th className="w-16 px-2 pr-3 py-2 text-left font-medium">格式</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownConfigs.map((item) => {
                        const key = `${item.group}::${item.dataId}`;
                        const isSel = mode === 'edit' && selected && selected.dataId === item.dataId && selected.group === item.group;
                        const isChecked = checkedKeys.has(key);
                        const fmt = (item.type || inferType(item.dataId)).toLowerCase();
                        return (
                          <tr
                            key={key}
                            onClick={() => void openConfig(item)}
                            className={`cursor-pointer border-b border-border/50 transition-colors ${
                              isSel ? 'bg-primary/12' : isChecked ? 'bg-primary/5' : 'hover:bg-muted'
                            }`}
                          >
                            <td className="w-8 pl-3 pr-0 py-[7px] text-center" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleCheck(key)}
                                className="h-3 w-3 cursor-pointer accent-primary"
                              />
                            </td>
                            <td className="max-w-0 px-2 py-[7px]" title={item.dataId}>
                              <div className="flex min-w-0 items-center gap-1.5">
                                {/* dataId 前的编辑铅笔（对齐参考截图标注）：点击直接进入该配置编辑 */}
                                <button
                                  onClick={(e) => { e.stopPropagation(); void openConfig(item); }}
                                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                                  title="编辑配置"
                                >
                                  <Icon name="edit" className="h-3.5 w-3.5" />
                                </button>
                                <span className={`truncate font-mono ${isSel ? 'font-medium text-foreground' : 'text-foreground/90'}`}>{item.dataId}</span>
                              </div>
                            </td>
                            <td className="truncate px-2 py-[7px] text-muted-foreground" title={item.group}>
                              {item.group}
                            </td>
                            <td className="truncate px-2 py-[7px] text-muted-foreground" title={item.appName || ''}>
                              {item.appName || '—'}
                            </td>
                            <td className="px-2 pr-3 py-[7px]">
                              <span className={`text-[10px] uppercase tracking-wide ${fmtToneClass(fmt)}`}>{fmt}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {/* 底栏：共 N 条 · 每页条数 · 翻页（统一 statusbar 规范） */}
              <div className="statusbar">
                <span>{configs ? `共 ${configs.totalCount} 条` : '—'}</span>
                <div className="ml-auto flex items-center gap-2.5">
                  <span>每页条数</span>
                  <select
                    value={pageSize}
                    onChange={(e) => changePageSize(Number(e.target.value))}
                    className="h-6 rounded-md border border-border bg-background px-1 text-[11px] text-foreground outline-none focus:border-primary"
                  >
                    {PAGE_SIZE_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center gap-1">
                    <button
                      disabled={pageNo <= 1}
                      onClick={() => void loadConfigs(activeNs, pageNo - 1, pageSize)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      title="上一页"
                    >
                      <Icon name="chevronLeft-2" className="h-3 w-3" />
                    </button>
                    <span className="min-w-[3rem] text-center tabular-nums">
                      {pageNo} / {pagesAvailable}
                    </span>
                    <button
                      disabled={pageNo >= pagesAvailable}
                      onClick={() => void loadConfigs(activeNs, pageNo + 1, pageSize)}
                      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
                      title="下一页"
                    >
                      <Icon name="chevronRight-2" className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* —— 可拖拽分隔线（悬停/拖拽高亮）—— */}
          {!leftCollapsed && <Splitter onDown={onSplitDown} onReset={() => setLeftPct(42)} />}

          {/* —— 右：配置详情 / 编辑面板（独立组件，编辑缓冲仍由本组件持有） —— */}
          <NacosConfigDetailPane
            mode={mode}
            edDataId={edDataId}
            setEdDataId={setEdDataId}
            edGroup={edGroup}
            setEdGroup={setEdGroup}
            edType={edType}
            setEdType={setEdType}
            edContent={edContent}
            setEdContent={setEdContent}
            edDirty={edDirty}
            setEdDirty={setEdDirty}
            advOpen={advOpen}
            setAdvOpen={setAdvOpen}
            nsLabel={nsLabel}
            selected={selected}
            detailLoading={detailLoading}
            detailError={detailError}
            saving={saving}
            actionBtn={actionBtn}
            onCopy={() => void copyContent()}
            onExport={exportCurrent}
            onSaveAs={saveAs}
            onValidate={validateContent}
            onPublish={() => void publish()}
            onDelete={() => void removeConfig()}
            onHistory={() => setHistoryOpen(true)}
          />
        </div>
      )}

      {/* 配置同步弹窗（条件挂载：关闭即卸载，状态自然重置） */}
      {syncOpen && (
        <NacosSyncDialog
          connectionId={connectionId}
          tenant={activeNs}
          shownConfigs={shownConfigs}
          checkedKeys={checkedKeys}
          showToast={showToast}
          onClose={() => setSyncOpen(false)}
        />
      )}

      {/* 配置历史弹窗（查看 / 对比 / 回滚） */}
      {historyOpen && selected && (
        <NacosHistoryDialog
          connectionId={connectionId}
          tenant={activeNs}
          item={selected}
          showToast={showToast}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {/* 顶部浮动提示（toast） */}
      {toast && (
        <div
          className={`absolute right-4 top-14 z-50 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] shadow-lg ${
            toast.ok ? 'border-success/40 bg-card text-foreground' : 'border-warning/40 bg-card text-warning'
          }`}
        >
          <Icon name={toast.ok ? 'checkCircle' : 'warning-2'} className={`h-3.5 w-3.5 ${toast.ok ? 'text-success' : 'text-warning'}`} />
          {toast.text}
        </div>
      )}
    </div>
  );
}
