/**
 * Nacos 领域类型（单一职责：注册与配置中心的命名空间、配置、服务、实例）。
 *
 * @since 0.1.0
 */

/** Nacos 命名空间 */
export interface NacosNamespace {
  /** 命名空间 ID（public 为空串） */
  namespaceId: string;
  /** 展示名 */
  namespaceShowName: string;
  /** 配置数（console 接口返回） */
  configCount?: number;
  /** 类型（0 全局 / 1 自定义） */
  type?: number;
}

/** Nacos 配置条目（列表行） */
export interface NacosConfigItem {
  dataId: string;
  group: string;
  /** 配置格式：json / yaml / properties / text / xml / html */
  type?: string;
  appName?: string;
  md5?: string;
  /** 所属命名空间（tenant） */
  tenant?: string;
}

/** Nacos 配置分页结果 */
export interface NacosConfigPage {
  totalCount: number;
  pageNo: number;
  pageSize: number;
  items: NacosConfigItem[];
}

/** Nacos 配置详情（点开查看/编辑） */
export interface NacosConfigDetail {
  dataId: string;
  group: string;
  tenant?: string;
  type: string;
  content: string;
  md5?: string;
  appName?: string;
}

/** 新建/发布配置入参 */
export interface NacosConfigSpec {
  dataId: string;
  group: string;
  /** 命名空间（tenant；public 传空串） */
  tenant?: string;
  type: string;
  content: string;
}

/** Nacos 服务目录条目（服务列表行：名称 + 集群/实例/健康统计） */
export interface NacosServiceItem {
  /** 服务名 */
  name: string;
  /** 分组名 */
  group: string;
  /** 集群数 */
  clusterCount: number;
  /** 实例总数 */
  ipCount: number;
  /** 健康实例数 */
  healthyCount: number;
}

/** Nacos 服务分页结果 */
export interface NacosServicePage {
  totalCount: number;
  pageNo: number;
  pageSize: number;
  items: NacosServiceItem[];
}

/** Nacos 服务详情（保护阈值 + 集群列表） */
export interface NacosServiceDetail {
  name: string;
  group: string;
  protectThreshold: number;
  /** 集群名列表（如 ['DEFAULT']） */
  clusters: string[];
}

/** Nacos 服务实例 */
export interface NacosInstanceInfo {
  instanceId: string;
  ip: string;
  port: number;
  weight: number;
  healthy: boolean;
  /** 上线状态（false = 已下线） */
  enabled: boolean;
  /** 临时实例 */
  ephemeral: boolean;
  clusterName: string;
  metadata: Record<string, string>;
}
