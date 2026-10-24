/**
 * 跨进程共享类型定义（单一来源 / 桶文件）。
 *
 * 这些类型同时被 Electron 主进程、预加载脚本与 React 渲染进程引用，
 * 保证 IPC 通信两端类型一致，避免运行期数据结构漂移。
 *
 * 自 0.5.0 起按领域拆分为 `./types/*` 子模块（连接 / 文件 / SQL / Redis /
 * Nacos / 例程 / 用户 / AI / 偏好 / 同步），本文件仅做再导出，保持
 * `import ... from '@shared/types'` 的兼容性与单一来源特性。
 *
 * 设计原则：
 * - 凭据（password / privateKey / passphrase / apiKey）仅在主进程内存中存在，
 *   由 `electron.safeStorage` 加密落盘，永不以明文经 IPC 传给渲染进程。
 * - 渲染进程只拿到「脱敏」后的连接元信息（见 `ConnectionSummary`）。
 *
 * @since 0.1.0
 */

export * from './types/connection';
export * from './types/file';
export * from './types/sql';
export * from './types/redis';
export * from './types/nacos';
export * from './types/routine';
export * from './types/user';
export * from './types/ai';
export * from './types/prefs';
export * from './types/sync';
