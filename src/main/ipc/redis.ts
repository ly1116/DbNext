import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type { RedisEntry } from '@shared/types';
import { keys as redisKeys, get as redisGet, setVal as redisSet, del as redisDel, rename as redisRename, expire as redisExpire, selectDb as redisSelectDb, dbInfo as redisDbInfo } from '../services/redis.service';

/** Redis IPC 通道（键/值/类型/重命名/过期/切库/库信息）。 */
export function registerRedisIpc(): void {
  handle(IPC.REDIS_KEYS, (_e, connectionId: string, pattern: string): Promise<RedisEntry[]> => redisKeys(connectionId, pattern));
  handle(IPC.REDIS_GET, (_e, connectionId: string, key: string) => redisGet(connectionId, key));
  handle(IPC.REDIS_SET, (_e, connectionId: string, key: string, type: string, value: string): Promise<void> => redisSet(connectionId, key, type, value));
  handle(IPC.REDIS_DEL, (_e, connectionId: string, key: string): Promise<void> => redisDel(connectionId, key));
  handle(IPC.REDIS_RENAME, (_e, connectionId: string, key: string, newKey: string): Promise<void> => redisRename(connectionId, key, newKey));
  handle(IPC.REDIS_EXPIRE, (_e, connectionId: string, key: string, ttl: number): Promise<void> => redisExpire(connectionId, key, ttl));
  handle(IPC.REDIS_SELECT_DB, (_e, connectionId: string, dbIndex: number): Promise<void> => redisSelectDb(connectionId, dbIndex));
  handle(IPC.REDIS_DB_INFO, (_e, connectionId: string): Promise<Record<number, number>> => redisDbInfo(connectionId));
}
