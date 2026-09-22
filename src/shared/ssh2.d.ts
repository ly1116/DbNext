/**
 * ssh2 局部类型声明（覆盖本工程实际用到的 API 子集）。
 *
 * 不依赖 @types/ssh2 网络安装：主进程经 esbuild 直接打包 ssh2 运行时，
 * tsc 仅做类型检查，这里声明足矣。如需完整类型，可后续安装 @types/ssh2 并删除本文件。
 *
 * @since 0.1.0
 */
declare module 'ssh2' {
  import { EventEmitter } from 'events';

  /** ssh2.connect 接受的配置（仅列本工程用到的字段，其余透传） */
  export interface ConnectConfig {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout?: number;
    keepaliveInterval?: number;
    [key: string]: unknown;
  }

  /** sftp 子系统句柄（覆盖本工程用到的文件操作） */
  export interface SFTPWrapper {
    readdir(path: string, cb: (err: Error | undefined, list: Array<Record<string, unknown>>) => void): void;
    stat(path: string, cb: (err: Error | undefined, attrs: Record<string, unknown>) => void): void;
    mkdir(path: string, attrs?: unknown, cb: (err?: Error) => void): void;
    rmdir(path: string, cb: (err?: Error) => void): void;
    unlink(path: string, cb: (err?: Error) => void): void;
    rename(oldPath: string, newPath: string, cb: (err?: Error) => void): void;
    /** 打开文件（flags 同 fs.open，如 'w' 创建/清空），返回句柄 */
    open(path: string, flags: string, cb: (err: Error | undefined, handle: Buffer | string) => void): void;
    close(handle: Buffer | string, cb: (err?: Error) => void): void;
    fastPut(localPath: string, remotePath: string, opts: unknown, cb: (err?: Error) => void): void;
    fastGet(remotePath: string, localPath: string, opts: unknown, cb: (err?: Error) => void): void;
    end(): void;
  }

  /** 双向流（shell / 转发通道）：可读可写，可挂事件（最小接口，避免依赖 @types/node 的 stream 模块解析） */
  export interface ClientChannel {
    write(data: string | Buffer): boolean;
    end(): void;
    setWindow?(rows: number, cols: number, height: number, width: number): void;
    on(event: 'data', listener: (data: Buffer) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  /** ssh2 客户端 */
  export class Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    shell(opts: unknown, cb: (err: Error | undefined, stream: ClientChannel) => void): void;
    shell(cb: (err: Error | undefined, stream: ClientChannel) => void): void;
    sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void;
    /** 一次性命令执行（非交互式，无 TTY），用于工具调用 / 脚本化采集 */
    exec(cmd: string, opts: { pty: boolean }, cb: (err: Error | undefined, channel: ClientChannel & {
      stderr: { on(event: 'data', listener: (data: Buffer) => void): void };
      on(event: 'close', listener: (code: number | null) => void): void;
    }) => void): void;
    forwardOut(
      srcIP: string,
      srcPort: number,
      dstIP: string,
      dstPort: number,
      cb: (err: Error | undefined, stream: ClientChannel) => void,
    ): void;
    end(): void;
    on(event: 'ready', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
