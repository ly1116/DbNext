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
