import { Client as SSHClient, type ClientChannel } from 'ssh2';
import Net from 'node:net';
import mysql, { type Pool as MysqlPool } from 'mysql2/promise';
import pg, { type Pool as PgPool } from 'pg';
import Redis from 'ioredis';
import type { ConnectionConfig, ConnectionStatus, ConnectionSummary } from '@shared/types';
import { getConnection } from '../services/connection-store';
import { requestSshInput } from '../services/ssh-input';
import { createLogger } from '../logger';

/**
 * 客户端管理器（主进程侧连接生命周期中枢）。
 *
 * 按 connectionId 维护「真实」连接对象：
 * - ssh / bastion：ssh2 Client（同时承载终端 shell 与 sftp 子系统）
 * - mysql / postgres：mysql2 Pool / pg Pool（支持经 SSH 隧道端口转发）
 * - redis：ioredis 客户端（同样支持隧道）
 *
 * 所有「连接某服务器」的动作都从这里取已建立的连接，绝不 mock。
 * 连接失败会置 status='error' 并携带真实错误消息，由 IPC 推给渲染端。
 *
 * @since 0.1.0
 */
const logger = createLogger('clients');

interface Managed {
  cfg: ConnectionConfig;
  status: ConnectionStatus;
  error?: string;
  ssh?: SSHClient;
  mysql?: MysqlPool;
  pg?: PgPool;
  redis?: Redis;
  /** DB/Redis 经 SSH 隧道时的本地转发端口 */
  localPort?: number;
  /** 关闭隧道本地监听 */
  closeTunnel?: () => void;
  /** 隧道所依赖的跳板机连接 id（断开时联动） */
  tunnelId?: string;
}

const managed = new Map<string, Managed>();

/** 状态变化回调（由 IPC 层注入，用于推送渲染端） */
let statusListener: ((id: string, status: ConnectionStatus) => void) | null = null;
export function onStatusChange(cb: (id: string, status: ConnectionStatus) => void): void {
  statusListener = cb;
}

function setStatus(id: string, status: ConnectionStatus, error?: string): void {
  const m = managed.get(id);
  if (!m) return;
  m.status = status;
  m.error = error;
  statusListener?.(id, status);
}

/** 查询某连接运行时状态 */
export function statusOf(id: string): ConnectionStatus {
  return managed.get(id)?.status ?? 'disconnected';
}

/** 取脱敏摘要（含运行时状态） */
export function summaryOf(m: Managed): ConnectionSummary {
  const c = m.cfg;
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    host: c.host,
    port: c.port,
    username: c.username,
    environment: c.environment,
    group: c.group,
    useTunnel: c.useTunnel,
    tunnelId: c.tunnelId,
    remark: c.remark,
    status: m.status,
  };
}

/** 构造 ssh2 连接参数（真实凭据） */
function sshConfig(cfg: ConnectionConfig): Record<string, unknown> {
  const o: Record<string, unknown> = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
  };
  if (cfg.authType === 'privateKey') {
    if (cfg.privateKey) o.privateKey = cfg.privateKey;
    if (cfg.passphrase) o.passphrase = cfg.passphrase;
  } else {
    if (cfg.password) o.password = cfg.password;
  }
  // 启用 keyboard-interactive 认证方法：远端若启用多因子（TOTP / 动态码 / PAM），
  // 会在握手阶段触发该事件，由渲染端弹窗收集第二因子。
  o.tryKeyboard = true;
  return o;
}

/**
 * 建立并等待一条 ssh2 连接。
 *
 * 支持 keyboard-interactive 二次验证：当 sshd 要求多因子认证时，ssh2 在握手期触发
 * `keyboard-interactive` 事件，这里把提示转发给渲染端弹窗收集答案；用户取消 / 超时则
 * 主动断开并 reject，让上层 `connect` 进入 error 状态（连接树显示红点 + 真实错误）。
 */
function openSsh(cfg: ConnectionConfig): Promise<SSHClient> {
  return new Promise((resolve, reject) => {
    const cli = new SSHClient();
    cli
      .on('ready', () => resolve(cli))
      .on('error', (err: Error) => reject(new Error(`SSH 连接失败: ${err.message}`)))
      .on('close', () => logger.debug(`SSH 关闭: ${cfg.name}`))
      .on('keyboard-interactive', (...args: unknown[]) => {
        const name = typeof args[0] === 'string' ? (args[0] as string) : '';
        const instructions = typeof args[1] === 'string' ? (args[1] as string) : '';
        const prompts = Array.isArray(args[3])
          ? (args[3] as Array<{ prompt?: string; echo?: boolean }>)
          : [];
        const finish = args[4] as (responses: string[]) => void;
        requestSshInput({
          connectionId: cfg.id,
          connectionName: cfg.name,
          name,
          instructions,
          prompts: prompts.map((p) => ({ prompt: p?.prompt ?? '', echo: !!p?.echo })),
        })
          .then((answers) => finish(answers))
          .catch(() => {
            try {
              cli.end();
            } catch {
              /* ignore */
            }
            reject(new Error('已取消或超时：二次验证未通过，连接已中止'));
          });
      })
      .connect(sshConfig(cfg) as never);
  });
}

/**
 * 在已建立的 ssh 上开一个本地转发端口，把流量经 SSH 隧道送到 remoteHost:remotePort。
 * 返回本地端口与关闭函数；DB/Redis 驱动只需连 127.0.0.1:localPort。
 */
function openForward(ssh: SSHClient, remoteHost: string, remotePort: number): Promise<{ localPort: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = Net.createServer((sock) => {
      ssh.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, stream) => {
        if (err) {
          sock.destroy();
          return;
        }
        // 双向桥接：本地 socket <-> 经 SSH 转发到远端的 stream
        sock.on('data', (d) => {
          try {
            stream.write(d);
          } catch {
            /* ignore */
          }
        });
        stream.on('data', (d) => {
          try {
            sock.write(d);
          } catch {
            /* ignore */
          }
        });
        stream.on('close', () => sock.destroy());
        sock.on('close', () => {
          try {
            stream.end();
          } catch {
            /* ignore */
          }
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const localPort = (server.address() as Net.AddressInfo).port;
      resolve({ localPort, close: () => server.close() });
    });
    server.on('error', reject);
  });
}

/** 取得「承载 sftp/终端」的 ssh 客户端：ssh/bastion 用自身；db/redis 用其隧道跳板机 */
export function getSsh(id: string): SSHClient | undefined {
  const m = managed.get(id);
  if (!m) return undefined;
  if (m.ssh) return m.ssh;
  if (m.tunnelId) return managed.get(m.tunnelId)?.ssh;
  return undefined;
}

export function getMysql(id: string): MysqlPool | undefined {
  return managed.get(id)?.mysql;
}
export function getPg(id: string): PgPool | undefined {
  return managed.get(id)?.pg;
}
export function getRedis(id: string): Redis | undefined {
  return managed.get(id)?.redis;
}

/** PG 跨库内省：为 (connectionId, database) 维护的附加连接池（Navicat/DBeaver 式展开任意库） */
const pgExtra = new Map<string, PgPool>();

/**
 * 取「指定数据库」的 pg Pool（PG 树展开任意库时内省用）。
 * - database 为空 / 等于主连接库 → 直接用主池，不额外建连；
 * - 否则建（或复用缓存的）附加池：凭据同主连接，隧道场景复用主连接的本地转发端口；
 * - 断开主连接时随之一并关闭。
 */
export async function getPgPool(id: string, database?: string): Promise<PgPool> {
  const m = managed.get(id);
  if (!m || !m.pg || m.status !== 'connected') throw new Error('该连接未建立或不是 PostgreSQL 类型');
  const db = (database || '').trim();
  if (!db || db === m.cfg.database) return m.pg;
  const key = `${id}::${db}`;
  const cached = pgExtra.get(key);
  if (cached) return cached;
  // 隧道场景：主连接已建好本地转发端口，直接复用（同一 PG 实例，仅换库名）
  const host = m.localPort ? '127.0.0.1' : m.cfg.host;
  const port = m.localPort ?? m.cfg.port;
  const pool = new pg.Pool({
    host,
    port,
    user: m.cfg.username,
    password: m.cfg.password ?? undefined,
    database: db,
    connectionTimeoutMillis: 15000,
    max: 2,
  });
  await pool.query('SELECT 1');
  pgExtra.set(key, pool);
  return pool;
}

/** 关闭某连接的全部附加库池（断开时调用） */
function closePgExtra(id: string): void {
  for (const [key, pool] of [...pgExtra.entries()]) {
    if (key.startsWith(`${id}::`)) {
      pgExtra.delete(key);
      pool.end().catch(() => {});
    }
  }
}

/** 建立真实连接 */
export async function connect(id: string): Promise<ConnectionSummary> {
  const cfg = getConnection(id);
  if (!cfg) throw new Error(`连接不存在: ${id}`);
  // 已连接则直接返回
  const existing = managed.get(id);
  if (existing && existing.status === 'connected') return summaryOf(existing);

  const m: Managed = { cfg, status: 'connecting' };
  managed.set(id, m);
  setStatus(id, 'connecting');

  try {
    if (cfg.kind === 'ssh' || cfg.kind === 'bastion') {
      const ssh = await openSsh(cfg);
      ssh.on('close', () => setStatus(id, 'disconnected'));
      ssh.on('error', (e: Error) => setStatus(id, 'error', e.message));
      m.ssh = ssh;
    } else if (cfg.kind === 'mysql' || cfg.kind === 'postgres') {
      let host = cfg.host;
      let port = cfg.port;
      if (cfg.useTunnel && cfg.tunnelId) {
        const tunnel = managed.get(cfg.tunnelId);
        const ssh = tunnel?.ssh ?? (tunnel ? await openSsh(tunnel.cfg) : undefined);
        if (!ssh) throw new Error('跳板机未连接');
        if (ssh !== tunnel?.ssh) {
          ssh.on('close', () => setStatus(cfg.tunnelId!, 'disconnected'));
          tunnel!.ssh = ssh;
        }
        const fwd = await openForward(ssh, cfg.host, cfg.port);
        m.tunnelId = cfg.tunnelId;
        m.localPort = fwd.localPort;
        m.closeTunnel = fwd.close;
        host = '127.0.0.1';
        port = fwd.localPort;
      }
      if (cfg.kind === 'mysql') {
        m.mysql = mysql.createPool({
          host,
          port,
          user: cfg.username,
          password: cfg.password ?? '',
          database: cfg.database || undefined,
          waitForConnections: true,
          connectionLimit: 4,
          connectTimeout: 15000,
        });
        await m.mysql.query('SELECT 1');
      } else {
        m.pg = new pg.Pool({
          host,
          port,
          user: cfg.username,
          password: cfg.password ?? undefined,
          database: cfg.database || undefined,
          connectionTimeoutMillis: 15000,
        });
        await m.pg.query('SELECT 1');
      }
    } else if (cfg.kind === 'redis') {
      let host = cfg.host;
      let port = cfg.port;
      if (cfg.useTunnel && cfg.tunnelId) {
        const tunnel = managed.get(cfg.tunnelId);
        const ssh = tunnel?.ssh ?? (tunnel ? await openSsh(tunnel.cfg) : undefined);
        if (!ssh) throw new Error('跳板机未连接');
        if (ssh !== tunnel?.ssh) {
          ssh.on('close', () => setStatus(cfg.tunnelId!, 'disconnected'));
          tunnel!.ssh = ssh;
        }
        const fwd = await openForward(ssh, cfg.host, cfg.port);
        m.tunnelId = cfg.tunnelId;
        m.localPort = fwd.localPort;
        m.closeTunnel = fwd.close;
        host = '127.0.0.1';
        port = fwd.localPort;
      }
      m.redis = new Redis({ host, port, username: cfg.username || undefined, password: cfg.password || undefined, lazyConnect: true, connectTimeout: 15000 });
      await m.redis.connect();
    }
    m.status = 'connected';
    setStatus(id, 'connected');
    logger.info(`连接成功: ${cfg.name} (${cfg.kind})`);
    return summaryOf(m);
  } catch (err) {
    const msg = (err as Error).message;
    m.status = 'error';
    m.error = msg;
    setStatus(id, 'error', msg);
    logger.error(`连接失败 ${cfg.name}: ${msg}`);
    // 清理半成品
    await dispose(id);
    throw new Error(msg);
  }
}

/** 断开并清理连接 */
export async function disconnect(id: string): Promise<void> {
  const m = managed.get(id);
  if (!m) return;
  closePgExtra(id);
  try {
    m.mysql?.end().catch(() => {});
    m.pg?.end().catch(() => {});
    m.redis?.disconnect();
    m.ssh?.end();
    m.closeTunnel?.();
  } catch (err) {
    logger.error(`断开异常 ${id}: ${(err as Error).message}`);
  }
  managed.delete(id);
  setStatus(id, 'disconnected');
  logger.info(`已断开: ${m.cfg.name}`);
}

/** 释放资源（不抛错） */
async function dispose(id: string): Promise<void> {
  const m = managed.get(id);
  if (!m) return;
  closePgExtra(id);
  try {
    m.mysql?.end().catch(() => {});
    m.pg?.end().catch(() => {});
    m.redis?.disconnect();
    m.ssh?.end();
    m.closeTunnel?.();
  } catch {
    /* ignore */
  }
  managed.delete(id);
}

/** 真实连通性测试：按类型实际尝试建连（不长期持有） */
export async function testConnection(cfg: ConnectionConfig): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const start = Date.now();
  try {
    if (cfg.kind === 'ssh' || cfg.kind === 'bastion') {
      const ssh = await openSsh(cfg);
      ssh.end();
    } else if (cfg.kind === 'mysql') {
      const pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.username, password: cfg.password ?? '', database: cfg.database || undefined, connectTimeout: 10000, connectionLimit: 1 });
      await pool.query('SELECT 1');
      await pool.end();
    } else if (cfg.kind === 'postgres') {
      const pool = new pg.Pool({ host: cfg.host, port: cfg.port, user: cfg.username, password: cfg.password ?? undefined, database: cfg.database || undefined, connectionTimeoutMillis: 10000 });
      await pool.query('SELECT 1');
      await pool.end();
    } else if (cfg.kind === 'redis') {
      const r = new Redis({ host: cfg.host, port: cfg.port, username: cfg.username || undefined, password: cfg.password || undefined, lazyConnect: true, connectTimeout: 10000 });
      await r.connect();
      r.disconnect();
    }
    return { ok: true, message: `已连通 ${cfg.host}:${cfg.port}`, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, message: `连接失败: ${(err as Error).message}`, latencyMs: Date.now() - start };
  }
}

/** 退出时清理全部连接 */
export function disposeAll(): void {
  for (const id of [...managed.keys()]) void disconnect(id);
}

export type { ClientChannel };
