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

  /** pg 连接池（仅列本工程用到的 query/end） */
  export class Pool {
    constructor(config?: PoolConfig);
    query(text: string | { text: string; values?: unknown[] }): Promise<QueryResult>;
    query(text: string, params?: unknown[]): Promise<QueryResult>;
    end(): Promise<void>;
  }

  const pg: { Pool: typeof Pool };
  export default pg;
}
