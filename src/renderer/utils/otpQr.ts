import type { OtpAlgorithm } from '@shared/types';

/**
 * 解析 otpauth:// 二维码内容（Google Authenticator / Authy / 堡垒机通用格式）：
 *   otpauth://totp/Issuer:account?secret=BASE32&issuer=Issuer&algorithm=SHA1&digits=6&period=30
 *
 * 非法的 otpauth URI 返回 null；secret 缺失视为非法。
 * HOTP 条目会被当作 TOTP 导入（本应用仅支持 TOTP，counter 参数忽略）。
 *
 * @since 0.1.0
 */
export interface OtpauthParsed {
  label: string;
  secret: string;
  algorithm: OtpAlgorithm;
  digits: 6 | 8;
  period: number;
}

/** 提取展示名：优先 issuer 参数，其次「Issuer:account」前缀 */
function extractLabel(pathLabel: string, issuerParam: string | null): string {
  if (issuerParam) return issuerParam.trim();
  // 常见形态：Issuer:account / Issuer: account / Issuer-account
  const m = /^([^:|]+)(?::|\|)/.exec(pathLabel);
  return (m ? m[1] : pathLabel).trim();
}

export function parseOtpauthUri(text: string): OtpauthParsed | null {
  const t = text.trim();
  const m = /^otpauth:\/\/(totp|hotp)\/([^?\s]*)\??(.*)$/i.exec(t);
  if (!m) return null;
  try {
    const label = decodeURIComponent(m[2] ?? '');
    const q = new URLSearchParams(m[3] ?? '');
    const secret = (q.get('secret') ?? '').replace(/\s+/g, '').toUpperCase();
    if (!secret) return null;
    const algRaw = (q.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '');
    const algorithm: OtpAlgorithm = algRaw === 'SHA256' ? 'sha256' : algRaw === 'SHA512' ? 'sha512' : 'sha1';
    const digits: 6 | 8 = Number(q.get('digits')) === 8 ? 8 : 6;
    const p = Number(q.get('period'));
    const period = Number.isFinite(p) && p >= 15 && p <= 120 ? p : 30;
    return {
      label: extractLabel(label, q.get('issuer')) || label || '导入的 OTP 条目',
      secret,
      algorithm,
      digits,
      period,
    };
  } catch {
    return null;
  }
}

/** 是否像一段裸 Base32 密钥（部分堡垒机二维码里直接放密钥文本） */
export function looksLikeBase32Secret(text: string): boolean {
  const t = text.trim().replace(/\s+/g, '');
  return t.length >= 16 && /^[A-Za-z2-7]+=*$/.test(t);
}

/**
 * 从图片（文件 / 剪贴板 blob）中解码二维码文本。
 * 大图等比缩到 1024px 内以加速；黑白反色都尝试（截图可能带反色主题）。
 */
export async function decodeQrFromImage(blob: Blob): Promise<string> {
  const jsQR = (await import('jsqr')).default;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图片加载失败'));
      im.src = url;
    });
    if (!img.width || !img.height) throw new Error('无效图片');
    const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.width * scale));
    cv.height = Math.max(1, Math.round(img.height * scale));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 上下文不可用');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const data = ctx.getImageData(0, 0, cv.width, cv.height);
    const res = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
    if (!res?.data) throw new Error('未能识别出二维码，请使用包含完整二维码的清晰截图');
    return res.data;
  } finally {
    URL.revokeObjectURL(url);
  }
}
