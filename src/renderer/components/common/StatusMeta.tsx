import type { ConnectionStatus } from '@shared/types';

/**
 * 连接状态 → 视觉元数据（标签 / 颜色类 / 圆点类）。
 * 集中定义，避免各屏重复硬编码状态色。
 *
 * @since 0.1.0
 */
export const STATUS_META: Record<ConnectionStatus, { label: string; cls: string; dot: string }> = {
  connected: { label: '已连接', cls: 'bg-success/15 text-success', dot: 'bg-success' },
  connecting: { label: '连接中', cls: 'bg-warn/15 text-warning', dot: 'bg-warn' },
  error: { label: '错误', cls: 'bg-destructive/15 text-destructive', dot: 'bg-destructive' },
  disconnected: { label: '未连接', cls: 'bg-secondary text-muted-foreground', dot: 'bg-dim2' },
};
