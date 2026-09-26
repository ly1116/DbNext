import type { RedisEntry } from '@shared/types';
import { getRedis } from '../clients/manager';

/**
 * Redis 服务（真实实现）。
 *
 * 用 ioredis 真实扫描 key、读取类型 / TTL / 元素数 / 预览值。
 * 不再返回任何静态假 key。
 *
 * @since 0.1.0
 */

/** 列出匹配 pattern 的 key，附带真实类型与 TTL */
export async function keys(connectionId: string, pattern: string): Promise<RedisEntry[]> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  const pat = pattern && pattern.trim() ? pattern : '*';
  const found = await redis.keys(pat);
  const entries: RedisEntry[] = [];
  for (const key of found.slice(0, 2000)) {
    const [type, ttl] = await Promise.all([redis.type(key), redis.ttl(key)]);
    let size: number | undefined;
    let preview: string | undefined;
    if (type === 'string') {
      const v = await redis.get(key);
      preview = v ? (v.length > 200 ? `${v.slice(0, 200)}…` : v) : '';
    } else if (type === 'hash') {
      size = await redis.hlen(key);
    } else if (type === 'list') {
      size = await redis.llen(key);
    } else if (type === 'set') {
      size = await redis.scard(key);
    } else if (type === 'zset') {
      size = await redis.zcard(key);
    }
    entries.push({ key, type, ttl, size, preview });
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/** 读取 key 的完整值（按类型返回结构化文本） */
export async function get(connectionId: string, key: string): Promise<{ type: string; value: string }> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  const type = await redis.type(key);
  let value = '';
  switch (type) {
    case 'string':
      value = (await redis.get(key)) ?? '';
      break;
    case 'hash':
      value = JSON.stringify(await redis.hgetall(key), null, 2);
      break;
    case 'list':
      value = JSON.stringify(await redis.lrange(key, 0, -1), null, 2);
      break;
    case 'set':
      value = JSON.stringify(await redis.smembers(key), null, 2);
      break;
    case 'zset':
      value = JSON.stringify(await redis.zrange(key, 0, -1, 'WITHSCORES'), null, 2);
      break;
    default:
      value = `(未知类型: ${type})`;
  }
  return { type, value };
}

/** 按类型写回值（值编辑：string 直接 SET；结构化类型解析 JSON 后重建） */
export async function setVal(connectionId: string, key: string, type: string, value: string): Promise<void> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  switch (type) {
    case 'string':
      await redis.set(key, value);
      break;
    case 'hash': {
      const obj = JSON.parse(value) as Record<string, unknown>;
      if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) throw new Error('hash 期望值格式为 JSON 对象 {字段: 值}');
      await redis.del(key);
      await redis.hset(key, obj as Record<string, string>);
      break;
    }
    case 'list': {
      const arr = JSON.parse(value) as unknown[];
      if (!Array.isArray(arr)) throw new Error('list 期望值格式为 JSON 数组 [元素, ...]');
      await redis.del(key);
      if (arr.length) await redis.rpush(key, ...arr.map(String));
      break;
    }
    case 'set': {
      const arr = JSON.parse(value) as unknown[];
      if (!Array.isArray(arr)) throw new Error('set 期望值格式为 JSON 数组 [成员, ...]');
      await redis.del(key);
      if (arr.length) await redis.sadd(key, ...arr.map(String));
      break;
    }
    case 'zset': {
      const arr = JSON.parse(value) as unknown[];
      if (!Array.isArray(arr) || arr.length % 2 !== 0) throw new Error('zset 期望值格式为 JSON 数组 [成员, 分数, 成员, 分数, ...]（与查看格式一致）');
      await redis.del(key);
      const flat: (string | number)[] = [];
      for (let i = 0; i < arr.length; i += 2) flat.push(Number(arr[i + 1]), String(arr[i]));
      if (flat.length) await redis.zadd(key, ...flat);
      break;
    }
    default:
      throw new Error(`暂不支持编辑该类型：${type}`);
  }
}

/** 删除 key */
export async function del(connectionId: string, key: string): Promise<void> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  await redis.del(key);
}

/** 重命名 key */
export async function rename(connectionId: string, key: string, newKey: string): Promise<void> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  if (!newKey.trim()) throw new Error('新 key 名不能为空');
  await redis.rename(key, newKey.trim());
}

/** 设置 TTL（秒）：ttl<0 表示永久（PERSIST） */
export async function expire(connectionId: string, key: string, ttl: number): Promise<void> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  if (ttl < 0) await redis.persist(key);
  else await redis.expire(key, ttl);
}

/** 切换数据库 */
export async function selectDb(connectionId: string, dbIndex: number): Promise<void> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  await redis.select(dbIndex);
}

/** 获取各 db 的 key 数量统计（一次 INFO keyspace，不切换连接当前库） */
export async function dbInfo(connectionId: string): Promise<Record<number, number>> {
  const redis = getRedis(connectionId);
  if (!redis) throw new Error('该连接不是 Redis 或未建立连接');
  const info: Record<number, number> = {};
  for (let i = 0; i < 16; i++) info[i] = 0;
  const raw = await redis.info('keyspace');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^db(\d+):keys=(\d+)/.exec(line.trim());
    if (m) {
      const idx = Number(m[1]);
      if (idx >= 0 && idx < 16) info[idx] = Number(m[2]);
    }
  }
  return info;
}
