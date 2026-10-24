/**
 * Redis 领域类型（单一职责：键值条目）。
 *
 * @since 0.1.0
 */

/** Redis 键值条目（带类型，真实 type 命令返回） */
export interface RedisEntry {
  key: string;
  /** Redis 类型：string / hash / list / set / zset / stream / none */
  type: string;
  /** 概要值（用于列表预览，真实读取） */
  preview?: string;
  /** 元素数量（hash/list/set/zset） */
  size?: number;
  /** TTL（秒，-1 永久，-2 不存在） */
  ttl?: number;
}
