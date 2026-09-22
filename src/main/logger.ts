/**
 * 主进程日志工具。
 *
 * 统一前缀 + 分级（debug/info/warn/error），开发期打印到控制台，
 * 生产期可重定向到文件（此处保持控制台输出，足够演示）。
 *
 * @since 0.1.0
 */

const PREFIX = '[DbNest]';

/** 日志级别 */
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, ...args: unknown[]): void {
  const tag = `${PREFIX}[${scope}]`;
  switch (level) {
    case 'debug':
      // 仅在非生产打印 debug
      if (process.env.NODE_ENV !== 'production') console.debug(tag, ...args);
      break;
    case 'info':
      console.info(tag, ...args);
      break;
    case 'warn':
      console.warn(tag, ...args);
      break;
    case 'error':
      console.error(tag, ...args);
      break;
  }
}

/** 创建一个带作用域的 logger */
export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', scope, ...args),
    info: (...args: unknown[]) => emit('info', scope, ...args),
    warn: (...args: unknown[]) => emit('warn', scope, ...args),
    error: (...args: unknown[]) => emit('error', scope, ...args),
  };
}
