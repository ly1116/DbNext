/**
 * 存储过程 / 函数 / 序列领域类型（单一职责：Oracle 例程参数、执行、DBMS_DEBUG 调试与会话状态，以及序列信息）。
 *
 * @since 0.1.0
 */

/** 存储过程/函数参数（执行器据此生成调用与绑定变量） */
export interface RoutineParam {
  /** 参数序号（0 起，含函数的返回值时返回值是第 0 个） */
  position: number;
  /** 参数名 */
  name: string;
  /** IN / OUT / INOUT */
  mode: 'IN' | 'OUT' | 'INOUT' | 'RETURN';
  /** 数据类型名（Oracle 为 ALL_ARGUMENTS.ARG_TYPE 如 NUMBER/VARCHAR2） */
  dataType: string;
  /** 是否有默认值（Oracle DEFAULTED='Y'） */
  hasDefault: boolean;
  /** 必填（IN 且无默认值） */
  required: boolean;
}

/** 执行存储过程/函数的请求 */
export interface RoutineExecRequest {
  connectionId: string;
  schema: string;
  name: string;
  /** 形参名 → 实参文本值（IN / INOUT 传值；OUT 可不传） */
  args: Record<string, string>;
  /** 是否自动提交（Oracle DDL/DML 默认 true） */
  autoCommit?: boolean;
}

/** 执行存储过程/函数的结果（OUT/INOUT 回填 + 耗时 + 提示信息） */
export interface RoutineExecResult {
  /** OUT / INOUT 参数的回填值（键为参数名） */
  outputs: Record<string, string | null>;
  /** 耗时（ms） */
  elapsedMs: number;
  /** 成功信息 / 提示（如 DBMS_OUTPUT 收集到的内容） */
  message?: string;
}

/** 调试会话当前状态 */
export interface RoutineDebugState {
  /** 会话 id（调试全程持有，主进程保存 DBMS_DEBUG 会话） */
  sessionId: string;
  /** 当前所处源码行号（1 起） */
  line: number;
  /** 该行附近的源码（便于渲染断点上下文） */
  sourceLine?: string;
  /** 作用域内的变量名与当前值（调试核心：看到变量的值） */
  variables: { name: string; value: string | null; type?: string }[];
  /** 已执行完（正常结束） */
  finished: boolean;
  /** 异常信息（出错时） */
  error?: string;
}

/** 序列信息（当前值/上下限/步长，用于序列浏览器） */
export interface DbSequenceInfo {
  /** 序列名 */
  name: string;
  /** 当前值（PG last_value / Oracle last_number；从未调用可能为 null） */
  currentValue: number | null;
  /** 最小值 */
  minValue: number | null;
  /** 最大值 */
  maxValue: number | null;
  /** 步长 */
  increment: number | null;
  /** 是否循环 */
  cycle: boolean;
}
