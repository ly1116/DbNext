import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { usePrefs } from '@renderer/store/prefsStore';
import type { AiModelConfig, AiSettings, GeneralPrefs, ThemeName, UpdateStatus } from '@shared/types';
import { CloudSyncPane } from './CloudSyncPane';
import { cn } from '@renderer/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Switch } from '@renderer/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@renderer/components/ui/select';

/**
 * 设置弹窗（模态，非页面跳转）—— shadcn Dialog + 左侧分类 + 右侧表单。
 *
 * 提交模型（用户明确要求「不要自动保存」）：所有修改先**暂存**在本地草稿，
 * 点击「应用」或「应用并关闭」才写回主进程持久化并生效；点击「关闭」丢弃未提交改动。
 * 因此主题 / 字号 / 配色等不再实时预览，需点「应用」后才生效。
 *
 * 分类：系统（常规/外观）/ AI 助手（模型管理）/ 数据库 / SSH / 同步（导入导出）。
 *
 * @since 0.1.0
 */
type Category = 'general' | 'ai' | 'db' | 'ssh' | 'sync' | 'about';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'general', label: '系统' },
  { id: 'ai', label: 'AI 助手' },
  { id: 'db', label: '数据库' },
  { id: 'ssh', label: 'SSH' },
  { id: 'sync', label: '同步' },
  { id: 'about', label: '关于' },
];

/* ———————————————————————— 草稿上下文（暂存式提交） ———————————————————————— */

interface SettingsDraft {
  general: GeneralPrefs;
  setGeneral: (patch: Partial<GeneralPrefs>) => void;
  ai: AiSettings | null;
  setAi: (next: AiSettings) => void;
}

const DraftCtx = createContext<SettingsDraft | null>(null);

function useSettingsDraft(): SettingsDraft {
  const v = useContext(DraftCtx);
  if (!v) throw new Error('useSettingsDraft 必须在 SettingsModal 内使用');
  return v;
}

/**
 * 偏好读写：返回当前**草稿**（非已生效偏好）。表单 onChange 只改草稿，不写回主进程；
 * 由弹窗底部「应用 / 应用并关闭」统一提交。
 */
function usePrefsForm(): [GeneralPrefs, (patch: Partial<GeneralPrefs>) => void] {
  const { general, setGeneral } = useSettingsDraft();
  return [general, setGeneral];
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cat, setCat] = useState<Category>('general');

  // 打开时快照当前已生效偏好作为草稿初值与基线
  const initial = usePrefs.getState().prefs;
  const [generalDraft, setGeneralDraft] = useState<GeneralPrefs>(initial);
  const [aiDraft, setAiDraft] = useState<AiSettings | null>(null);
  // 上次提交（或打开）时的基线，用于计算「是否有未提交改动」
  const [baseline, setBaseline] = useState<{ general: GeneralPrefs; ai: AiSettings | null }>({ general: initial, ai: null });

  // AI 设置单独走 api（与通用偏好不同的持久化通道），同样暂存到草稿
  useEffect(() => {
    let alive = true;
    api
      .getAiSettings()
      .then((s) => {
        if (!alive) return;
        setAiDraft(s);
        setBaseline((b) => ({ ...b, ai: s }));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const setGeneral = (p: Partial<GeneralPrefs>) => setGeneralDraft((d) => ({ ...d, ...p }));

  const dirty = useMemo(() => {
    if (JSON.stringify(generalDraft) !== JSON.stringify(baseline.general)) return true;
    if (JSON.stringify(aiDraft) !== JSON.stringify(baseline.ai)) return true;
    return false;
  }, [generalDraft, aiDraft, baseline]);

  /** 提交草稿：通用偏好走 store.patch（落盘 + 即时应用主题/缩放），AI 设置走 api */
  const commit = async () => {
    usePrefs.getState().patch(generalDraft);
    if (aiDraft) await api.setAiSettings(aiDraft);
    setBaseline({ general: generalDraft, ai: aiDraft });
  };

  const applyAndStay = () => void commit();
  const applyAndClose = async () => {
    await commit();
    onClose();
  };

  const draftValue: SettingsDraft = { general: generalDraft, setGeneral, ai: aiDraft, setAi: setAiDraft };

  return (
    <DraftCtx.Provider value={draftValue}>
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        {/* 固定高度：不随各分类内容多少变化；内容超出时仅右侧表单区滚动 */}
        <DialogContent className="flex h-[min(640px,90vh)] max-w-[780px] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
            <DialogTitle className="text-[length:var(--fs-body)]">设置</DialogTitle>
            <DialogDescription className="text-[length:var(--fs-caption)]">修改需点击「应用」或「应用并关闭」后生效</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1">
            {/* 左侧分类导航 */}
            <div className="flex w-[148px] shrink-0 flex-col overflow-y-auto border-r border-border bg-muted py-2">
              <div className="px-4 pb-2 pt-1 text-[length:var(--fs-body)] font-medium text-foreground">设置</div>
              {CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setCat(c.id)}
                  className={`mx-2 flex items-center rounded-md px-3 py-1.5 text-left text-[12px] transition-colors ${
                    cat === c.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/* 右侧表单区（随分类切换） */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {cat === 'general' && <GeneralPane />}
              {cat === 'ai' && <AiSettingsPane />}
              {cat === 'db' && <DbPane />}
              {cat === 'ssh' && <SshPane />}
              {cat === 'sync' && <CloudSyncPane />}
              {cat === 'about' && <AboutPane />}
            </div>
          </div>

          {/* 底部操作栏：右下角（关闭 / 应用 / 应用并关闭） */}
          <div className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-border px-4">
            <Button variant="ghost" size="sm" onClick={onClose}>
              关闭
            </Button>
            <Button variant="outline" size="sm" disabled={!dirty} onClick={applyAndStay}>
              应用
            </Button>
            <Button variant="default" size="sm" disabled={!dirty} onClick={applyAndClose}>
              应用并关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DraftCtx.Provider>
  );
}

/* ———————————————————————— 系统：常规 + 外观 ———————————————————————— */
function GeneralPane() {
  const [prefs, patch] = usePrefsForm();

  return (
    <div className="max-w-[460px] space-y-3.5 text-[12px]">
      <Row label="默认终端">
        <Sel
          value={prefs.defaultShell}
          onValueChange={(v) => patch({ defaultShell: v as GeneralPrefs['defaultShell'] })}
          options={[
            ['bash', 'bash'],
            ['zsh', 'zsh'],
            ['sh', 'sh'],
            ['powershell', 'powershell'],
          ]}
        />
      </Row>
      <Row label="启动时确认连接">
        <Tog checked={prefs.confirmOnStartup} onChange={(v) => patch({ confirmOnStartup: v })} />
      </Row>
      <Row label="关闭时最小化到托盘">
        <Tog
          checked={prefs.closeToTray}
          onChange={(v) => patch({ closeToTray: v })}
          hint="点关闭隐藏到系统托盘，连接后台保持；从托盘菜单「退出」才真正关闭"
        />
      </Row>
      <Row label="查询自动保存间隔（秒）">
        <NumInput value={prefs.autoSaveIntervalSec} min={0} max={600} onChange={(v) => patch({ autoSaveIntervalSec: v })} hint="0 = 关闭" />
      </Row>
      <Row label="会话保留（分钟）">
        <NumInput value={prefs.sessionRetentionMin} min={0} max={10080} onChange={(v) => patch({ sessionRetentionMin: v })} hint="0 = 不保留历史" />
      </Row>

      <Divider />
      <div className="text-[11px] font-medium text-muted-foreground">终端体验</div>
      <Row label="回滚行数">
        <NumInput value={prefs.terminalScrollback} min={200} max={100000} onChange={(v) => patch({ terminalScrollback: v })} hint="可回看的历史行数" />
      </Row>
      <Row label="光标样式">
        <Sel
          value={prefs.cursorStyle}
          onValueChange={(v) => patch({ cursorStyle: v as GeneralPrefs['cursorStyle'] })}
          options={[
            ['block', '方块'],
            ['bar', '竖线'],
            ['underline', '下划线'],
          ]}
        />
      </Row>
      <Row label="光标闪烁">
        <Tog checked={prefs.cursorBlink} onChange={(v) => patch({ cursorBlink: v })} />
      </Row>
      <Row label="选中即复制">
        <Tog checked={prefs.copyOnSelect} onChange={(v) => patch({ copyOnSelect: v })} hint="松开鼠标自动写入剪贴板" />
      </Row>
      <Row label="右键直接粘贴">
        <Tog checked={prefs.rightClickPaste} onChange={(v) => patch({ rightClickPaste: v })} hint="关闭 = 右键弹复制/粘贴菜单" />
      </Row>
      <Row label="断线自动重连">
        <Tog checked={prefs.autoReconnect} onChange={(v) => patch({ autoReconnect: v })} hint="连接恢复后自动重开终端" />
      </Row>

      <Divider />
      <div className="text-[11px] font-medium text-muted-foreground">外观</div>
      <Row label="界面缩放">
        <NumInput
          value={Math.round(prefs.zoomFactor * 100)}
          min={90}
          max={150}
          onChange={(v) => patch({ zoomFactor: v / 100 })}
          hint="百分比，应用后生效"
        />
      </Row>
      <Row label="字体大小">
        <NumInput value={prefs.fontSize} min={10} max={24} onChange={(v) => patch({ fontSize: v })} />
      </Row>
      <Row label="配色方案">
        <Sel
          value={prefs.theme}
          onValueChange={(v) => patch({ theme: v as ThemeName })}
          options={[
            ['darcula', '深色（Darcula）'],
            ['light', '浅色（白）'],
            ['glass', '玻璃拟态（Glass）'],
          ]}
        />
      </Row>
    </div>
  );
}

/* ———————————————————————— AI 助手：默认模型 + 模型管理 ———————————————————————— */
function AiSettingsPane() {
  const { ai, setAi } = useSettingsDraft();
  const [prefs, patch] = usePrefsForm();
  const [msg, setMsg] = useState<string | null>(null);
  /** 正在编辑的模型（null=未打开编辑器；'new'=新增；否则为模型 id） */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiModelConfig | null>(null);

  if (!ai) return <div className="text-[12px] text-muted-foreground">加载中…</div>;
  const s = ai;

  /** 暂存一次 AI 设置改动（不立即持久化，等弹窗底部「应用」） */
  const save = (next: AiSettings) => {
    setAi(next);
    setEditing(null);
    setDraft(null);
  };

  /** 打开「新增模型」编辑器 */
  const openNew = () =>
    setDraft({ id: `m-${Date.now().toString(36)}`, name: '', baseURL: 'https://api.openai.com/v1', model: '', apiKey: '', isDefault: s.models.length === 0 });

  /** 打开「编辑」编辑器 */
  const openEdit = (id: string) => {
    const m = s.models.find((x) => x.id === id);
    if (m) {
      setDraft({ ...m });
      setEditing(id);
    }
  };

  /** 提交编辑器（新增或更新） */
  const submitEdit = () => {
    if (!draft || !draft.name.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
      setMsg('请填写名称、模型 ID 与 API Key');
      return;
    }
    let models = s.models.slice();
    if (editing === 'new' || !s.models.some((x) => x.id === draft.id)) {
      models.push(draft);
    } else {
      models = models.map((x) => (x.id === draft.id ? draft : x));
    }
    // 若勾选默认，确保仅该条为默认
    if (draft.isDefault) models = models.map((x) => ({ ...x, isDefault: x.id === draft.id }));
    save({ ...s, models });
  };

  /** 设为默认 */
  const makeDefault = (id: string) => save({ ...s, models: s.models.map((x) => ({ ...x, isDefault: x.id === id })) });

  /** 删除模型 */
  const remove = (id: string) => save({ ...s, models: s.models.filter((x) => x.id !== id) });

  return (
    <div className="max-w-[520px] space-y-3 text-[12px]">
      <Row label="默认模型">
        <Sel
          className="w-[260px]"
          value={prefs.defaultModelId || '__follow__'}
          onValueChange={(v) => patch({ defaultModelId: v === '__follow__' ? '' : v })}
          options={[
            ['__follow__', '跟随模型列表中的默认标记'],
            ...s.models.map((m) => [m.id, m.name || m.model] as [string, string]),
          ]}
        />
      </Row>

      {/* 模型列表 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">自定义模型（{s.models.length}）</span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={openNew}>
            + 新增模型
          </Button>
        </div>
        {s.models.length === 0 && (
          <div className="rounded border border-dashed border-border px-3 py-4 text-center text-[11px] text-muted-foreground">
            还没有配置任何模型。点击「+ 新增模型」添加 OpenAI 兼容的接口（如 GPT / 自建 Qwen 网关）。
          </div>
        )}
        {s.models.map((m) => (
          <div key={m.id} className="rounded border border-border bg-background px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{m.name || '(未命名)'}</span>
              {m.isDefault && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">默认</span>}
              <div className="ml-auto flex items-center gap-2 text-[11px]">
                {!m.isDefault && (
                  <button onClick={() => makeDefault(m.id)} className="text-muted-foreground hover:text-foreground">设为默认</button>
                )}
                <button onClick={() => openEdit(m.id)} className="text-muted-foreground hover:text-foreground">编辑</button>
                <button onClick={() => remove(m.id)} className="text-destructive hover:underline">删除</button>
              </div>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{m.model} · {m.baseURL}</div>
          </div>
        ))}
      </div>

      {/* 新增/编辑编辑器 */}
      {draft && (
        <div className="space-y-2 rounded border border-border bg-background p-3">
          <div className="text-[11px] font-medium text-foreground">{editing === 'new' ? '新增模型' : '编辑模型'}</div>
          <Field label="名称">
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-8 text-[12px]" placeholder="如 GPT-4o / 自建 Qwen-32B" />
          </Field>
          <Field label="接口地址">
            <Input value={draft.baseURL} onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} className="h-8 text-[12px]" placeholder="https://api.openai.com/v1" />
          </Field>
          <Field label="模型 ID">
            <Input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} className="h-8 text-[12px]" placeholder="gpt-4o-mini" />
          </Field>
          <Field label="API Key">
            <Input type="password" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} className="h-8 text-[12px]" placeholder="sk-…（保存后加密落盘）" />
          </Field>
          <div className="flex items-center gap-2">
            <Switch id="mdl-default" checked={draft.isDefault} onCheckedChange={(v) => setDraft({ ...draft, isDefault: v })} />
            <label htmlFor="mdl-default" className="cursor-pointer text-[12px] text-muted-foreground">设为默认模型（对话默认使用）</label>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" className="h-7 text-[11px]" onClick={submitEdit} disabled={false}>保存</Button>
            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => { setEditing(null); setDraft(null); }}>取消</Button>
          </div>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        兼容任何 OpenAI 格式接口（含自建网关）。每条模型的 Key 仅存储在本机加密配置中，不会随连接导出文件外泄。
      </p>
      {msg && <div className="text-[11px] text-muted-foreground">{msg}</div>}
    </div>
  );
}

/* ———————————————————————— 数据库：安全偏好 + SQL 编辑器 ———————————————————————— */
function DbPane() {
  const [prefs, patch] = usePrefsForm();

  return (
    <div className="max-w-[460px] space-y-3.5 text-[12px]">
      <Row label="只读模式">
        <Tog checked={prefs.readOnlyMode} onChange={(v) => patch({ readOnlyMode: v })} />
        <span className="text-[10px] text-muted-foreground">开启后查询页禁止执行非查询语句</span>
      </Row>
      <Row label="危险 SQL 确认">
        <Tog checked={prefs.dangerousSqlConfirm} onChange={(v) => patch({ dangerousSqlConfirm: v })} />
        <span className="text-[10px] text-muted-foreground">无 WHERE 的 UPDATE/DELETE、DROP/TRUNCATE 先确认</span>
      </Row>
      <Row label="结果集行数上限">
        <NumInput value={prefs.maxResultRows} min={0} max={100000} onChange={(v) => patch({ maxResultRows: v })} hint="0 = 不限制" />
      </Row>
      <Row label="查询超时（秒）">
        <NumInput value={prefs.queryTimeoutSec} min={0} max={600} onChange={(v) => patch({ queryTimeoutSec: v })} hint="0 = 不限制" />
      </Row>

      <Divider />
      <div className="text-[11px] font-medium text-muted-foreground">SQL 编辑器</div>
      <Row label="自动补全">
        <Tog checked={prefs.sqlAutoComplete} onChange={(v) => patch({ sqlAutoComplete: v })} hint="关键字 + 表/列名提示" />
      </Row>
      <Row label="关键字大写">
        <Tog checked={prefs.sqlUppercaseKeywords} onChange={(v) => patch({ sqlUppercaseKeywords: v })} />
      </Row>
      <Row label="AI 上下文表数">
        <NumInput value={prefs.aiContextTables} min={5} max={200} onChange={(v) => patch({ aiContextTables: v })} hint="@ai 附带的表清单上限，控制 token 消耗" />
      </Row>
    </div>
  );
}

/* ———————————————————————— SSH ———————————————————————— */
function SshPane() {
  const [prefs, patch] = usePrefsForm();

  return (
    <div className="max-w-[460px] space-y-3.5 text-[12px]">
      <Row label="默认 SFTP 目录">
        <Input
          value={prefs.defaultSftpDir}
          onChange={(e) => patch({ defaultSftpDir: e.target.value })}
          className="h-8 text-[12px]"
          placeholder="/root"
        />
      </Row>
      <Row label="默认命令目录">
        <Input
          value={prefs.defaultCmdDir}
          onChange={(e) => patch({ defaultCmdDir: e.target.value })}
          className="h-8 text-[12px]"
          placeholder="/"
        />
      </Row>

      <Divider />
      <div className="text-[11px] font-medium text-muted-foreground">连接调优</div>
      <Row label="连接超时（秒）">
        <NumInput value={prefs.sshConnectTimeoutSec} min={1} max={120} onChange={(v) => patch({ sshConnectTimeoutSec: v })} hint="下次连接生效" />
      </Row>
      <Row label="KeepAlive 间隔（秒）">
        <NumInput value={prefs.sshKeepaliveIntervalSec} min={0} max={300} onChange={(v) => patch({ sshKeepaliveIntervalSec: v })} hint="0 = 关闭；防止 NAT/防火墙掐线" />
      </Row>
      <Row label="默认私钥路径">
        <Input
          value={prefs.sshDefaultPrivateKey}
          onChange={(e) => patch({ sshDefaultPrivateKey: e.target.value })}
          className="h-8 text-[12px]"
          placeholder="如 C:\Users\me\.ssh\id_rsa 或 ~/.ssh/id_rsa"
        />
        <span className="text-[10px] text-muted-foreground">连接未内置私钥时回退读取该文件</span>
      </Row>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        新开 SSH / SFTP 会话时以此为初始路径。终端字体大小与配色方案在「系统 → 外观」中调整。
      </p>
    </div>
  );
}

/* ———————————————————————— 关于 / 自动更新 ———————————————————————— */
function AboutPane() {
  const [version, setVersion] = useState<string>('…');
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getVersion().then(setVersion).catch(() => setVersion('未知'));
    const off = api.onUpdateStatus(setStatus);
    // 打开即检查一次，确保面板反映当前最新状态
    api.checkUpdate();
    return off;
  }, []);

  /** 把 releaseNotes 压成可读文本 */
  const notesText = (notes: string | Array<{ version: string; notes: string }> | undefined): string => {
    if (!notes) return '';
    if (typeof notes === 'string') return notes;
    return notes.map((n) => `## ${n.version}\n${n.notes}`).join('\n\n');
  };

  const checking = status?.type === 'checking';
  const available = status?.type === 'available' ? status : null;
  const progress = status?.type === 'progress' ? status : null;
  const downloaded = status?.type === 'downloaded' ? status : null;
  const notAvail = status?.type === 'not-available' ? status : null;
  const err = status?.type === 'error' ? status : null;

  return (
    <div className="max-w-[480px] space-y-3.5 text-[12px]">
      <Row label="当前版本">
        <span className="font-medium text-foreground">DataRoost v{version}</span>
      </Row>

      <Row label="检查更新">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() => {
            setBusy(true);
            setStatus({ type: 'checking' });
            api.checkUpdate();
            setTimeout(() => setBusy(false), 1500);
          }}
          disabled={busy || checking}
        >
          {checking ? '检查中…' : '立即检查'}
        </Button>
      </Row>

      {/* 更新状态区 */}
      <div className="min-h-[64px] rounded border border-border bg-background p-3 text-[11px] leading-relaxed">
        {checking && <span className="text-muted-foreground">正在检查更新…</span>}
        {notAvail && <span className="text-muted-foreground">已是最新版本（v{notAvail.version}）。</span>}
        {available && (
          <div className="space-y-2">
            <div className="text-foreground">
              发现新版本 <span className="font-medium text-primary">v{available.version}</span>，后台下载中…
            </div>
            {available.releaseNotes && (
              <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap rounded bg-background p-2 text-[10px] text-muted-foreground">
                {notesText(available.releaseNotes)}
              </pre>
            )}
          </div>
        )}
        {progress && (
          <div className="space-y-1">
            <div className="text-foreground">下载更新中：{progress.percent.toFixed(0)}%</div>
            <div className="h-1.5 w-full overflow-hidden rounded bg-border">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, progress.percent)}%` }} />
            </div>
            <div className="text-[10px] text-muted-foreground">
              {(progress.transferred / 1048576).toFixed(1)} / {(progress.total / 1048576).toFixed(1)} MB
            </div>
          </div>
        )}
        {downloaded && (
          <div className="flex items-center gap-3">
            <span className="text-foreground">更新 v{downloaded.version} 已下载完成。</span>
            <Button size="sm" className="h-7 text-[11px]" onClick={() => api.installUpdate()}>
              重启并更新
            </Button>
          </div>
        )}
        {err && (
          <div className="space-y-1.5">
            <div className="text-destructive">更新检查失败：{err.message}</div>
            {err.fallbackUrl && (
              <a
                href={err.fallbackUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-primary underline hover:opacity-80"
              >
                前往 GitHub Releases 手动下载
              </a>
            )}
            <div className="text-[10px] text-muted-foreground">
              提示：若仓库为私有，需在主进程启动时设置 GH_TOKEN 环境变量；未签名构建（当前 Windows/macOS）安装会触发系统拦截，可手动下载安装包覆盖安装。
            </div>
          </div>
        )}
        {!status && <span className="text-muted-foreground">点击下方「立即检查」或等待启动自动检查。</span>}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        应用启动后会自动检查一次更新。检测到新版本时后台下载，下载完成后点击「重启并更新」即可一键升级（Linux AppImage 支持静默安装；Windows/macOS 未签名时会跳转发布页手动安装）。
      </p>
    </div>
  );
}

/* ———————————————————————— 通用控件 ———————————————————————— */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-4">
      <span className="w-[130px] shrink-0 text-right text-[11px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-border" />;
}

/** shadcn Select 薄封装（options 元组 → SelectItem；宽度随设置行自适应） */
function Sel({
  value,
  onValueChange,
  options,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: [string, string][];
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={cn('h-8 w-[200px] text-[12px]', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>{l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** shadcn Switch 薄封装（含右侧提示小字） */
function Tog({ checked, onChange, hint }: { checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} />
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** 数字输入（带 min/max 钳制，替代旧 NumberInput） */
function NumInput({
  value,
  min,
  max,
  onChange,
  hint,
  className,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)));
        }}
        className="h-8 w-24 text-[12px]"
      />
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  );
}
