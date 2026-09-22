import { safeStorage } from 'electron';
import { createLogger } from '../logger';

/**
 * 凭据保险箱。
 *
 * 用 `electron.safeStorage` 对敏感字段（口令 / 私钥 / 私钥口令 / AI Key）
 * 做「加密落盘、解密回内存」：磁盘上的连接配置文件只存密文，
 * 渲染进程永远拿不到明文凭据。
 *
 * 若运行环境不支持 safeStorage（如部分 Linux 无桌面密钥环），
 * 退化为「进程内明文 + 文件权限 0600」并告警，绝不把明文写进可被轻易读取的位置之外。
 *
 * @since 0.1.0
 */
const logger = createLogger('vault');

/** 当前运行环境是否支持 safeStorage */
const supported = safeStorage.isEncryptionAvailable();

/** 加密字符串 -> base64 密文 */
export function seal(plain: string): string {
  if (!supported) {
    logger.warn('safeStorage 不可用，凭据将以明文落盘（请确保文件权限受限）');
    return plain;
  }
  const buf = safeStorage.encryptString(plain);
  return buf.toString('base64');
}

/** 解密 base64 密文 -> 明文 */
export function unseal(cipher: string): string {
  if (!supported) return cipher;
  try {
    const buf = Buffer.from(cipher, 'base64');
    return safeStorage.decryptString(buf);
  } catch (err) {
    logger.error(`凭据解密失败: ${(err as Error).message}`);
    return '';
  }
}

/** 是否启用了真实加密 */
export function isEncrypted(): boolean {
  return supported;
}
