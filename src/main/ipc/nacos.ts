import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type {
  NacosConfigDetail,
  NacosConfigPage,
  NacosConfigSpec,
  NacosHistoryDetail,
  NacosHistoryPage,
  NacosInstanceInfo,
  NacosNamespace,
  NacosPermissionPage,
  NacosRolePage,
  NacosServiceDetail,
  NacosServicePage,
  NacosUserPage,
} from '@shared/types';
import {
  nacosConsoleUrl,
  nacosCreateService,
  nacosDeleteConfig,
  nacosGetConfig,
  nacosHistoryDetail,
  nacosHistoryList,
  nacosInstanceList,
  nacosListConfigs,
  nacosNamespaces,
  nacosPermissionCreate,
  nacosPermissionDelete,
  nacosPermissionList,
  nacosPublishConfig,
  nacosRoleCreate,
  nacosRoleDelete,
  nacosRoleList,
  nacosServiceDetail,
  nacosServiceList,
  nacosUserCreate,
  nacosUserDelete,
  nacosUserList,
  nacosUserResetPassword,
} from '../services/nacos.service';

/** Nacos（注册与配置中心）IPC 通道。 */
export function registerNacosIpc(): void {
  handle(IPC.NACOS_NAMESPACES, (_e, connectionId: string): Promise<NacosNamespace[]> => nacosNamespaces(connectionId));
  handle(IPC.NACOS_CONFIGS, (_e, connectionId: string, tenant: string, opts?: { dataId?: string; group?: string; pageNo?: number; pageSize?: number }): Promise<NacosConfigPage> =>
    nacosListConfigs(connectionId, tenant, opts ?? {}));
  handle(IPC.NACOS_CONFIG_GET, (_e, connectionId: string, tenant: string, dataId: string, group: string): Promise<NacosConfigDetail> =>
    nacosGetConfig(connectionId, tenant, dataId, group));
  handle(IPC.NACOS_CONFIG_PUBLISH, (_e, connectionId: string, spec: NacosConfigSpec): Promise<void> => nacosPublishConfig(connectionId, spec));
  handle(IPC.NACOS_CONFIG_DELETE, (_e, connectionId: string, tenant: string, dataId: string, group: string): Promise<void> =>
    nacosDeleteConfig(connectionId, tenant, dataId, group));
  handle(IPC.NACOS_HISTORY, (_e, connectionId: string, tenant: string, dataId: string, group: string, opts?: { pageNo?: number; pageSize?: number }): Promise<NacosHistoryPage> =>
    nacosHistoryList(connectionId, tenant, dataId, group, opts ?? {}));
  handle(IPC.NACOS_HISTORY_DETAIL, (_e, connectionId: string, tenant: string, dataId: string, group: string, nid: string): Promise<NacosHistoryDetail> =>
    nacosHistoryDetail(connectionId, tenant, dataId, group, nid));
  handle(IPC.NACOS_USER_LIST, (_e, connectionId: string, opts?: { username?: string; pageNo?: number; pageSize?: number }): Promise<NacosUserPage> =>
    nacosUserList(connectionId, opts ?? {}));
  handle(IPC.NACOS_USER_CREATE, (_e, connectionId: string, username: string, password: string): Promise<void> => nacosUserCreate(connectionId, username, password));
  handle(IPC.NACOS_USER_DELETE, (_e, connectionId: string, username: string): Promise<void> => nacosUserDelete(connectionId, username));
  handle(IPC.NACOS_USER_PASSWORD, (_e, connectionId: string, username: string, newPassword: string): Promise<void> => nacosUserResetPassword(connectionId, username, newPassword));
  handle(IPC.NACOS_ROLE_LIST, (_e, connectionId: string, opts?: { username?: string; pageNo?: number; pageSize?: number }): Promise<NacosRolePage> =>
    nacosRoleList(connectionId, opts ?? {}));
  handle(IPC.NACOS_ROLE_CREATE, (_e, connectionId: string, role: string, username: string): Promise<void> => nacosRoleCreate(connectionId, role, username));
  handle(IPC.NACOS_ROLE_DELETE, (_e, connectionId: string, role: string, username?: string): Promise<void> => nacosRoleDelete(connectionId, role, username));
  handle(IPC.NACOS_PERM_LIST, (_e, connectionId: string, opts?: { role?: string; pageNo?: number; pageSize?: number }): Promise<NacosPermissionPage> =>
    nacosPermissionList(connectionId, opts ?? {}));
  handle(IPC.NACOS_PERM_CREATE, (_e, connectionId: string, role: string, resource: string, action: string): Promise<void> =>
    nacosPermissionCreate(connectionId, role, resource, action));
  handle(IPC.NACOS_PERM_DELETE, (_e, connectionId: string, role: string, resource: string, action: string): Promise<void> =>
    nacosPermissionDelete(connectionId, role, resource, action));
  handle(IPC.NACOS_SERVICES, (_e, connectionId: string, tenant: string, opts?: { group?: string; serviceName?: string; pageNo?: number; pageSize?: number }): Promise<NacosServicePage> =>
    nacosServiceList(connectionId, tenant, opts ?? {}));
  handle(IPC.NACOS_SERVICE_CREATE, (_e, connectionId: string, tenant: string, spec: { name: string; group: string; protectThreshold?: number; metadata?: Record<string, string> }): Promise<void> =>
    nacosCreateService(connectionId, tenant, spec));
  handle(IPC.NACOS_SERVICE_DETAIL, (_e, connectionId: string, tenant: string, serviceName: string, group: string): Promise<NacosServiceDetail> =>
    nacosServiceDetail(connectionId, tenant, serviceName, group));
  handle(IPC.NACOS_INSTANCES, (_e, connectionId: string, tenant: string, serviceName: string, group: string): Promise<NacosInstanceInfo[]> =>
    nacosInstanceList(connectionId, tenant, serviceName, group));
  handle(IPC.NACOS_CONSOLE_URL, (_e, connectionId: string): Promise<string> => nacosConsoleUrl(connectionId));
}
