import { handle } from './_shared';
import { IPC } from '@shared/ipc-channels';
import type {
  NacosConfigDetail,
  NacosConfigPage,
  NacosConfigSpec,
  NacosInstanceInfo,
  NacosNamespace,
  NacosServiceDetail,
  NacosServicePage,
} from '@shared/types';
import {
  nacosDeleteConfig,
  nacosGetConfig,
  nacosInstanceList,
  nacosListConfigs,
  nacosNamespaces,
  nacosPublishConfig,
  nacosServiceDetail,
  nacosServiceList,
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
  handle(IPC.NACOS_SERVICES, (_e, connectionId: string, tenant: string, opts?: { group?: string; serviceName?: string; pageNo?: number; pageSize?: number }): Promise<NacosServicePage> =>
    nacosServiceList(connectionId, tenant, opts ?? {}));
  handle(IPC.NACOS_SERVICE_DETAIL, (_e, connectionId: string, tenant: string, serviceName: string, group: string): Promise<NacosServiceDetail> =>
    nacosServiceDetail(connectionId, tenant, serviceName, group));
  handle(IPC.NACOS_INSTANCES, (_e, connectionId: string, tenant: string, serviceName: string, group: string): Promise<NacosInstanceInfo[]> =>
    nacosInstanceList(connectionId, tenant, serviceName, group));
}
