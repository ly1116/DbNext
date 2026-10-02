/**
 * pg 局部类型声明（覆盖本工程实际用到的 Pool.query 子集）。
 *
 * 不依赖 @types/pg 网络安装：主进程经 esbuild 打包 pg 运行时，tsc 仅做类型检查。
 * 如需完整类型，可后续安装 @types/pg 并删除本文件。
 *
 * @since 0.1.0
 */
declare module 'pg' {
  export interface PoolConfig {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionTimeoutMillis?: number;
    [key: string]: unknown;
  }

  export interface QueryResultField {
    name: string;
    dataTypeID: number;
  }

  export interface QueryResult<R extends Record<string, unknown> = Record<string, unknown>> {
    rows: R[];
    fields: QueryResultField[];
    rowCount: number | null;
    command: string;
  }

  /** 从连接池取出的专属连接（用于 pg_cancel_backend 等需要后端 PID 的场景） */
  export interface PoolClient {
    /** 后端进程 PID，用于 pg_cancel_backend(pid) */
    processID: number;
    query(text: string | { text: string; values?: unknown[] }): Promise<QueryResult>;
    query(text: string, params?: unknown[]): Promise<QueryResult>;
    release(err?: Error): void;
  }

  /** pg 连接池（列本工程用到的 query/end/connect） */
  export class Pool {
    constructor(config?: PoolConfig);
    query(text: string | { text: string; values?: unknown[] }): Promise<QueryResult>;
    query(text: string, params?: unknown[]): Promise<QueryResult>;
    /** 取一条专属连接（cancel 查询需持有独立 client） */
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
  }

  const pg: { Pool: typeof Pool };
  export default pg;
}
