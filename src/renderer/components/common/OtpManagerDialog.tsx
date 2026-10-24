import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { decodeQrFromImage, looksLikeBase32Secret, parseOtpauthUri } from '../../utils/otpQr';
import type { OtpAlgorithm, OtpEntryView, OtpPreview } from '@shared/types';
import { Icon } from '@renderer/components/common/icons';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@renderer/components/ui/select';

/**
 * OTP 动态码条目管理对话框（TOTP 因子库）。
 *
 * 条目的 secret（Base32 密钥）只在主进程加密落盘，渲染端列表为脱敏视图：
 * 编辑已有条目时 secret 留空表示沿用已存密钥（与连接口令同一策略）。
 * 「眼睛」按钮可预览当前验证码 + 倒计时，用于校验密钥录入正确。
 *
 * @since 0.1.0
 */

interface EditForm {
  id?: string;
  label: string;
  secret: string;
  algorithm: OtpAlgorithm;
  digits: 6 | 8;
  period: number;
}

const EMPTY_FORM: EditForm = { label: '', secret: '', algorithm: 'sha1', digits: 6, period: 30 };

export function OtpManagerDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [views, setViews] = useState<OtpEntryView[]>([]);
  const [editing, setEditing] = useState<EditForm | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [preview, setPreview] = useState<OtpPreview | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanTip, setScanTip] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  /** 解码二维码并回填表单：otpauth:// URI → 完整表单；裸 Base32 → 仅密钥 */
  const importFromImage = async (blob: Blob) => {
    setScanning(true);
    setErr('');
    setScanTip('');
    try {
      const text = await decodeQrFromImage(blob);
      const parsed = parseOtpauthUri(text);
      if (parsed) {
        setEditing(parsed);
        setScanTip(`已识别：${parsed.label} · ${parsed.algorithm.toUpperCase()} · ${parsed.digits} 位`);
        return;
      }
      if (looksLikeBase32Secret(text)) {
        setEditing({ ...EMPTY_FORM, secret: text.trim().replace(/\s+/g, '').toUpperCase() });
        setScanTip('二维码里是裸 Base32 密钥，已回填，请补全名称');
        return;
      }
      setErr(`二维码内容不是 OTP 密钥：${text.slice(0, 80)}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  // Ctrl+V 粘贴二维码截图直接导入（对话框内全局监听）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        e.stopPropagation();
        void importFromImage(file);
      }
    };
    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = () => {
    void api
      .otpList()
      .then(setViews)
      .catch((e) => setErr((e as Error).message));
  };

  useEffect(reload, []);

  // 预览当前验证码（每秒向主进程重算一次，含剩余秒数）
  useEffect(() => {
    if (!previewId) {
      setPreview(null);
      return;
    }
    let alive = true;
    const tick = () => {
      void api
        .otpPreview({ entryId: previewId })
        .then((p) => {
          if (alive) setPreview(p);
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [previewId]);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setErr('');
    try {
      await api.otpSave(editing);
      setEditing(null);
      reload();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (v: OtpEntryView) => {
    if (!window.confirm(`删除 OTP 条目「${v.label}」？引用它的连接将回落为手动输入动态码。`)) return;
    try {
      await api.otpDelete(v.id);
      if (previewId === v.id) setPreviewId(null);
      reload();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className={`flex max-h-[85vh] max-w-[560px] flex-col gap-0 overflow-hidden p-0 ${dragOver ? 'border-primary' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragLeave={() => {
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'));
          if (file) void importFromImage(file);
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <DialogTitle className="text-[length:var(--fs-body)]">OTP 条目（双因素认证）</DialogTitle>
          <DialogDescription className="text-[length:var(--fs-caption)]">
            管理 TOTP 双因子条目；密钥仅在本机加密存储，支持 Ctrl+V 粘贴或拖拽二维码图片导入
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          {editing ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">名称</span>
                <Input
                  value={editing.label}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                  className="h-8 flex-1 text-[12px]"
                  placeholder="请输入名称"
                  autoFocus
                />
              </div>
              <div className="flex items-start gap-3">
                <span className="w-16 shrink-0 pt-1.5 text-right text-[11px] text-muted-foreground">密钥</span>
                <textarea
                  value={editing.secret}
                  onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                  className="flex min-h-[64px] w-full flex-1 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-[12px] shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder={editing.id ? '留空则沿用已存密钥' : 'Base32 密钥，如 JBSWY3DPEHPK3PXP'}
                  spellCheck={false}
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground">算法</span>
                <Select
                  value={editing.algorithm}
                  onValueChange={(v) => setEditing({ ...editing, algorithm: v as OtpAlgorithm })}
                >
                  <SelectTrigger className="h-8 w-24 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sha1">SHA1</SelectItem>
                    <SelectItem value="sha256">SHA256</SelectItem>
                    <SelectItem value="sha512">SHA512</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={String(editing.digits)}
                  onValueChange={(v) => setEditing({ ...editing, digits: Number(v) as 6 | 8 })}
                >
                  <SelectTrigger className="h-8 w-20 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="6">6 位</SelectItem>
                    <SelectItem value="8">8 位</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-[11px] text-muted-foreground">周期</span>
                <Input
                  type="number"
                  value={editing.period}
                  onChange={(e) => setEditing({ ...editing, period: Number(e.target.value) || 30 })}
                  className="h-8 w-16 text-[12px]"
                />
                <span className="text-[11px] text-muted-foreground">秒</span>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={() => setEditing(null)}>
                  取消
                </Button>
                <Button size="sm" className="h-8 text-[12px]" onClick={() => void save()} disabled={busy}>
                  保存条目
                </Button>
              </div>
            </div>
          ) : (
            <>
              {views.length === 0 && (
                <p className="py-4 text-center text-[12px] text-muted-foreground">
                  还没有 OTP 条目。可手动录入 Base32 密钥，或用<strong className="text-foreground">扫码导入</strong>
                  （截图后 Ctrl+V 粘贴、拖拽图片、或点击按钮选择图片）。
                </p>
              )}
              {views.map((v) => (
                <div
                  key={v.id}
                  className={`mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 ${
                    previewId === v.id ? 'border-primary/60' : 'border-border'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-foreground">{v.label}</div>
                    <div className="text-[11px] text-muted-foreground">
                      TOTP · {(v.algorithm ?? 'sha1').toUpperCase()} · {v.digits ?? 6} 位 · {v.period ?? 30}s
                    </div>
                  </div>
                  {previewId === v.id && preview && (
                    <div className="text-right">
                      <div className="font-mono text-[15px] tracking-widest text-primary">{preview.code}</div>
                      <div className="text-[10px] text-muted-foreground">{preview.secondsRemaining}s 后刷新</div>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => setPreviewId(previewId === v.id ? null : v.id)}
                    title="预览当前验证码"
                  >
                    <Icon name="eye" className="h-4 w-4" strokeWidth={1.8} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setEditing({
                        id: v.id,
                        label: v.label,
                        secret: '',
                        algorithm: v.algorithm ?? 'sha1',
                        digits: v.digits ?? 6,
                        period: v.period ?? 30,
                      })
                    }
                    title="编辑"
                  >
                    <Icon name="star" className="h-4 w-4" strokeWidth={1.8} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(v)}
                    title="删除"
                  >
                    <Icon name="trash" className="h-4 w-4" strokeWidth={1.8} />
                  </Button>
                </div>
              ))}
              <div className="mt-1 flex gap-2">
                <Button
                  variant="outline"
                  className="min-w-0 flex-1 border-dashed text-[12px] font-normal text-muted-foreground"
                  onClick={() => setEditing({ ...EMPTY_FORM })}
                >
                  ＋ 新增 OTP 条目
                </Button>
                <Button
                  variant="outline"
                  className="min-w-0 flex-1 border-dashed text-[12px] font-normal text-muted-foreground"
                  onClick={() => fileRef.current?.click()}
                  disabled={scanning}
                  title="从 otpauth:// 二维码图片导入（也支持 Ctrl+V 粘贴截图 / 拖拽图片到窗口）"
                >
                  {scanning ? '识别中…' : '扫码导入'}
                </Button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFromImage(f);
                  e.target.value = '';
                }}
              />
            </>
          )}
          {scanTip && <p className="pt-2 text-[11px] text-success">{scanTip}</p>}
          {err && <p className="pt-2 text-[11px] text-destructive">{err}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
