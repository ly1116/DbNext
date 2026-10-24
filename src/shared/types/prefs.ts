/**
 * 偏好与主题类型（单一职责：通用偏好与配色方案枚举）。
 *
 * @since 0.1.0
 */

/** 配色方案（UI 与终端共用，设置 → 系统 → 外观 → 配色方案）。仅保留深色 + 浅色两套。 */
export type ThemeName = 'darcula' | 'light' | 'glass';

/**
 * 通用偏好（主进程持久化，设置表单即时生效）。
 *
 * 渲染端修改后通过 `PREFS_SET` 写回；终端字号、默认模型等被 UI 直接消费。
 * 敏感字段不存在于此（凭据一律走连接配置加密存储）。
 */
export interface GeneralPrefs {
  /** 默认终端类型（ssh 会话协议） */
  defaultShell: 'bash' | 'zsh' | 'sh' | 'powershell';
  /** 启动时是否确认连接会话 */
  confirmOnStartup: boolean;
  /** 默认 SFTP 根目录（SSH/SFTP 会话初始路径） */
  defaultSftpDir: string;
  /** 默认命令目录（终端启动时 cd 到） */
  defaultCmdDir: string;
  /** 终端字体大小（px） */
  fontSize: number;
  /** 配色方案 */
  theme: ThemeName;
  /** 默认 AI 模型 ID（引用 AiModelConfig.id；空则用模型列表中的 isDefault） */
  defaultModelId: string;
  /** 自动保存间隔（秒；0 = 关闭） */
  autoSaveIntervalSec: number;
  /** 会话保留时长（分钟；0 = 关闭即清除） */
  sessionRetentionMin: number;
  /** 结果集行数上限（查询页展示行数防大表拖垮界面；0 = 不限制） */
  maxResultRows: number;
  /** 查询超时（秒；0 = 不限制） */
  queryTimeoutSec: number;
  /** 危险 SQL 确认：无 WHERE 的 UPDATE/DELETE 或 DROP/TRUNCATE 执行前弹确认 */
  dangerousSqlConfirm: boolean;
  /** 只读模式：查询页禁止执行非查询语句 */
  readOnlyMode: boolean;
  /** 终端回滚行数（scrollback） */
  terminalScrollback: number;
  /** 终端光标样式 */
  cursorStyle: 'block' | 'bar' | 'underline';
  /** 终端光标闪烁 */
  cursorBlink: boolean;
  /** 选中即复制 */
  copyOnSelect: boolean;
  /** 右键直接粘贴（关闭 = 弹出复制/粘贴菜单） */
  rightClickPaste: boolean;
  /** 断线自动重连：连接恢复后自动重开 shell */
  autoReconnect: boolean;
  /** SQL 编辑器自动补全开关 */
  sqlAutoComplete: boolean;
  /** SQL 关键字大写（补全提示按大写展示） */
  sqlUppercaseKeywords: boolean;
  /** @ai 上下文附带的表数量上限（控制 token 消耗） */
  aiContextTables: number;
  /** SSH 连接超时（秒） */
  sshConnectTimeoutSec: number;
  /** SSH KeepAlive 间隔（秒；0 = 关闭） */
  sshKeepaliveIntervalSec: number;
  /** 默认私钥路径（连接未内置私钥时回退读取） */
  sshDefaultPrivateKey: string;
  /** 关闭窗口最小化到系统托盘（连接后台保持；从托盘菜单退出才真正关闭） */
  closeToTray: boolean;
  /** 界面整体缩放（0.9~1.5，1 = 100%） */
  zoomFactor: number;
}

/** 通用偏好默认值 */
export const DEFAULT_PREFS: GeneralPrefs = {
  defaultShell: 'bash',
  confirmOnStartup: true,
  defaultSftpDir: '/root',
  defaultCmdDir: '/',
  fontSize: 15,
  theme: 'light',
  defaultModelId: '',
  autoSaveIntervalSec: 30,
  sessionRetentionMin: 0,
  maxResultRows: 1000,
  queryTimeoutSec: 30,
  dangerousSqlConfirm: true,
  readOnlyMode: false,
  terminalScrollback: 5000,
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
  rightClickPaste: false,
  autoReconnect: false,
  sqlAutoComplete: true,
  sqlUppercaseKeywords: true,
  aiContextTables: 50,
  sshConnectTimeoutSec: 20,
  sshKeepaliveIntervalSec: 15,
  sshDefaultPrivateKey: '',
  closeToTray: false,
  zoomFactor: 1,
};
