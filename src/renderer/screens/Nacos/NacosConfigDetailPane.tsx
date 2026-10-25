import { Button } from '@renderer/components/ui/button';
import { Icon } from '@renderer/components/common/icons';
import { Loading, InlineError } from '@renderer/components/common/States';
import { NacosConfigEditor } from './NacosConfigEditor';
import { FORMAT_CHIPS, chipActive, chipType, inferType } from './nacosShared';
import type { NacosConfigItem } from '@shared/types';

/**
 * 配置详情 / 编辑面板（Nacos 配置页右栏）。
 *
 * 展示：空态提示 | 详情头（dataId + 命名空间/GROUP + 已发布徽标）+ 高级配置折叠区 +
 * 格式 chips + 操作行（复制 · 导出 · 历史 · 另存为 | 校验 · 保存 · 删除）+ CodeMirror 编辑器。
 *
 * 本组件为纯展示 + 回调：编辑缓冲（edDataId/edGroup/edType/edContent/edDirty）由父组件持有，
 * 这里只负责渲染与把用户操作回抛，方便后续把保存 / 校验 / 导入导出等动作独立复用。
 */
export function NacosConfigDetailPane({
  mode,
  edDataId,
  setEdDataId,
  edGroup,
  setEdGroup,
  edType,
  setEdType,
  edContent,
  setEdContent,
  edDirty,
  setEdDirty,
  advOpen,
  setAdvOpen,
  nsLabel,
  selected,
  detailLoading,
  detailError,
  saving,
  actionBtn,
  onCopy,
  onExport,
  onSaveAs,
  onValidate,
  onPublish,
  onDelete,
  onHistory,
}: {
  /** view = 未选中（空态）；edit = 编辑已有；new = 新建 */
  mode: 'view' | 'edit' | 'new';
  edDataId: string;
  setEdDataId: (v: string) => void;
  edGroup: string;
  setEdGroup: (v: string) => void;
  edType: string;
  setEdType: (v: string) => void;
  edContent: string;
  setEdContent: (v: string) => void;
  edDirty: boolean;
  setEdDirty: (v: boolean) => void;
  advOpen: boolean;
  setAdvOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  /** 当前命名空间的展示名（public / 自定义空间名） */
  nsLabel: string;
  selected: NacosConfigItem | null;
  detailLoading: boolean;
  detailError: string | null;
  saving: boolean;
  /** 操作行按钮样式（与左栏工具条统一由父组件定义） */
  actionBtn: string;
  onCopy: () => void;
  onExport: () => void;
  onSaveAs: () => void;
  onValidate: () => void;
  onPublish: () => void;
  onDelete: () => void;
  /** 打开配置历史弹窗（仅 edit 模式且有选中配置时可用） */
  onHistory: () => void;
}) {
  return (
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
                  <button onClick={() => void onCopy()} className={`${actionBtn} ml-auto shrink-0`} title="复制配置内容">
                    <Icon name="copy" className="h-3 w-3" />
                    复制
                  </button>
                </div>

                {/* 操作行：复制 · 导出 · 历史 · 另存为 | 校验 · 保存 · 删除 */}
                <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-4">
                  <button onClick={() => void onCopy()} className={actionBtn} title="复制配置内容">
                    <Icon name="copy" className="h-3 w-3" />
                    复制
                  </button>
                  <button onClick={onExport} className={actionBtn} title="导出配置为本地文件">
                    <Icon name="arrowDown" className="h-3 w-3" />
                    导出
                  </button>
                  <button onClick={onHistory} className={actionBtn} title="查看历史版本（查看 / 对比 / 回滚）">
                    <Icon name="history" className="h-3 w-3" />
                    历史
                  </button>
                  <button onClick={onSaveAs} className={actionBtn} title="另存为本地文件">
                    <Icon name="save" className="h-3 w-3" />
                    另存为
                  </button>
                  <div className="ml-auto flex items-center gap-1.5">
                    <button onClick={onValidate} className={actionBtn} title="校验当前内容语法">
                      <Icon name="check-2" className="h-3 w-3" />
                      校验
                    </button>
                    <Button
                      size="sm"
                      className="h-7"
                      onClick={() => void onPublish()}
                      disabled={saving}
                      title="保存并发布配置"
                    >
                      <Icon name="save" className="h-3 w-3" />
                      {saving ? '保存中…' : '保存'}
                    </Button>
                    {mode === 'edit' && selected && (
                      <button
                        onClick={() => void onDelete()}
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
  );
}
