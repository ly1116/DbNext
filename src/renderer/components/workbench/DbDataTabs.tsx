import { useAppStore } from '@renderer/store/appStore';
import { TableTab } from './dbdata/tableTab';
import { ObjListTab } from './dbdata/objListTab';
import { QueryTab } from './dbdata/queryTab';
import { DefTab, SequenceTab } from './dbdata/defTab';
import { UsersTab } from './dbdata/usersTab';
import { RedisScreen } from '@renderer/screens/Redis/RedisScreen';
import { NacosBrowser } from '@renderer/screens/Nacos/NacosScreen';

/**
 * 数据视图路由：按当前激活标签的 type 分发到对应标签页组件。
 * 各标签页的实现已拆分到 ./dbdata/ 下，本文件只做编排，保持单一职责。
 */
export function DbDataTabs() {
  const activeDbTab = useAppStore((s) => s.activeDbTab);
  const dbTabs = useAppStore((s) => s.dbTabs);
  const dbTabTick = useAppStore((s) => s.dbTabTick);
  const active = dbTabs.find((t) => t.id === activeDbTab) ?? null;
  /** 标签右键「刷新」计数：作为 key 绑定内容组件，自增时强制重挂载重新加载数据 */
  const tick = active ? (dbTabTick[active.id] ?? 0) : 0;
  const reloadKey = active ? `${active.id}:${tick}` : 'none';

  if (!active) return null;
  return active.type === 'table' ? (
    <TableTab key={reloadKey} connId={active.connId} db={active.db} pgDb={active.pgDb} table={active.table} />
  ) : active.type === 'objlist' ? (
    <ObjListTab key={reloadKey} tab={active} />
  ) : active.type === 'def' ? (
    <DefTab key={reloadKey} connId={active.connId} kind={active.kind} pgDb={active.pgDb} schema={active.schema} name={active.name} />
  ) : active.type === 'sequence' ? (
    <SequenceTab key={reloadKey} connId={active.connId} pgDb={active.pgDb} schema={active.schema} name={active.name} />
  ) : active.type === 'users' ? (
    <UsersTab key={reloadKey} connId={active.connId} />
  ) : active.type === 'redis' ? (
    <RedisScreen key={reloadKey} connId={active.connId} dbIndex={(active as any).dbIndex} />
  ) : active.type === 'nacos' ? (
    <NacosBrowser key={`${active.id}-${reloadKey}`} connectionId={active.connId} initialNamespace={active.namespace} />
  ) : (
    <QueryTab key={active.id} connId={active.connId} tabId={active.id} initialSql={active.sql} initialDb={active.pgDb ?? active.db} />
  );
}
