import { useConnections } from '@renderer/store/connectionStore';
import { useAppStore } from '@renderer/store/appStore';
import { usePrefs } from '@renderer/store/prefsStore';
import { STATUS_META } from '@renderer/components/common/StatusMeta';
import type { ConnectionKind, EnvironmentTag } from '@shared/types';

/**
 * 底部状态栏 —— v4 核心原则「连接上下文跟随激活标签」。
 *
 * 无论当前在数据库树 / SSH 树 / Nacos 侧栏，状态栏始终反映**当前激活标签所属的连接**：
 * - 数据库模式：取激活数据标签（表 / 视图 / 查询 / 用户 …）的 connId；
 * - SSH 模式：取激活终端主机的 connId；
 * 展示「连接名 · 当前对象 · 用户 · 环境 · 读写/只读 · 类型」，右侧给出类型与编码。
 * 连接断开 / 无激活标签时降级为「就绪」。
 *
 * 朴素中性基调：仅状态点用语义色，其余走 muted / foreground，不引入额外强调色。
 *
 * @since 0.5.0
 */

const ENV_LABEL: Record<EnvironmentTag, string> = {
  prod: '生产',
  staging: '预发',
  dev: '测试',
  bastion: '堡垒',
};

const KIND_LABEL: Record<ConnectionKind, string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  oracle: 'Oracle',
  redis: 'Redis',
  ssh: 'SSH',
  bastion: '堡垒机',
  nacos: 'Nacos',
};

/** 顶部激活连接 + 当前对象上下文 */
function useActiveConnection() {
  const dbTabs = useAppStore((s) => s.dbTabs);
  const activeDbTab = useAppStore((s) => s.activeDbTab);
  const termTabs = useAppStore((s) => s.termTabs);
  const activeTerm = useAppStore((s) => s.activeTerm);
  const wbSidebar = useAppStore((s) => s.wbSidebar);
  const connections = useConnections((s) => s.connections);

  let connId: string | null = null;
  let context = '';

  if (wbSidebar === 'ssh') {
    connId = termTabs.find((t) => t.id === activeTerm)?.connId ?? termTabs[0]?.connId ?? null;
    context = 'SSH 终端';
  } else {
    const t = dbTabs.find((x) => x.id === activeDbTab);
    if (t) {
      connId = t.connId;
      context = t.title;
    }
  }

  const conn = connections.find((c) => c.id === connId) ?? null;
  return { conn, context };
}

export function WorkbenchStatusBar() {
  const { conn, context } = useActiveConnection();
  const readOnly = usePrefs((s) => s.prefs.readOnlyMode);

  if (!conn) {
    return (
      <footer className="statusbar" style={{ height: 28 }}>
        <span className="text-muted-foreground">就绪</span>
      </footer>
    );
  }

  const meta = STATUS_META[conn.status];

  return (
    <footer className="statusbar" style={{ height: 28 }}>
      {/* 左：连接名 + 状态点 + 当前对象 */}
      <span className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
        <b className="font-medium">{conn.name}</b>
      </span>
      {context && <span className="truncate text-muted-foreground">{context}</span>}

      <span className="sep" />

      {/* 用户 */}
      <span>
        usr <b>{conn.username || '—'}</b>
      </span>

      <span className="sep" />

      {/* 环境（朴素 chip） */}
      <span className="chip h-[18px] px-1.5 text-[10px]">{ENV_LABEL[conn.environment]}</span>

      <span className="sep" />

      {/* 读写 / 只读（全局只读偏好；连接层暂无逐连接权限字段） */}
      <span className={readOnly ? 'text-warning' : 'text-foreground'}>{readOnly ? '只读' : '读写'}</span>

      {/* 右：类型 + 编码 */}
      <div className="ml-auto flex items-center gap-3">
        <span>{KIND_LABEL[conn.kind]}</span>
        <span className="sep" />
        <span>UTF-8</span>
      </div>
    </footer>
  );
}
