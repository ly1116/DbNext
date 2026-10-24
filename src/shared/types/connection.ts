/**
 * 连接领域类型（单一职责：SSH / 数据库 / Redis / Nacos 连接的配置、状态、脱敏摘要、OTP 与 SSH 二次验证）。
 *
 * @since 0.1.0
 */

/** 连接类型枚举 */
export type ConnectionKind = 'ssh' | 'mysql' | 'postgres' | 'oracle' | 'redis' | 'bastion' | 'nacos';

/** 认证方式 */
export type AuthType = 'password' | 'privateKey';

/** OTP 哈希算法（TOTP，RFC 6238；绝大多数 Authenticator / 堡垒机用 sha1） */
export type OtpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/**
 * OTP 动态码条目（TOTP 因子库，如 JumpServer 的 MFA 密钥）。
 *
 * secret（Base32）仅在主进程内存为明文，落盘经 vault 加密；
 * 渲染端只见脱敏的 {@link OtpEntryView}，永不回传 secret。
 */
export interface OtpEntry {
  /** 唯一 ID（保存时主进程生成） */
  id: string;
  /** 展示名称，如「JumpServer (邹鑫)」 */
  label: string;
  /** TOTP 密钥（Base32；仅主进程内存；落盘加密） */
  secret: string;
  /** 哈希算法（默认 sha1） */
  algorithm?: OtpAlgorithm;
  /** 验证码位数（默认 6） */
  digits?: 6 | 8;
  /** 时间步长秒（默认 30） */
  period?: number;
}

/** OTP 条目的脱敏视图（渲染端可见；不含 secret） */
export interface OtpEntryView {
  id: string;
  label: string;
  algorithm?: OtpAlgorithm;
  digits?: 6 | 8;
  period?: number;
}

/** OTP 验证码预览（管理对话框校验密钥用） */
export interface OtpPreview {
  /** 当前验证码 */
  code: string;
  /** 剩余有效秒数 */
  secondsRemaining: number;
}

/** 连接在线状态（运行时，由主进程客户端管理器维护） */
export type ConnectionStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

/** 环境分组（用于左侧连接树归类） */
export type EnvironmentTag = 'prod' | 'staging' | 'dev' | 'bastion';

/**
 * 连接配置（持久化对象）。
 *
 * 凭据字段（password / privateKey / passphrase）在「保存」时由主进程加密，
 * 「加载」时解密回内存；经 IPC 暴露给渲染端的是脱敏后的 {@link ConnectionSummary}。
 */
export interface ConnectionConfig {
  /** 唯一 ID（保存时由主进程生成，若为空则新建） */
  id: string;
  /** 展示名称 */
  name: string;
  /** 连接类型 */
  kind: ConnectionKind;
  /** 主机地址 */
  host: string;
  /** 端口 */
  port: number;
  /** 登录用户名 */
  username: string;
  /** 认证方式（默认口令） */
  authType?: AuthType;
  /** 登录口令（仅主进程内存；落盘加密） */
  password?: string;
  /** 私钥内容（PEM 文本；仅主进程内存；落盘加密） */
  privateKey?: string;
  /** 私钥口令（仅主进程内存；落盘加密） */
  passphrase?: string;
  /** 目标数据库名（mysql / postgres 用；oracle 复用为服务名 service_name） */
  database?: string;
  /** HTTP 上下文路径（nacos 用；默认 /nacos） */
  contextPath?: string;
  /**
   * Nacos 连接方案（API 实现 / 版本）：
   * - 'nacos2'：Nacos 1.x / 2.x（Open API v1，经典 console + cs 接口），默认值；
   * - 'nacos3'：Nacos 3.x（/v3/console/* 新版控制台 API）；
   * - 'rnacos'：r-nacos（Rust 实现，兼容 v1 接口，通常无鉴权）。
   */
  apiVersion?: 'nacos2' | 'nacos3' | 'rnacos';
  /** Oracle SID（与服务名二选一；填了 SID 用 SID 连接，否则用 database 作为服务名） */
  sid?: string;
  /** 环境标签 */
  environment: EnvironmentTag;
  /** 连接分组（UI 树节点） */
  group?: string;
  /** 是否启用 SSH 跳板隧道（mysql/postgres/redis 经 ssh 端口转发） */
  useTunnel?: boolean;
  /** 跳板机连接 ID（引用 ConnectionConfig.id，指向一条 kind=ssh 的连接） */
  tunnelId?: string;
  /** 备注 */
  remark?: string;
  /**
   * 双因素认证（2FA/OTP）配置（SSH 连接）。
   * 关联全局 OTP 条目并在连接时自动计算验证码填入，实现免输入登录。
   * 仅存条目引用与开关，本身无敏感信息（secret 在条目库中加密存储）。
   */
  otp?: {
    /** 关联的 OTP 条目 ID（引用 OtpEntry.id） */
    entryId: string;
    /** 连接时自动计算并填入验证码 */
    autoFill: boolean;
  };
}

/**
 * 脱敏后的连接摘要（渲染端可见）。
 * 不含任何凭据字段，避免敏感信息泄露到渲染进程。
 */
export interface ConnectionSummary {
  id: string;
  name: string;
  kind: ConnectionKind;
  host: string;
  port: number;
  username: string;
  environment: EnvironmentTag;
  group?: string;
  /** 连接配置里填写的默认数据库（未填则 undefined） */
  database?: string;
  useTunnel?: boolean;
  tunnelId?: string;
  remark?: string;
  /** 双因素认证配置（SSH 连接回显用；无敏感信息） */
  otp?: { entryId: string; autoFill: boolean };
  /** 运行时状态（主进程推送，未连接时为 disconnected） */
  status: ConnectionStatus;
}

/**
 * SSH 二次验证请求（keyboard-interactive，如 TOTP / 动态令牌）。
 *
 * 当远端 sshd 启用多因子认证（如 PAM + Google Authenticator），ssh2 在握手阶段
 * 触发 `keyboard-interactive` 事件，主进程把一组提示转发给渲染端弹窗，用户填写后回传。
 * 凭据只在主进程内存存在，动态码不落盘（与 Termius / VS Code 行为一致）。
 */
export interface SshInputRequest {
  /** 请求唯一 ID（渲染端回传时用它对应 pending） */
  requestId: string;
  /** 连接 ID */
  connectionId: string;
  /** 连接展示名（弹窗标题用） */
  connectionName: string;
  /** 服务端认证名称（可能为空），如 'Password authentication' */
  name: string;
  /** 服务端下发说明（可能为空），如「请输入 Authenticator 中的 6 位动态码」 */
  instructions: string;
  /** 一组输入提示（2FA 通常 1 个动态码；也可能先密码后动态码共 2 个） */
  prompts: Array<{ prompt: string; echo: boolean }>;
  /** 预填答案（连接配置了 OTP 条目时，动态码提示框预填当前验证码；用户可一键确认） */
  prefill?: string[];
}

/** 连接树自定义文件夹（持久化；连接通过 group 字段归属某个文件夹名） */
export interface ConnectionFolder {
  /** 文件夹唯一 ID */
  id: string;
  /** 文件夹名（同名为同一文件夹；连接的 group 字段存此名称） */
  name: string;
  /**
   * 所属侧栏作用域：SSH / 数据库 / 注册与配置三棵树各自独立，互不串门。
   * - 'ssh'：SSH / 堡垒机侧栏的文件夹；
   * - 'db'：数据库侧栏的文件夹；
   * - 'nacos'：注册与配置中心侧栏的文件夹。
   * 历史遗留无 scope 的文件夹（scope 缺省）→ 归入 'ssh'，等价于旧版默认行为。
   */
  scope?: 'ssh' | 'db' | 'nacos';
}

/** 取文件夹实际作用域（缺省按 'ssh' 处理） */
export function folderScope(f: ConnectionFolder): 'ssh' | 'db' | 'nacos' {
  return f.scope ?? 'ssh';
}
