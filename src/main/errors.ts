/**
 * 统一应用错误类型。
 *
 * 主进程抛出的业务错误均为此类型，便于 IPC 序列化后渲染进程精确识别 code。
 *
 * @since 0.1.0
 */

/** 错误码枚举（按领域归类，便于渲染端分支处理） */
export type AppErrorCode =
  | 'CONNECTION_FAILED'
  | 'AUTH_REQUIRED'
  | 'SSH_ERROR'
  | 'SFTP_ERROR'
  | 'REDIS_ERROR'
  | 'SQL_ERROR'
  | 'AI_ERROR'
  | 'UNKNOWN';

/** 统一应用错误 */
export class AppError extends Error {
  /** 机器可读错误码 */
  readonly code: AppErrorCode;
  /** 是否建议用户重试 */
  readonly retryable: boolean;

  /**
   * @param code 错误码
   * @param message 人类可读信息
   * @param retryable 是否可重试，默认 false
   */
  constructor(code: AppErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = retryable;
  }

  /** 序列化为可跨 IPC 传输的纯对象 */
  toShape(): { code: AppErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}
