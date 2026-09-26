/**
 * oracledb 6.x 未随包提供 TypeScript 声明，这里给出最小可用环境声明。
 * 仅覆盖本项目用到的 API（thin 模式）：连接池、连接、execute 结果。
 */
declare module 'oracledb' {
  export const OUT_FORMAT_OBJECT: number;
  export const CLOB: unknown;
  export const DB_TYPE_CLOB: unknown;
  export const NUMBER: unknown;

  export interface OraColumnMeta {
    name: string;
  }
  export interface OraResult {
    rows?: any[];
    rowsAffected?: number;
    metaData?: OraColumnMeta[];
  }
  export interface OraConnection {
    execute(sql: string, binds?: unknown, options?: unknown): Promise<OraResult>;
    close(): Promise<void>;
  }
  export interface OraPool {
    getConnection(): Promise<OraConnection>;
    close(): Promise<void>;
  }
  export function createPool(config?: unknown): Promise<OraPool>;
  export function getConnection(config?: unknown): Promise<OraConnection>;

  const oracledb: {
    OUT_FORMAT_OBJECT: number;
    CLOB: unknown;
    DB_TYPE_CLOB: unknown;
    NUMBER: unknown;
    outFormat: number;
    fetchAsString: unknown[];
    createPool: typeof createPool;
    getConnection: typeof getConnection;
  };
  export default oracledb;
}
