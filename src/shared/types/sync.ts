/**
 * 云同步 / 结构对比 / 数据传输 / 自动更新领域类型（单一职责：跨领域的结果、进度与状态类型）。
 *
 * @since 0.1.0
 */

/** 自动上传策略：关闭 / 每 30 分钟 / 每 1 小时 / 本地改动立即上传（防抖） */
export type SyncAutoPush = 'off' | '30m' | '1h' | 'onChange';

/** 云同步配置（渲染端可见的部分；token 等敏感字段不传出渲染进程） */
export interface SyncConfigView {
  /** 是否已配置 Gitee 私人令牌 */
  hasToken: boolean;
  /** 单一同步 gist 的 id（一个 gist 内以多文件承载：连接/文件夹、偏好、AI 设置），空表示尚未初始化同步点 */
  gistId: string;
  /** 自动上传策略 */
  autoPush: SyncAutoPush;
  /** 启动时自动从云拉取最新 */
  pullOnStartup: boolean;
  /** 上次成功同步时间（ISO 字符串） */
  syncedAt?: string;
}

/** 云同步单次操作结果 */
export interface SyncResult {
  /** 是否成功 */
  ok: boolean;
  /** 结果说明（成功/失败原因） */
  message: string;
  /** 成功时返回本次同步时间 */
  syncedAt?: string;
  /** 成功时返回同步对象数量 */
  counts?: { connections: number; folders: number };
}

/** 统一应用错误（主进程抛出，渲染进程捕获） */
export interface AppErrorShape {
  code: string;
  message: string;
}

/** 结构对比：单表/对象的差异 */
export interface SchemaDiffItem {
  /** 对象名（表/视图） */
  name: string;
  /** 是否存在于左库 */
  inLeft: boolean;
  /** 是否存在于右库 */
  inRight: boolean;
  /** 差异说明（列增删改、类型变化等） */
  changes: string[];
}

/** 结构对比结果 */
export interface SchemaDiffResult {
  items: SchemaDiffItem[];
}

/** 数据传输内容模式：仅结构 / 结构和数据 / 仅数据 */
export type DataTransferMode = 'structure' | 'structure-data' | 'data';

/** 数据传输规格（渲染端 → 主进程；跨库/跨方言，mysql ↔ pg ↔ oracle 任意组合） */
export interface DataTransferSpec {
  /** 源连接 ID（mysql / postgres / oracle） */
  sourceConnId: string;
  /** 源库（MySQL 数据库名；留空用连接默认库） */
  sourceDb?: string;
  /** 源模式（PG schema / Oracle schema） */
  sourceSchema?: string;
  /** 目标连接 ID（可与源同类型或不同类型，跨方言自动做类型映射） */
  targetConnId: string;
  /** 目标库（MySQL 数据库名；留空用连接默认库） */
  targetDb?: string;
  /** 目标模式（PG schema / Oracle schema） */
  targetSchema?: string;
  /** 要传输的表名清单（源侧表名） */
  tables: string[];
  /** 内容模式 */
  mode: DataTransferMode;
  /** 结构模式下目标表已存在时是否先删除重建（仅影响含结构的模式；仅数据模式忽略） */
  dropIfExists?: boolean;
}

/** 数据传输任务状态 */
export type DataTransferStatus = 'running' | 'done' | 'error' | 'cancelled';

/** 数据传输阶段：准备 → 建表(结构) → 拷数据 → 收尾 */
export type DataTransferPhase = 'prepare' | 'structure' | 'data' | 'finish';

/** 数据传输进度事件（主进程 -> 渲染端实时推送；message 为一条日志行） */
export interface DataTransferProgress {
  taskId: string;
  status: DataTransferStatus;
  phase: DataTransferPhase;
  /** 当前正在处理的表（无则 null） */
  currentTable: string | null;
  /** 表总数 / 已完成表数 */
  tablesTotal: number;
  tablesDone: number;
  /** 任务累计已传行数 / 全部表预计总行数（count 估计） */
  rowsTotal: number;
  rowsDone: number;
  /** 当前表已传行数 / 当前表总行数（可能为 null = 未知） */
  currentRows: number;
  currentRowsTotal: number | null;
  /** 一条进度日志（如「user: 已传 1200/5000 行」） */
  message: string;
  /** 失败时的错误摘要（status=error 时） */
  error?: string;
}

/** 自动更新状态（主进程 -> 渲染端推送，详情见 src/main/auto-update.ts） */
export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'available'; version: string; releaseNotes?: string | Array<{ version: string; notes: string }> }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string; fallbackUrl?: string };
