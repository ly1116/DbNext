import type { ClientChannel } from 'ssh2';
import { createLogger } from '../logger';
import { connect, getSsh } from '../clients/manager';
import { getConnection, getOtpEntry } from './connection-store';
import { OTP_PROMPT_RE, totp } from './totp';

/**
 * SSH 终端服务（真实实现）。
 *
 * 通过已建立的 ssh2 连接打开一个 PTY shell 流，渲染端的 xterm 写入键盘输入、
 * 主进程把远端输出经 IPC 推回渲染端。不再有任何 mock 回显。
 *
 * @since 0.1.0
 */
const logger = createLogger('ssh');

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  term?: string;
}

export interface TerminalSession {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  onData: (cb: (chunk: string) => void) => void;
  /** 回放自 shell 打开以来缓冲的全部远端输出（仅触发一次，供渲染端重订阅时补齐首屏） */
  replay: (cb: (chunk: string) => void) => void;
  dispose: () => void;
}

/**
 * 为某条 ssh/bastion 连接创建真实终端会话。
 *
 * 自愈：若主进程里该连接的 SSH 尚未建立（可能因渲染端状态陈旧、连接被服务端
 * 静默断开、或标签在断连后仍残留），则先 await 用已保存凭据自动（重）连一次再开
 * shell，避免「终端所需 SSH 连接未建立」这类误报。
 * @throws 当凭据缺失或确实连不上该主机时
 */
export async function createTerminalSession(connectionId: string, opts: TerminalOptions = {}): Promise<TerminalSession> {
  let ssh = getSsh(connectionId);
  if (!ssh) {
    // 自愈：用已持久化的连接配置重建 SSH（connect 成功后回填 managed 并发状态广播）
    logger.info(`终端会话发现 SSH 未建立，尝试自动重连: ${connectionId}`);
    await connect(connectionId);
    ssh = getSsh(connectionId);
    if (!ssh) {
      throw new Error('终端所需 SSH 连接未建立，请先在连接管理中连上该主机');
    }
  }
  const listeners = new Set<(chunk: string) => void>();
  // 自 shell 打开以来缓冲的全部远端输出：渲染端（StrictMode 双挂载 / 重连 / HMR 重挂载）
  // 在正式订阅前可能漏掉首屏（Last login / MOTD / 提示符），回放此缓冲即可补齐，绝不留白屏。
  // 上限 64KB，超出只保留尾部，避免长会话无限增长内存。
  let backlog = '';
  const BACKLOG_CAP = 1 << 16;
  const shellOpts = {
    term: opts.term ?? 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 30,
  };
  let stream: ClientChannel;

  // —— shell 内动态码自动填入（JumpServer 风格）：部分堡垒机的 MFA 验证码不走
  // keyboard-interactive，而是在登录后的 shell 提示「MFA验证码: / Verification code:」
  // 等待输入。配置了 OTP 自动填入时，监听 shell 输出，识别到「动态码提示且冒号收尾」
  // 即自动计算 TOTP 写入并回车；仅自动填一次（失败回落手动），且仅连接后 90 秒内生效，
  // 避免用户 cat 文件等内容误触发。
  const otpEntry =
    getConnection(connectionId)?.otp?.autoFill && getConnection(connectionId)?.otp?.entryId
      ? getOtpEntry(getConnection(connectionId)!.otp!.entryId)
      : undefined;
  let otpBuf = '';
  let otpFilled = !otpEntry;
  const otpWatchStart = Date.now();
  const detectOtpPrompt = (text: string) => {
    if (otpFilled) return;
    if (Date.now() - otpWatchStart > 90_000) {
      otpFilled = true;
      return;
    }
    otpBuf = (otpBuf + text).slice(-1200);
    if (OTP_PROMPT_RE.test(otpBuf) && /[:：]\s*$/.test(otpBuf.trimEnd())) {
      otpFilled = true;
      const { code } = totp(otpEntry!.secret, {
        algorithm: otpEntry!.algorithm,
        digits: otpEntry!.digits,
        period: otpEntry!.period,
      });
      logger.info(`shell 检测到动态码提示，自动填入 TOTP: ${connectionId}（OTP 条目: ${otpEntry!.label}）`);
      setTimeout(() => {
        try {
          stream?.write(code + '\n');
        } catch {
          /* ignore */
        }
      }, 500);
    }
  };

  const opened = new Promise<void>((resolve, reject) => {
    ssh.shell(shellOpts, (err, ch) => {
      if (err) return reject(new Error(`打开 shell 失败: ${err.message}`));
      stream = ch;
      ch.on('data', (d: Buffer) => {
        const text = d.toString('utf-8');
        backlog += text;
        if (backlog.length > BACKLOG_CAP) backlog = backlog.slice(-BACKLOG_CAP);
        listeners.forEach((cb) => cb(text));
        detectOtpPrompt(text);
      });
      ch.on('close', () => logger.debug(`shell close: ${connectionId}`));
      resolve();
    });
  });
  // shell 是异步打开的，写入需等待；用队列缓冲，就绪后冲刷
  const queue: string[] = [];
  let ready = false;
  opened
    .then(() => {
      ready = true;
      for (const q of queue.splice(0)) if (stream) stream.write(q);
    })
    .catch((e) => logger.error(e.message));

  return {
    write: (data) => {
      if (ready && stream) stream.write(data);
      else queue.push(data);
    },
    resize: (cols, rows) => {
      if (ready && stream) stream.setWindow?.(rows, cols, 0, 0);
    },
    onData: (cb) => listeners.add(cb),
    replay: (cb) => {
      if (backlog) cb(backlog);
    },
    dispose: () => {
      listeners.clear();
      try {
        stream?.end();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 在已建立的 ssh/bastion 连接上**一次性执行**一条命令并取回完整输出。
 *
 * 与交互式 PTY shell 不同：这里用 ssh2 的 exec 通道（非 TTY），输出干净、可解析，
 * 适合给 AI 工具调用 / 脚本化采集（如 df -h、free -m、systemctl 状态等）。
 * 带超时保护（默认 20s），超时杀掉通道并报错。
 *
 * @throws 当该连接 SSH 未建立，或命令执行失败、超时时
 */
export async function execOnSsh(connectionId: string, command: string, timeoutMs = 20000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  let ssh = getSsh(connectionId);
  if (!ssh) {
    // 自愈：凭据仍在则自动重连一次
    logger.info(`exec 发现 SSH 未建立，尝试自动重连: ${connectionId}`);
    await connect(connectionId);
    ssh = getSsh(connectionId);
    if (!ssh) {
      throw new Error('SSH 连接未建立，请先在连接管理中连上该主机');
    }
  }
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        ssh.end();
      } catch {
        /* ignore */
      }
      reject(new Error(`命令执行超时（>${Math.round(timeoutMs / 1000)}s）：${command}`));
    }, timeoutMs);

    ssh.exec(command, { pty: false }, (err, channel) => {
      if (err) {
        clearTimeout(timer);
        return reject(new Error(`执行命令失败: ${err.message}`));
      }
      channel.on('data', (d: Buffer) => (stdout += d.toString('utf-8')));
      channel.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf-8')));
      channel.on('close', (code: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  });
}
