/**
 * SQL / 数据库对象领域类型（单一职责：查询结果与分页、脚本、库/表/列/索引/外键/触发器/视图/函数定义）。
 *
 * @since 0.1.0
 */

/** SQL 查询结果集 */
export interface QueryResult {
  /** 列定义 */
  columns: QueryColumn[];
  /** 行数据 */
  rows: Record<string, unknown>[];
  /** 影响/返回行数 */
  rowCount: number;
  /** 执行耗时（毫秒） */
  elapsedMs: number;
  /** 执行的 SQL（回显） */
  sql: string;
  /** 影响的行数（写操作） */
  affectedRows?: number;
}

/** 结果集列定义 */
export interface QueryColumn {
  name: string;
  /** 是否为主键（UI 显示钥匙图标） */
  primaryKey?: boolean;
  /** 是否可空 */
  nullable?: boolean;
  /** 数据类型（驱动提供） */
  dataType?: string;
}

/** 分页执行 SQL 的结果（首查询返回总行数，滚动加载后续页） */
export interface PagedSqlResult {
  /** 本页结果集 */
  result: QueryResult;
  /** 总行数（仅 SELECT 类语句返回；DML 为 null） */
  total: number | null;
  /** 是否还有更多行 */
  hasMore: boolean;
  /** 本页起始偏移 */
  offset: number;
}

/** 脚本单条语句执行结果（runScript 逐条返回） */
export interface ScriptStatementResult {
  /** 语句原文（已 trim，去掉结尾分号） */
  sql: string;
  /** 语句在脚本中的序号（1 起） */
  index: number;
  /** 是否执行成功 */
  ok: boolean;
  /** 耗时 ms */
  elapsedMs: number;
  /** SELECT 类语句返回的行数 */
  rowCount?: number;
  /** DML 影响行数 */
  affectedRows?: number;
  /** SELECT 类语句前 5 行样例（脚本日志里快速预览） */
  sample?: { columns: QueryColumn[]; rows: Record<string, unknown>[] };
  /** 失败时的错误信息 */
  error?: string;
}

/** SQL 脚本整体执行结果：逐条顺序执行，遇错停止（记录 stoppedAt） */
export interface ScriptResult {
  statements: ScriptStatementResult[];
  /** 总耗时 ms */
  totalMs: number;
  /** 因第 N 条失败而停止（1 起）；全部成功为 undefined */
  stoppedAt?: number;
}

/** SQL 脚本（按连接分组，落盘为 userData/scripts/<connId>/<name>.sql 纯文本文件） */
export interface DbScript {
  /** 唯一标识：等于脚本名（文件名去扩展名），按连接唯一 */
  id: string;
  /** 脚本名（不含 .sql 后缀） */
  name: string;
  /** SQL 文本 */
  sql: string;
  /** 最后更新时间戳（毫秒） */
  updatedAt: number;
}

/** 新建数据库规格（Navicat 风格方言化表单：MySQL=字符集+排序规则；PG=属主/编码/排序规则/模板/表空间/连接数上限） */
export interface DbCreateSpec {
  /** 数据库名 */
  name: string;
  // —— MySQL ——
  /** 字符集（utf8mb4/utf8/gbk…） */
  charset?: string;
  /** 排序规则（utf8mb4_general_ci…） */
  collation?: string;
  // —— PostgreSQL ——
  /** 属主（角色名） */
  owner?: string;
  /** 编码（UTF8/LATIN1/GBK…） */
  encoding?: string;
  /** 排序规则 LC_COLLATE（C/POSIX/zh_CN.utf8…） */
  lcCollate?: string;
  /** 字符类型 LC_CTYPE */
  lcCtype?: string;
  /** 模板库（template1/template0） */
  template?: string;
  /** 表空间 */
  tablespace?: string;
  /** 连接数上限（-1 = 不限） */
  connectionLimit?: number;
}

/** 新建数据库对话框的可选项（从目标服务器内省下拉数据源） */
export interface DbCreateOptions {
  kind: 'mysql' | 'postgres' | 'oracle';
  /** MySQL 字符集清单 */
  charsets?: string[];
  /** MySQL 排序规则清单（前端按所选字符集过滤） */
  collations?: { name: string; charset: string }[];
  /** PG 角色（属主下拉） */
  owners?: string[];
  /** PG 表空间 */
  tablespaces?: string[];
  /** PG 模板库 */
  templates?: string[];
  /** PG 编码清单（静态） */
  encodings?: string[];
  /** PG 排序规则清单（pg_collation） */
  pgCollations?: string[];
}

/** 新增字段规格（属性页「新增字段」表单 → ALTER TABLE ADD COLUMN） */
export interface DbColumnSpec {
  /** 字段名 */
  name: string;
  /** 完整列类型（如 varchar(64) / integer / timestamp） */
  fullType: string;
  /** 是否可空 */
  nullable: boolean;
  /** 默认值表达式（原样拼接，如 0 / 'x' / CURRENT_TIMESTAMP） */
  defaultValue?: string;
  /** 注释（PG 走 COMMENT ON COLUMN） */
  comment?: string;
  /** PG 标识列策略（GENERATED ALWAYS/BY DEFAULT AS IDENTITY，仅 smallint/integer/bigint） */
  identity?: 'always' | 'default';
  /** PG 排序规则（COLLATE "xxx"，如 C / zh_CN.utf8） */
  collation?: string;
  /** MySQL 自增（AUTO_INCREMENT，需为主键或索引列） */
  autoIncrement?: boolean;
}

/** 修改字段规格（属性页双击编辑 → ALTER TABLE，仅提交发生变化的字段；其余省略） */
export interface DbColumnAlterSpec {
  /** 新字段名（不重命名则省略） */
  name?: string;
  /** 新完整列类型（如 varchar(128) / integer） */
  fullType?: string;
  /** 是否可空（undefined = 不变） */
  nullable?: boolean;
  /** 默认值表达式（原样拼接，如 0 / CURRENT_TIMESTAMP）；空串 = 移除默认值 */
  defaultValue?: string;
  /** 注释；空串 = 清空注释 */
  comment?: string;
  /** MySQL 自增列修改时必须带上 AUTO_INCREMENT（否则会被移除） */
  autoIncrement?: boolean;
}

export interface DbColumn {
  /** 字段名 */
  name: string;
  /** 数据类型 */
  dataType: string;
  /** 是否可空 */
  nullable: boolean;
  /** 键类型：PRI / UNI / MUL（MySQL）；PG 通常为空 */
  key?: string;
  /** 列序号（表内第几列，从 1 起） */
  ordinal?: number;
  /** 完整类型定义（MySQL column_type，如 varchar(255)；PG 含长度） */
  fullType?: string;
  /** 默认值表达式（CURRENT_TIMESTAMP / nextval(...) 等） */
  defaultValue?: string;
  /** 额外属性（MySQL extra，如 auto_increment） */
  extra?: string;
  /** 列注释（MySQL column_comment / PG pg_description） */
  comment?: string;
  /** 排序规则（MySQL collation_name，如 utf8mb4_general_ci；PG collation_name，如 zh_CN.utf8） */
  collation?: string;
}

/** 表的索引（信息架构内省，跨方言统一结构） */
export interface DbIndex {
  /** 索引名 */
  name: string;
  /** 索引包含的列（有序） */
  columns: string[];
  /** 是否唯一索引 */
  unique: boolean;
  /** 索引方法（PG：btree/hash/gin/gist；MySQL：BTREE/FULLTEXT/SPATIAL；Oracle：NORMAL/BITMAP） */
  method?: string;
  /** 索引注释（PG 可选） */
  comment?: string;
}

/** 表的外键（信息架构内省，跨方言统一结构） */
export interface DbForeignKey {
  /** 约束名 */
  name: string;
  /** 本表外键列（有序，与 refColumns 一一对应） */
  columns: string[];
  /** 引用表（schema.表 或 仅表名） */
  refTable: string;
  /** 引用表的列（有序） */
  refColumns: string[];
  /** 更新规则（NO ACTION / CASCADE / SET NULL / RESTRICT / SET DEFAULT） */
  onUpdate?: string;
  /** 删除规则（同上） */
  onDelete?: string;
}

/** 表的触发器（信息架构内省，跨方言统一结构） */
export interface DbTrigger {
  /** 触发器名 */
  name: string;
  /** 所属表 */
  table: string;
  /** 触发时机（BEFORE / AFTER / INSTEAD OF） */
  timing: string;
  /** 触发事件（INSERT / UPDATE / DELETE，可组合） */
  events: string;
  /** 触发体定义（PG：pg_get_triggerdef 全文；Oracle：TRIGGER_BODY；MySQL：ACTION_STATEMENT） */
  body?: string;
}

/** 对象元数据（表/视图清单页：名称/注释 + 各方言可得的存储统计，DBeaver 点击「表」分类的编辑器视图） */
export interface DbObjectMeta {
  name: string;
  comment?: string;
  /** 估算行数（MySQL TABLE_ROWS / PG reltuples / Oracle NUM_ROWS，基于统计信息，非精确值） */
  rows?: number;
  /** 表数据 + 索引大小（字节；MySQL data_length+index_length / PG pg_total_relation_size） */
  sizeBytes?: number;
  /** 存储引擎（MySQL） */
  engine?: string;
  /** 排序规则（MySQL） */
  collation?: string;
  /** 创建时间（MySQL） */
  createdAt?: string;
  /** 最近更新时间（MySQL InnoDB 可能为空） */
  updatedAt?: string;
  /** 统计信息最近分析时间（Oracle LAST_ANALYZED） */
  analyzedAt?: string;
}

/** 视图/函数/存储过程定义（建对象 DDL 文本，用于「设计」预览与编辑重建） */
export interface DbObjectDef {
  /** 对象名（PG 可能含参数签名） */
  name: string;
  /** 对象类型 */
  kind: 'view' | 'mview' | 'function' | 'procedure';
  /** DDL / 定义文本 */
  ddl: string;
}
