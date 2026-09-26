import { create } from 'zustand';
import { api } from '@renderer/api';
import type { DbScript } from '@shared/types';

/**
 * SQL 脚本库（按连接分组，落盘为 userData/scripts/<connId>/*.sql 纯文本文件）。
 *
 * - 查询页 Ctrl+S 弹框命名保存当前 SQL；
 * - 左侧连接树「脚本」节点列出所有脚本（读取磁盘 .sql 文件），双击打开到查询标签执行；
 * - 与连接配置一致：真实可读文件，可被任意编辑器打开 / 备份 / 复制分享。
 *
 * 数据由主进程脚本服务经 IPC 读写，渲染端仅持有内存快照，所有写操作后会刷新该连接快照。
 *
 * @since 0.3.0
 */
interface ScriptState {
  scriptsByConn: Record<string, DbScript[]>;
  /** 拉取某连接的脚本列表（异步读 .sql 文件并刷新状态；首次展开时调用） */
  load: (connId: string) => void;
  /** 新增 / 覆盖保存（同名覆盖内容），保存后刷新列表 */
  save: (connId: string, name: string, sql: string) => Promise<void>;
  /** 删除脚本（按名） */
  remove: (connId: string, name: string) => Promise<void>;
  /** 重命名脚本 */
  rename: (connId: string, oldName: string, newName: string) => Promise<void>;
}

/** 拉取某连接脚本并写入状态（吞掉异常，避免阻塞 UI） */
const refresh = (connId: string) =>
  api
    .listScripts(connId)
    .then((list) => {
      useScriptStore.setState((s) => ({ scriptsByConn: { ...s.scriptsByConn, [connId]: list } }));
    })
    .catch(() => undefined);

export const useScriptStore = create<ScriptState>(() => ({
  scriptsByConn: {},

  load: (connId) => {
    void refresh(connId);
  },

  save: async (connId, name, sql) => {
    await api.saveScript(connId, name, sql);
    await refresh(connId);
  },

  remove: async (connId, name) => {
    await api.deleteScript(connId, name);
    await refresh(connId);
  },

  rename: async (connId, oldName, newName) => {
    await api.renameScript(connId, oldName, newName);
    await refresh(connId);
  },
}));
