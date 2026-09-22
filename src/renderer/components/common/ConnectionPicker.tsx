import { useConnections } from '@renderer/store/connectionStore';
import type { ConnectionKind, ConnectionStatus } from '@shared/types';

/** 连接状态下拉文案 */
export function statusLabel(status: ConnectionStatus): string {
  return { connected: '已连', connecting: '连接中', error: '失败', disconnected: '未连' }[status];
}

/**
 * 连接选择器（下拉）。
 * 按 kind 过滤（如 SQL 屏只列 mysql/postgres），无连接时提示先去「连接管理」新建。
 */
export function ConnectionPicker({
  kind,
  value,
  onChange,
  placeholder = '选择连接…',
}: {
  kind?: ConnectionKind | ConnectionKind[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const connections = useConnections((s) => s.connections);
  const kinds = kind ? (Array.isArray(kind) ? kind : [kind]) : null;
  const list = kinds ? connections.filter((c) => kinds.includes(c.kind)) : connections;

  return (
    <select value={value ?? ''} onChange={(e) => e.target.value && onChange(e.target.value)} className="ipt">
      <option value="">{list.length ? placeholder : '（无可用连接，请先到「连接管理」新建）'}</option>
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} · {c.host}:{c.port} · {statusLabel(c.status)}
        </option>
      ))}
    </select>
  );
}
