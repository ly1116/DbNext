import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentUnit, StreamLanguage, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { yaml as yamlLegacy } from '@codemirror/legacy-modes/mode/yaml';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { html } from '@codemirror/lang-html';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { editorTheme } from '@renderer/theme/editor-themes';
import { UI_THEMES } from '@renderer/theme/ui-themes';
import { usePrefs } from '@renderer/store/prefsStore';
import { useConnections } from '@renderer/store/connectionStore';
import { api } from '@renderer/api';
import { Loading, ErrorBox, Empty, InlineError } from '@renderer/components/common/States';
import { Button } from '@renderer/components/ui/button';
import { Icon } from '@renderer/components/common/icons';
import type { NacosConfigItem, NacosConfigPage, NacosInstanceInfo, NacosNamespace, NacosServiceDetail, NacosServiceItem, NacosServicePage } from '@shared/types';

/**
 * Nacos 配置中心浏览器（嵌在工作台主区域标签页内，**非弹窗**）。
 *
 * 布局一比一对齐参考实现：
 * - 顶部一行：左侧地址栏（cloud 图标 + `http://host:port` + 用户名 + 命名空间下拉），
 *   右侧功能按钮组：打开控制台 · 展开工作台 · 全文搜索 · 全局替换 · 批量导出 · 批量导入 · 配置同步；
 * - 左面板：「配置 / 服务」胶囊页签 + 搜索行（dataId / 分组 / 应用 + 刷新 + 新建）+
 *   带**复选框**的配置表（DATAID / GROUP / 应用 / 格式）+ 底栏（共 N 条 · 每页条数 · 翻页）；
 * - 右面板：dataId 标题 + `命名空间 / GROUP` 副标题 + 已发布徽标 + **高级配置折叠区** +
 *   配置内容格式 chips + 操作行（复制 · 导出 · 历史 · 另存为 | 校验 · 保存 · 删除）+ 折叠编辑器。
 *
 * @since 0.2.3
 */

/** 详情页格式 chips（对齐参考实现：TEXT JSON XML YAML HTML Properties TOML） */
const FORMAT_CHIPS = ['TEXT', 'JSON', 'XML', 'YAML', 'HTML', 'Properties', 'TOML'] as const;
/** chip → nacos type 小写值（用于高亮匹配） */
const chipType = (chip: string) => chip.toLowerCase();

/** 每页条数可选项 */
const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100] as const;

/** 推断新建配置默认格式（按 dataId 后缀启发式；命中不了回退 text） */
function inferType(dataId: string): string {
  const lower = dataId.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.js')) return 'json';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.properties') || lower.endsWith('.conf') || lower.endsWith('.cfg') || lower.endsWith('.ini')) return 'properties';
  return 'text';
}

/** 格式 chip 是否高亮（编辑态按当前类型；新建未选按 dataId 推断） */
function chipActive(chip: string, type: string): boolean {
  const c = chipType(chip);
  if (c === 'properties') return type === 'properties';
  return c === type;
}

/** 列表「格式」列的色调（按类型微区分，保持克制） */
function fmtToneClass(fmt: string): string {
  switch (fmt) {
    case 'yaml':
    case 'yml':
      return 'text-warning';
    case 'json':
      return 'text-success';
    case 'xml':
    case 'html':
      return 'text-destructive';
    case 'properties':
    case 'toml':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

/**
 * YAML 专属高亮（基于 legacy yaml mode，自带 tokenizer）。
 * 实测 legacy mode 对各语法单元产出的 tag 为：
 *   - 键名            → tags.atom              （注意：不是 propertyName）
 *   - 引号字符串       → tags.string
 *   - 数字            → tags.number
 *   - true/false/on/off… → tags.keyword
 *   - &锚点 / *别名    → tags.variableName
 *   - --- / ... 文档标记 → tags.definition(variableName)
 *   - 注释            → tags.comment
 *   - 分隔符/列表符/块标量 → tags.meta（: - | > { } [ ] ,）
 * 编辑器通用高亮把这些大部分映射成前景白，故单独给 YAML 一套克制配色：
 * 键名蓝、字符串橙红、数字绿、布尔蓝、注释灰斜体、结构灰。不影响 json/xml 等其它语言。
 */
function yamlThemeHighlight(): Extension {
  const theme = usePrefs.getState().prefs.theme ?? 'darcula';
  const p = UI_THEMES[theme] ?? UI_THEMES.darcula;
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.atom, color: p.blue }, // YAML 键名
      { tag: [t.string, t.special(t.string)], color: p.str },
      { tag: [t.number, t.integer, t.float], color: p.num },
      { tag: [t.keyword, t.bool, t.null], color: p.blue }, // true/false/on/off…
      { tag: t.variableName, color: p.fn }, // &anchor / *alias
      { tag: t.definition(t.variableName), color: p.dim2 }, // --- / ... 文档标记
      { tag: t.comment, color: p.dim2, fontStyle: 'italic' },
      { tag: [t.meta, t.documentMeta], color: p.dim }, // : / - / | / > / {}[] ,
      { tag: [t.punctuation, t.separator, t.bracket], color: p.dim }, // 兜底（内联结构）
    ]),
  );
}

/** 配置类型 → CodeMirror 语法高亮扩展（自动适配：yaml/json/xml/html/properties/toml，text 无高亮） */
function langExtensionOf(type: string, dataId: string): Extension | null {
  const t = (type || inferType(dataId)).toLowerCase();
  if (t === 'yaml') return [StreamLanguage.define(yamlLegacy), yamlThemeHighlight()];
  if (t === 'json') return json();
  if (t === 'xml') return xml();
  if (t === 'html') return html({ matchClosingTags: false });
  if (t === 'properties') return StreamLanguage.define(properties);
  if (t === 'toml') return StreamLanguage.define(toml);
  return null;
}

/** 折叠标记 DOM：对齐参考编辑器行号旁的小箭头（展开 ⌄ / 收起 ›） */
function foldMarkerDOM(open: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cm-fold-marker';
  span.innerHTML = `<svg viewBox="0 0 12 12" width="10" height="10" style="opacity:.5"><path d="${open ? 'M3 4.5 6 7.5 9 4.5' : 'M4.5 3 7.5 6 4.5 9'}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return span;
}

/** 将文本作为文件下载（导出 / 另存为 / 批量导出共用） */
function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 左右分栏拖拽 hook：返回容器 ref / 左宽百分比 / 拖拽事件（clamp 20%~70%，双击回默认） */
function useSplitter(defaultPct = 42) {
  const splitRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(defaultPct);
  const drag = useRef<{ startX: number; startPct: number } | null>(null);
  const onSplitDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startPct: leftPct };
    e.preventDefault();
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = drag.current.startPct + ((e.clientX - drag.current.startX) / rect.width) * 100;
      setLeftPct(Math.min(70, Math.max(20, pct)));
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);
  return { splitRef, leftPct, onSplitDown, setLeftPct };
}

/** 分隔线（悬停/拖拽高亮，双击恢复默认） */
function Splitter({ onDown, onReset }: { onDown: (e: React.PointerEvent) => void; onReset: () => void }) {
  return (
    <div onPointerDown={onDown} onDoubleClick={onReset} className="group relative w-1 shrink-0 cursor-col-resize bg-background" title="拖拽调节左右宽度">
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/70" />
    </div>
  );
}

/**
 * 服务发现浏览器（「服务」页签，一比一对齐参考实现）：
 * - 左：搜索行（服务名 / 全部分组 / + 服务 / 加载）+ 服务卡片列表（GROUP · 全部健康 x/y · 集群 N）+ 底栏翻页；
 * - 右：服务头（名称 + `GROUP · N 个已加载实例` + 刷新）+ 操作行（筛选实例群 | 服务设置·编辑·删除 | 实例·注册实例）+
 *   服务详情（实例/健康/集群/保护阈值）+ 实例卡片（ip:port · 健康 · 上线 · 临时实例 · 权重 · 元数据折叠 · 操作按钮）。
 * 实例写操作（编辑/下线/注销等）当前为占位。
 */
function NacosServices({ connectionId, tenant, collapsed, showToast }: {
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
              className="h-7 min-w-[80px] flex-1 rounded-md border border-border bg-background px-2 text-[length:var(--fs-body)] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />
            <input
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void load(1)}
              placeholder="全部分组"
              className="h-7 w-28 shrink-0 rounded-md border border-border bg-background px-2 text-[length:var(--fs-body)] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
            />
            <button onClick={() => showToast('新建服务功能开发中', false)} className={svcBtn} title="新建服务">
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
    </div>
  );
}

/**
 * 配置内容编辑器（CodeMirror 6 封装，模块级组件）。
 *
 * - 语法高亮按配置类型自动切换（Compartment 热重载），行号 / 折叠箭头 / 括号匹配 / 撤销历史；
 * - 内容外部更新（切换配置 / 读取详情）时整篇替换；用户输入经 onChange 回写父状态，
 *   回写后 value === doc 时不重复 dispatch，避免光标跳动；
 * - 主题跟随「设置 → 外观 → 配色方案」。
 */
function NacosConfigEditor({ value, type, dataId, readOnly, onChange }: {
  value: string;
  type: string;
  dataId: string;
  readOnly?: boolean;
  onChange?: (v: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langComp = useRef(new Compartment());
  /** 编辑器主题舱：深/浅主题切换时热替换底色与语法配色，避免编辑器停在旧主题（浅色下仍黑底） */
  const themeComp = useRef(new Compartment());
  /** 跟随「设置 → 外观 → 配色方案」；作为依赖驱动下方主题热替换 effect */
  const theme = usePrefs((s) => s.prefs.theme);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 创建实例（一次）；销毁随卸载
  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          foldGutter({ markerDOM: foldMarkerDOM }),
          highlightActiveLine(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          highlightSpecialChars(),
          history(),
          bracketMatching(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(!!readOnly),
          EditorView.editable.of(!readOnly),
          langComp.current.of(langExtensionOf(type, dataId) ?? []),
          themeComp.current.of(editorTheme(theme)),
          // 关键：CodeMirror 默认 height:auto 随内容撑高，必须显式限高 100% 并让 scroller 滚动，
          // 否则长配置在 flex 容器（overflow-hidden）里被直接裁掉、无法上下滚动
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, Menlo, Consolas, "JetBrains Mono", monospace', lineHeight: '1.65' },
            '.cm-gutters': { flexShrink: 0 },
            '.cm-foldGutter': { width: '14px' },
            '.cm-foldGutter .cm-gutterElement': { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 2px', cursor: 'pointer' },
          }),
          indentUnit.of('  '),
          keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !readOnly) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化（切换配置 / 加载详情）→ 整篇替换；自身输入回写不触发（doc 已相等）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (doc !== value) {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: value } });
    }
  }, [value]);

  // 类型 / dataId / 主题变化 → 语言高亮热切换（YAML 专属配色随主题换肤）
  useEffect(() => {
    viewRef.current?.dispatch({ effects: langComp.current.reconfigure(langExtensionOf(type, dataId) ?? []) });
  }, [type, dataId, theme]);

  // 主题（深/浅）切换 → 编辑器底色 + 通用语法高亮热替换（修复浅色主题下编辑器仍为黑底的问题）
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeComp.current.reconfigure(editorTheme(theme)) });
  }, [theme]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden" />;
}

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
  /** 左列表宽度百分比（分隔线可拖拽调节，20%~70%） */
  const [leftPct, setLeftPct] = useState(42);
  const splitRef = useRef<HTMLDivElement>(null);
  const splitDrag = useRef<{ startX: number; startPct: number } | null>(null);

  // 分隔线拖拽：pointerdown 记录起点，window 级 move/up 计算百分比（clamp 20~70）
  const onSplitDown = (e: React.PointerEvent) => {
    splitDrag.current = { startX: e.clientX, startPct: leftPct };
    e.preventDefault();
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!splitDrag.current || !splitRef.current) return;
      const rect = splitRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = splitDrag.current.startPct + ((e.clientX - splitDrag.current.startX) / rect.width) * 100;
      setLeftPct(Math.min(70, Math.max(20, pct)));
    };
    const up = () => {
      splitDrag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, []);

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
        const page2 = await api.nacosListConfigs(connectionId, tenant, {
          dataId: dataIdFilter.trim() || undefined,
          group: groupFilter.trim() || undefined,
          appName: appFilter.trim() || undefined,
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
    [connectionId, dataIdFilter, groupFilter, appFilter],
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
  const removeConfig = async () => {
    if (!selected) return;
    if (!window.confirm(`确认删除配置 ${selected.group}::${selected.dataId} ？`)) return;
    setSaving(true);
    setDetailError(null);
    try {
      await api.nacosDeleteConfig(connectionId, activeNs, selected.dataId, selected.group);
      showToast('配置已删除');
      setSelected(null);
      setMode('view');
      setEdDataId('');
      setEdContent('');
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

  /** 另存为（自定义文件名） */
  const saveAs = () => {
    if (!edDataId) return;
    const name = window.prompt('另存为文件名：', edDataId);
    if (!name) return;
    downloadText(name, edContent);
    showToast(`已导出 ${name}`);
  };

  /** 批量导出：勾选优先，未勾选则导出当前页全部 */
  const batchExport = async () => {
    if (!configs || configs.items.length === 0) {
      showToast('当前列表为空，无可导出配置', false);
      return;
    }
    const targets = checkedKeys.size > 0 ? configs.items.filter((i) => checkedKeys.has(`${i.group}::${i.dataId}`)) : configs.items;
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

  const runSearch = () => void loadConfigs(activeNs, 1, pageSize);

  /** 切换每页条数（回到第 1 页） */
  const changePageSize = (size: number) => {
    setPageSize(size);
    void loadConfigs(activeNs, 1, size);
  };

  const nsLabel = useMemo(() => {
    if (activeNs === '') return 'public';
    return namespaces.find((x) => x.namespaceId === activeNs)?.namespaceShowName || activeNs;
  }, [activeNs, namespaces]);

  /** 当页勾选状态（全选框） */
  const allChecked = !!configs && configs.items.length > 0 && configs.items.every((i) => checkedKeys.has(`${i.group}::${i.dataId}`));
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
        <div className="h-4 w-px shrink-0 bg-border" />
        {/* 命名空间下拉（仅显示有权限的空间） */}
        <select
          value={activeNs}
          onChange={(e) => {
            setActiveNs(e.target.value);
            setSelected(null);
            setMode('view');
          }}
          className="h-7 max-w-[200px] rounded-md border border-transparent bg-transparent px-1.5 text-[12px] text-foreground outline-none transition-colors hover:border-border focus:border-primary"
          title="命名空间（仅显示有权限的空间）"
        >
          {nsLoading && <option value={activeNs}>加载中…</option>}
          {!nsLoading &&
            namespaces.map((ns) => (
              <option key={ns.namespaceId || 'public'} value={ns.namespaceId}>
                {ns.namespaceId === '' ? 'public' : ns.namespaceShowName || ns.namespaceId}
              </option>
            ))}
          {!nsLoading && namespaces.length === 0 && <option value={activeNs}>{nsError ? '（无权限空间）' : '（无命名空间）'}</option>}
        </select>

        <div className="ml-auto flex items-center gap-1.5">
          <button className={toolbarBtn} title="在系统浏览器中打开 Nacos 官方控制台" onClick={() => address && window.open(`${address}/nacos`, '_blank')}>
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
          <button className={toolbarBtn} title="多环境配置同步（开发中）" onClick={() => showToast('配置同步功能开发中', false)}>
            <Icon name="sync" className="h-3.5 w-3.5" />
            配置同步
          </button>
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

              {/* 搜索行：dataId / 分组 / 应用 + 刷新 + 新建 */}
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
                <input
                  value={dataIdFilter}
                  onChange={(e) => setDataIdFilter(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="dataId"
                  className="h-7 min-w-[100px] flex-1 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
                <input
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="分组"
                  className="h-7 w-24 shrink-0 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
                />
                <input
                  value={appFilter}
                  onChange={(e) => setAppFilter(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runSearch()}
                  placeholder="应用"
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
                  <Empty text="该命名空间暂无匹配的配置。点右上角「+」新建第一条。" />
                )}
                {!nsLoading && !nsError && configs && configs.items.length > 0 && (
                  <table className="w-full border-collapse text-[12.5px]">
                    <thead className="sticky top-0 z-10 bg-muted">
                      <tr className="border-b border-border text-[11px] tracking-wide text-muted-foreground">
                        <th className="w-8 pl-3 pr-0 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            onChange={() => {
                              const keys = configs.items.map((i) => `${i.group}::${i.dataId}`);
                              setCheckedKeys(allChecked ? new Set() : new Set(keys));
                            }}
                            className="h-3 w-3 cursor-pointer accent-primary"
                            title="全选当页"
                          />
                        </th>
                        <th className="px-2 py-2 text-left font-medium">DATAID</th>
                        <th className="w-28 px-2 py-2 text-left font-medium">GROUP</th>
                        <th className="w-16 px-2 py-2 text-left font-medium">应用</th>
                        <th className="w-16 px-2 pr-3 py-2 text-left font-medium">格式</th>
                      </tr>
                    </thead>
                    <tbody>
                      {configs.items.map((item) => {
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
                                <Icon name="file" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
          {!leftCollapsed && (
            <div
              onPointerDown={onSplitDown}
              className="group relative w-1 shrink-0 cursor-col-resize bg-background"
              title="拖拽调节左右宽度"
              onDoubleClick={() => setLeftPct(42)}
            >
              <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary/70" />
            </div>
          )}

          {/* —— 右：配置详情 —— */}
          <div className="flex min-w-0 flex-1 flex-col bg-background">
            {/* 空态：选择或新建配置 */}
            {mode === 'view' && (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
                <Icon name="file" className="h-8 w-8 opacity-40" />
                <span className="text-[12px]">在左侧选择一条配置，或点「+」新建</span>
              </div>
            )}

            {(mode === 'edit' || mode === 'new') && (
              <>
                {/* 详情头：dataId + 命名空间/GROUP 副标题 + 已发布徽标 */}
                <div className="shrink-0 border-b border-border px-4 pb-2 pt-3">
                  <div className="flex items-center gap-2">
                    <Icon name="file" className="h-4 w-4 shrink-0 text-muted-foreground" />
                    {mode === 'new' ? (
                      <input
                        value={edDataId}
                        autoFocus
                        onChange={(e) => {
                          setEdDataId(e.target.value);
                          setEdType(inferType(e.target.value));
                          setEdDirty(true);
                        }}
                        placeholder="dataId，如 application.yml"
                        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 font-mono text-[13px] font-semibold text-foreground outline-none focus:border-primary"
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate font-mono text-[14px] font-semibold text-foreground" title={edDataId}>
                        {edDataId}
                      </span>
                    )}
                    <span className={`flex shrink-0 items-center gap-1 text-[11px] ${edDirty ? 'text-warning' : 'text-success'}`}>
                      {edDirty ? <Icon name="warning-2" className="h-3.5 w-3.5" /> : <Icon name="checkCircle" className="h-3.5 w-3.5" />}
                      {edDirty ? '未发布' : '已发布'}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>{nsLabel}</span>
                    <span className="text-muted-foreground/50">/</span>
                    {mode === 'new' ? (
                      <input
                        value={edGroup}
                        onChange={(e) => {
                          setEdGroup(e.target.value);
                          setEdDirty(true);
                        }}
                        placeholder="GROUP"
                        className="w-44 rounded-md border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:border-primary"
                      />
                    ) : (
                      <span className="truncate font-mono">{edGroup}</span>
                    )}
                  </div>
                </div>

                {/* 高级配置折叠区（对齐参考实现，展示当前配置元信息） */}
                <button
                  onClick={() => setAdvOpen((v) => !v)}
                  className="flex h-9 w-full shrink-0 items-center gap-1.5 border-b border-border px-4 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="展开查看配置元信息"
                >
                  <Icon
                    name="chevronRight-2"
                    className={`h-3 w-3 transition-transform ${advOpen ? 'rotate-90' : ''}`}
                  />
                  高级配置
                </button>
                {advOpen && (
                  <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1.5 border-b border-border px-4 py-2.5 text-[11.5px]">
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">命名空间</span>
                      <span className="truncate text-foreground/90">{nsLabel}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">GROUP</span>
                      <span className="truncate font-mono text-foreground/90">{edGroup}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">配置格式</span>
                      <span className="uppercase text-foreground/90">{edType}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-muted-foreground">归属应用</span>
                      <span className="truncate text-foreground/90">{selected?.appName || '—'}</span>
                    </div>
                  </div>
                )}

                {/* 配置内容标题行：格式 chips + 右侧复制 */}
                <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2">
                  <span className="mr-0.5 text-[11px] text-muted-foreground">配置内容</span>
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {FORMAT_CHIPS.map((chip) => {
                      const active = chipActive(chip, edType);
                      return (
                        <button
                          key={chip}
                          onClick={() => {
                            if (chipType(chip) === edType) return;
                            setEdType(chipType(chip));
                            setEdDirty(true);
                          }}
                          className={`shrink-0 rounded-md px-2.5 py-0.5 text-[10.5px] transition-colors ${
                            active ? 'bg-primary font-medium text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                          }`}
                          title={`按 ${chip} 语法高亮`}
                        >
                          {chip}
                        </button>
                      );
                    })}
                  </div>
                  <button onClick={() => void copyContent()} className={`${actionBtn} ml-auto shrink-0`} title="复制配置内容">
                    <Icon name="copy" className="h-3 w-3" />
                    复制
                  </button>
                </div>

                {/* 操作行：复制 · 导出 · 历史 · 另存为 | 校验 · 保存 · 删除 */}
                <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-4">
                  <button onClick={() => void copyContent()} className={actionBtn} title="复制配置内容">
                    <Icon name="copy" className="h-3 w-3" />
                    复制
                  </button>
                  <button onClick={exportCurrent} className={actionBtn} title="导出配置为本地文件">
                    <Icon name="arrowDown" className="h-3 w-3" />
                    导出
                  </button>
                  <button onClick={() => showToast('历史版本功能开发中', false)} className={actionBtn} title="查看历史版本">
                    <Icon name="history" className="h-3 w-3" />
                    历史
                  </button>
                  <button onClick={saveAs} className={actionBtn} title="另存为本地文件">
                    <Icon name="save" className="h-3 w-3" />
                    另存为
                  </button>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button onClick={validateContent} className={actionBtn} title="校验当前内容语法">
                      <Icon name="check-2" className="h-3 w-3" />
                      校验
                    </button>
                    <Button
                      size="sm"
                      className="h-7"
                      onClick={() => void publish()}
                      disabled={saving}
                      title="保存并发布配置"
                    >
                      <Icon name="save" className="h-3 w-3" />
                      {saving ? '保存中…' : '保存'}
                    </Button>
                    {mode === 'edit' && selected && (
                      <button
                        onClick={() => void removeConfig()}
                        disabled={saving}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                        title="删除配置"
                      >
                        <Icon name="trash" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* 错误提示 */}
                {detailError && (
                  <div className="shrink-0 px-4 pt-2">
                    <InlineError text={detailError} tone="prod" />
                  </div>
                )}

                {/* 编辑器：CodeMirror 6（行号 + 折叠箭头 + 按格式自动语法高亮） */}
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  {detailLoading ? (
                    <div className="flex-1 p-4">
                      <Loading text="读取配置内容…" />
                    </div>
                  ) : (
                    <NacosConfigEditor
                      value={edContent}
                      type={edType}
                      dataId={edDataId}
                      onChange={(v) => {
                        setEdContent(v);
                        setEdDirty(true);
                      }}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
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
