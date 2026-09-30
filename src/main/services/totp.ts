import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP 动态验证码（纯 node:crypto 实现，零依赖）。
 *
 * 支持 Google Authenticator / JumpServer / 各类堡垒机使用的标准 TOTP：
 * Base32 密钥 + HMAC-SHA1/256/512 + 动态截断。供 SSH 双因素认证
 * 「自动填入验证码」使用；验证码只在主进程内存中即时计算，不落盘。
 *
 * @since 0.1.0
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32（RFC 4648）解码：忽略空格/连字符/大小写/填充，宽容处理非法字符 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export interface TotpOptions {
  /** 哈希算法（默认 sha1，Google Authenticator / 绝大多数堡垒机用 sha1） */
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** 验证码位数（默认 6） */
  digits?: number;
  /** 时间步长秒（默认 30） */
  period?: number;
  /** 计算时刻（毫秒时间戳；默认当前时间，测试用） */
  at?: number;
}

export interface TotpResult {
  /** 当前验证码（数字字符串，如 '042716'） */
  code: string;
  /** 当前验证码剩余有效秒数 */
  secondsRemaining: number;
}

/** 计算指定时刻的 TOTP 验证码 */
export function totp(secret: string, opts: TotpOptions = {}): TotpResult {
  const algorithm = opts.algorithm ?? 'sha1';
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const nowMs = opts.at ?? Date.now();

  if (!secret.trim()) throw new Error('OTP 密钥为空');
  const key = base32Decode(secret);
  if (!key.length) throw new Error('OTP 密钥不是有效的 Base32 编码');

  const counter = Math.floor(nowMs / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac(algorithm, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  const code = String(bin % 10 ** digits).padStart(digits, '0');
  const secondsRemaining = period - (Math.floor(nowMs / 1000) % period);
  return { code, secondsRemaining };
}

/**
 * OTP 输入提示的特征匹配（多语言，覆盖常见堡垒机/sshd PAM 提示）。
 * 如 "Verification code:"、"Please enter OTP"、"MFA验证码:"、"请输入动态口令"。
 */
export const OTP_PROMPT_RE =
  /(?:otp|one[-\s]?time(?:\s*(?:password|code|token))?|verification\s*code|auth(?:entication)?\s*code|dynamic\s*(?:code|password)|mfa|2fa|双因素|二次(?:验证|认证)|动态(?:码|口令|密码)|验证码)/i;

/** 密码输入提示的特征匹配（keyboard-interactive 先密码后动态码的组合场景） */
export const PASSWORD_PROMPT_RE = /(?:password|passwd|口令|密码)/i;
