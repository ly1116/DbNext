/**
 * 文件 / 传输领域类型（单一职责：SFTP 文件节点与文件/目录传输任务）。
 *
 * @since 0.1.0
 */

/** SFTP 文件节点类型 */
export type FileNodeType = 'file' | 'dir';

/** SFTP 文件/目录条目 */
export interface FileNode {
  /** 绝对路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 节点类型 */
  type: FileNodeType;
  /** 字节大小 */
  size: number;
  /** 权限字符串，如 0755 / 0600 */
  mode: string;
  /** 最后修改时间（ISO 字符串） */
  modifiedAt: string;
}

/** 传输任务方向 */
export type TransferDirection = 'upload' | 'download';

/** 传输任务状态 */
export type TransferStatus = 'queued' | 'active' | 'done' | 'error' | 'paused';

/** 单个文件传输任务（渲染端展示用，不含本地流） */
export interface TransferTask {
  id: string;
  /** 远端路径 */
  remotePath: string;
  /** 本地路径 */
  localPath: string;
  /** 方向：上传/下载 */
  direction: TransferDirection;
  total: number;
  transferred: number;
  status: TransferStatus;
  /** 错误信息（status=error 时） */
  error?: string;
}

/** 传输进度事件（主进程 -> 渲染端，实时推送） */
export interface TransferProgress {
  id: string;
  transferred: number;
  total: number;
  status: TransferStatus;
  error?: string;
  /** 远端路径（进度事件携带，便于即时显示文件名，不依赖 listTransfers 快照时序） */
  remotePath?: string;
  /** 本地路径 */
  localPath?: string;
  /** 方向：上传/下载 */
  direction?: TransferDirection;
}
