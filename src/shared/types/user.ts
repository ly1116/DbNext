/**
 * 数据库用户与权限领域类型（单一职责：PG 角色 / MySQL 用户 / Oracle 用户的元信息、授权项与差量编辑）。
 *
 * @since 0.1.0
 */

/** 数据库用户/角色（用户与权限管理：PG 角色 / MySQL 用户 / Oracle 用户） */
export interface DbUser {
  /** 用户名（PG 角色名 / MySQL user / Oracle username） */
  name: string;
  /** 连接主机（MySQL 特有：host@user；其他库为空） */
  host?: string;
  /** 是否可登录（PG rolcanlogin；MySQL 恒 true；Oracle ACCOUNT_STATUS 非 LOCKED） */
  canLogin?: boolean;
  /** 是否超级用户/管理员（PG rolsuper / MySQL Super_priv=Y / Oracle 持 DBA 角色） */
  superuser?: boolean;
  /** 是否锁定（MySQL account_locked='Y' / Oracle ACCOUNT_STATUS 含 LOCKED） */
  locked?: boolean;
  /** 口令是否过期（MySQL password_expired='Y' / Oracle EXPIRY_DATE 已过） */
  expired?: boolean;
  /** 认证方式/密码插件（MySQL plugin / Oracle authentication_type） */
  auth?: string;
  /** 创建时间（Oracle created / MySQL 无） */
  created?: string;
  /** 默认表空间/主页（Oracle default_tablespace / PG 暂不支持） */
  home?: string;
  /** 是否数据库内置保留账号（MySQL：mysql.infoschema / mysql.session / mysql.sys 等，不可编辑/删除） */
  builtin?: boolean;
}

/** 用户权限/授权项（用户与权限管理：GRANT 查看与回收） */
export interface DbUserPrivilege {
  /** 权限名（具体权限 或 被授予的角色名） */
  privilege: string;
  /** 授权目标范围（*.* / db.* / schema.table / 全局 / ROLE 等） */
  target?: string;
  /** 是否可转授权限（WITH GRANT OPTION / WITH ADMIN OPTION） */
  grantable?: boolean;
  /** 原始授权语句（MySQL SHOW GRANTS 整行；便于展示/复制） */
  raw?: string;
}

/** 新建用户规格（用户与权限管理：按方言差异化必填/可选字段） */
export interface DbUserSpec {
  /** 用户名 */
  name: string;
  /** 连接主机（MySQL 必填；默认 %） */
  host?: string;
  /** 口令（明文，仅主进程内存，不落盘不回传渲染端） */
  password?: string;
  /** 是否超级用户/管理员（PG SUPERUSER / Oracle 授予 DBA / MySQL 另发 GRANT ALL） */
  superuser?: boolean;
  /** 是否可创建数据库（PG CREATEDB） */
  createDb?: boolean;
  /** 是否可登录（PG LOGIN；MySQL/Oracle 恒 true，忽略） */
  canLogin?: boolean;
  /** 默认表空间（Oracle DEFAULT TABLESPACE / PG 暂不支持） */
  tablespace?: string;
}

/** 修改用户权限规格（差量：仅提交变化的部分；按方言忽略无关字段） */
export interface DbUserPrivEdit {
  /** PG 角色属性开关（ALTER ROLE ... WITH；MySQL 只认 locked/expired → ALTER USER ACCOUNT LOCK / PASSWORD EXPIRE） */
  attrs?: Partial<Record<'login' | 'superuser' | 'createDb' | 'createRole' | 'replication' | 'inherit' | 'locked' | 'expired', boolean>>;
  /** PG：授予/回收的组成员角色（GRANT/REVOKE role TO/FROM user） */
  grantRoles?: string[];
  revokeRoles?: string[];
  /** MySQL：全局权限（ON *.*）差量；Oracle：系统权限/角色差量（GRANT/REVOKE priv TO/FROM user） */
  grantPrivs?: string[];
  revokePrivs?: string[];
  /** MySQL：随 GRANT 附 WITH GRANT OPTION */
  grantOption?: boolean;
}
