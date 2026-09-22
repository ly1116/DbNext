import type { ConnectionStatus } from '@shared/types';

/**
 * 连接状态 → 视觉元数据（标签 / 颜色类 / 圆点类）。
 * 集中定义，避免各屏重复硬编码状态色。
 *
 * @since 0.1.0
 */
export const STATUS_META: Record<ConnectionStatus, { label: string; cls: string; dot: string }> = {
  connected: { label: '已连接', cls: 'bg-ok/15 text-ok', dot: 'bg-ok' },
  connecting: { label: '连接中', cls: 'bg-warn/15 text-warn', dot: 'bg-warn' },
  error: { label: '错误', cls: 'bg-prod/15 text-prod', dot: 'bg-prod' },
  disconnected: { label: '未连接', cls: 'bg-panel3 text-dim2', dot: 'bg-dim2' },
};
