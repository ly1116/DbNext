import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { decodeQrFromImage, looksLikeBase32Secret, parseOtpauthUri } from '../../utils/otpQr';
import type { OtpAlgorithm, OtpEntryView, OtpPreview } from '@shared/types';

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
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-6" onMouseDown={onClose}>
      <div
        className={`flex max-h-full w-[520px] flex-col overflow-hidden rounded-xl border bg-panel shadow-2xl transition-colors ${
          dragOver ? 'border-accent' : 'border-line2'
        }`}
        onMouseDown={(e) => e.stopPropagation()}
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
        <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
          <span className="text-[13px] font-medium text-fg">OTP 条目（双因素认证）</span>
          <button onClick={onClose} className="ml-auto rounded p-1 text-dim hover:bg-panel3 hover:text-fg" title="关闭">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          {editing ? (
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-right text-[11px] text-dim">名称</span>
                <input
                  value={editing.label}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                  className="ipt w-full flex-1"
                  placeholder="请输入名称"
                  autoFocus
                />
              </label>
              <label className="flex items-start gap-3">
                <span className="w-16 shrink-0 pt-1.5 text-right text-[11px] text-dim">密钥</span>
                <textarea
                  value={editing.secret}
                  onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                  className="ipt h-16 w-full flex-1 font-mono"
                  placeholder={editing.id ? '留空则沿用已存密钥' : 'Base32 密钥，如 JBSWY3DPEHPK3PXP'}
                  spellCheck={false}
                />
              </label>
              <label className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-right text-[11px] text-dim">算法</span>
                <select
                  value={editing.algorithm}
                  onChange={(e) => setEditing({ ...editing, algorithm: e.target.value as OtpAlgorithm })}
                  className="ipt w-24"
                >
                  <option value="sha1">SHA1</option>
                  <option value="sha256">SHA256</option>
                  <option value="sha512">SHA512</option>
                </select>
                <select
                  value={editing.digits}
                  onChange={(e) => setEditing({ ...editing, digits: Number(e.target.value) as 6 | 8 })}
                  className="ipt w-20"
                >
                  <option value={6}>6 位</option>
                  <option value={8}>8 位</option>
                </select>
                <span className="text-[11px] text-dim">周期</span>
                <input
                  type="number"
                  value={editing.period}
                  onChange={(e) => setEditing({ ...editing, period: Number(e.target.value) || 30 })}
                  className="ipt w-16"
                />
                <span className="text-[11px] text-dim">秒</span>
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setEditing(null)} className="rounded px-3 py-1.5 text-[12px] text-dim hover:text-fg">
                  取消
                </button>
                <button
                  onClick={() => void save()}
                  disabled={busy}
                  className="rounded bg-accent px-4 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  保存条目
                </button>
              </div>
            </div>
          ) : (
            <>
              {views.length === 0 && (
                <p className="py-4 text-center text-[12px] text-dim2">
                  还没有 OTP 条目。可手动录入 Base32 密钥，或用<strong className="text-dim">扫码导入</strong>
                  （截图后 Ctrl+V 粘贴、拖拽图片、或点击按钮选择图片）。
                </p>
              )}
              {views.map((v) => (
                <div
                  key={v.id}
                  className={`mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 ${
                    previewId === v.id ? 'border-accent/60' : 'border-line'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-fg">{v.label}</div>
                    <div className="text-[11px] text-dim">
                      TOTP · {(v.algorithm ?? 'sha1').toUpperCase()} · {v.digits ?? 6} 位 · {v.period ?? 30}s
                    </div>
                  </div>
                  {previewId === v.id && preview && (
                    <div className="text-right">
                      <div className="font-mono text-[15px] tracking-widest text-accent">{preview.code}</div>
                      <div className="text-[10px] text-dim">{preview.secondsRemaining}s 后刷新</div>
                    </div>
                  )}
                  <button
                    onClick={() => setPreviewId(previewId === v.id ? null : v.id)}
                    className="rounded p-1 text-dim hover:bg-panel3 hover:text-fg"
                    title="预览当前验证码"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                  </button>
                  <button
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
                    className="rounded p-1 text-dim hover:bg-panel3 hover:text-fg"
                    title="编辑"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                    </svg>
                  </button>
                  <button onClick={() => void remove(v)} className="rounded p-1 text-dim hover:bg-panel3 hover:text-prod" title="删除">
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
                      <path d="M3 6h18M8 6V4h8v2m-9 0l1 14h8l1-14" />
                    </svg>
                  </button>
                </div>
              ))}
              <div className="mt-1 flex gap-2">
                <button
                  onClick={() => setEditing({ ...EMPTY_FORM })}
                  className="min-w-0 flex-1 rounded-lg border border-dashed border-line2 py-2 text-[12px] text-dim hover:border-accent hover:text-fg"
                >
                  ＋ 新增 OTP 条目
                </button>
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={scanning}
                  className="min-w-0 flex-1 rounded-lg border border-dashed border-line2 py-2 text-[12px] text-dim hover:border-accent hover:text-fg disabled:opacity-50"
                  title="从 otpauth:// 二维码图片导入（也支持 Ctrl+V 粘贴截图 / 拖拽图片到窗口）"
                >
                  {scanning ? '识别中…' : '扫码导入'}
                </button>
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
          {scanTip && <p className="pt-2 text-[11px] text-ok">{scanTip}</p>}
          {err && <p className="pt-2 text-[11px] text-prod">{err}</p>}
        </div>
      </div>
    </div>
  );
}
