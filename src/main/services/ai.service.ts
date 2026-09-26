import OpenAI from 'openai';
import type { AiMessage, AiModelConfig, AiSettings } from '@shared/types';
import { createLogger } from '../logger';
import { loadAiSettings, saveAiSettings } from '../services/connection-store';
import { execOnSsh } from './ssh.service';
import { runSql } from './sql.service';

/**
 * AI 服务（真实实现，OpenAI 兼容）。
 *
 * 读取持久化的 AI 设置（baseURL / model / apiKey），调用真实 LLM 接口并流式返回增量。
 * 支持任意 OpenAI 兼容网关（含自建/代理）。无 mock 回复。
 *
 * 当存在「当前 SSH 连接」时，会向模型开放 run_ssh_command 工具：模型可自行在真实主机上
 * 执行命令（如 df -h / free -m）并基于真实返回作答，而非给出通用猜测。
 *
 * @since 0.1.0
 */
const logger = createLogger('ai');

/** 读取 AI 设置 */
export function getSettings(): AiSettings {
  return loadAiSettings();
}

/** 保存 AI 设置（apiKey 落盘前由 store 加密） */
export function updateSettings(s: AiSettings): AiSettings {
  saveAiSettings(s);
  return loadAiSettings();
}

/**
 * 从已配置模型列表中选出对话要用的模型：
 * 优先用调用方指定的 modelId，否则取「默认」标记的那个，再退化为列表第一条。
 */
export function resolveModel(modelId?: string): AiModelConfig {
  const { models } = loadAiSettings();
  if (!models.length) throw new Error('尚未在「设置 → AI 助手」中配置任何模型');
  const picked = (modelId && models.find((m) => m.id === modelId)) || models.find((m) => m.isDefault) || models[0];
  if (!picked.apiKey) throw new Error(`模型「${picked.name}」缺少 API Key`);
  return picked;
}

/**
 * 随对话注入的当前连接信息（SSH 可执行命令；数据库连接可执行只读 SQL）。
 */
export interface AiConnContext {
  /** 连接 ID（主进程侧据此取已建立的 ssh2 / mysql2 / pg / oracle 连接） */
  id: string;
  /** 展示标签，如「192.168.31.100 (root)」 */
  label: string;
  /** 连接类型：ssh / bastion / mysql / postgres / oracle（决定开放哪类工具） */
  kind?: string;
}

/** AI 可调用工具：在真实 SSH 主机上执行命令 */
const SSH_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'run_ssh_command',
    description:
      '在用户当前已连接的 SSH 主机上执行一条 shell 命令并取回完整输出（stdout / stderr / 退出码）。用于获取真实服务器状态，而不是凭空猜测。' +
      '常用场景：磁盘容量用 `df -h`；内存用 `free -m`；CPU 负载用 `top -bn1 | head` 或 `uptime`；' +
      '目录大小用 `du -sh <路径>`；系统信息用 `uname -a`；服务状态用 `systemctl status <服务名>`。' +
      '命令在非交互式环境执行，请勿使用需交互确认的命令（如 vi / less / top 无参数）。仅在已存在当前 SSH 连接时可用。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要在远端执行的完整 shell 命令，例如 "df -h"' },
      },
      required: ['command'],
    },
  },
};

/** AI 可调用工具：在当前数据库连接上执行只读 SQL 并返回真实结果集 */
const SQL_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'run_sql_query',
    description:
      '在用户当前已连接的数据库上执行一条只读 SQL（SELECT / WITH / SHOW / EXPLAIN），返回真实结果集。' +
      '用于用真实数据回答用户的数据问题（统计、查询、对比），而不是猜测。' +
      '约束：仅允许单条只读语句，禁止 INSERT/UPDATE/DELETE/DDL 等写操作；返回最多 50 行。' +
      '不确定表结构时，可先执行 information_schema（MySQL/PG）或 user_tables/all_tables（Oracle）查询获取表与列清单。',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '要执行的完整只读 SQL，例如 "SELECT count(*) FROM orders"' },
      },
      required: ['sql'],
    },
  },
};

/** 只读 SQL 白名单前缀（小写比较） */
const READONLY_PREFIXES = ['select', 'with', 'show', 'explain', 'desc', 'describe', 'table'];

/**
 * 校验并清洗 AI 提交的 SQL：仅允许单条只读语句。
 * 返回清洗后的 SQL；不合法时抛错（错误信息会回灌给模型自行纠正）。
 */
function assertReadonlySql(raw: string): string {
  // 去注释（-- 行注释 与 /​* 块注释 */）、折行
  const stripped = raw
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+\s*$/, '');
  if (!stripped) throw new Error('SQL 为空');
  if (stripped.includes(';')) throw new Error('仅允许单条语句，请去掉多余分号拆成多次调用');
  const head = stripped.split(/\s/)[0].toLowerCase();
  if (!READONLY_PREFIXES.includes(head)) {
    throw new Error(`仅允许只读查询（SELECT/WITH/SHOW/EXPLAIN 等），拒绝执行 "${head}" 开头的语句`);
  }
  return stripped;
}

/** 格式化查询结果为模型可读文本（限 50 行，防撑爆上下文） */
function formatRows(r: { columns: { name: string }[]; rows: Record<string, unknown>[]; rowCount: number }): string {
  const MAX = 50;
  const cols = r.columns.map((c) => c.name);
  const lines = [cols.join(' | '), '-'.repeat(Math.min(cols.join(' | ').length, 200))];
  const shown = r.rows.slice(0, MAX);
  for (const row of shown) lines.push(cols.map((c) => (row[c] === null || row[c] === undefined ? 'NULL' : String(row[c]))).join(' | '));
  if (r.rows.length > MAX) lines.push(`…（共 ${r.rows.length} 行，仅显示前 ${MAX} 行）`);
  return `列: ${cols.join(', ')}\n行数: ${r.rows.length}\n${lines.join('\n')}`;
}

/**
 * 执行一个 SQL 工具调用，返回可供模型消费的结果文本。
 */
async function invokeSqlTool(conn: AiConnContext, argsJson: string): Promise<string> {
  let sql = '';
  try {
    sql = (JSON.parse(argsJson).sql as string) ?? '';
  } catch {
    return '工具参数解析失败（非合法 JSON）';
  }
  try {
    const clean = assertReadonlySql(sql);
    const r = await runSql(conn.id, clean);
    return `SQL: ${clean}\n${formatRows(r)}`;
  } catch (e) {
    return `SQL 执行失败: ${(e as Error).message}`;
  }
}

/**
 * 组装系统提示：把当前连接上下文 + 工具使用指引写进去。
 */
function buildSystem(context: string[] | undefined, conn: AiConnContext | undefined): string {
  const parts: string[] = [
    '你正在协助用户运维与排查远端服务器/数据库。请基于真实信息作答，不要编造。',
  ];
  const isDb = conn?.kind === 'mysql' || conn?.kind === 'postgres' || conn?.kind === 'oracle';
  if (conn && isDb) {
    parts.push(
      `当前用户已连接的数据库：${conn.label}（${conn.kind}）。当用户询问真实数据（某表内容、统计、占比、对比等）时，` +
        '请调用 run_sql_query 工具执行只读 SQL 获取真实结果并据此作答，不要给出猜测数字。' +
        '不确定表/列名时，先查 information_schema（MySQL/PG）或 user_tables/all_tables+user_tab_columns（Oracle）确认结构再查询；' +
        '写查询时表名/列名注意方言（PG 小写、Oracle 大写）。回答时给出关键 SQL 与结论。',
    );
  } else if (conn) {
    parts.push(
      `当前用户已连接的 SSH 主机：${conn.label}。当需要该主机的真实状态（磁盘、内存、CPU、目录大小、服务状态等）时，` +
        '请调用 run_ssh_command 工具在真实主机上执行命令并依据返回结果作答，不要给出通用占位答案。',
    );
  } else {
    parts.push('当前没有可用的连接，请基于用户给出的上下文与自身知识作答；若用户问及某台服务器/数据库的真实状态，请先提示其在左侧连接并选中该主机。');
  }
  if (context && context.length) {
    parts.push('相关上下文：\n' + context.join('\n'));
  }
  return parts.join('\n');
}

/**
 * 执行一个 SSH 工具调用，返回可供模型消费的结果文本。
 */
async function invokeSshTool(conn: AiConnContext, name: string, argsJson: string): Promise<string> {
  if (name !== 'run_ssh_command') return '未知工具';
  let command = '';
  try {
    command = (JSON.parse(argsJson).command as string) ?? '';
  } catch {
    return '工具参数解析失败（非合法 JSON）';
  }
  if (!command.trim()) return '命令为空';
  try {
    const r = await execOnSsh(conn.id, command);
    return `命令: ${command}\n退出码: ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
  } catch (e) {
    return `命令执行失败: ${(e as Error).message}`;
  }
}

/**
 * 发起一次真实对话（流式，支持工具调用）。
 * @param history 对话历史
 * @param context 可选上下文（远端路径 / SQL / 文件内容），注入为系统提示
 * @param onDelta 每收到一个增量片段回调（仅最终自然语言答复会被流式推送）
 * @param modelId 可选：指定使用的模型配置 ID（不传则取默认模型）
 * @param conn 可选：当前 SSH 连接上下文（传入则开放 run_ssh_command 工具）
 */
export async function ask(
  history: AiMessage[],
  context: string[] | undefined,
  onDelta: (delta: string) => void,
  modelId?: string,
  conn?: AiConnContext,
): Promise<string> {
  const model = resolveModel(modelId);
  const client = new OpenAI({ apiKey: model.apiKey, baseURL: model.baseURL || undefined });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: buildSystem(context, conn) }];
  for (const m of history) {
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }

  const isDbConn = conn?.kind === 'mysql' || conn?.kind === 'postgres' || conn?.kind === 'oracle';
  const tools = conn ? (isDbConn ? [SQL_TOOL] : [SSH_TOOL]) : undefined;
  let full = '';

  try {
    full = await runToolLoop(client, model.model, messages, tools, conn, onDelta);
  } catch (e) {
    // 部分网关/模型不支持 tools：降级为无工具的纯对话，至少给出通用答复
    const msg = (e as Error).message;
    if (tools && /tool|function|not support|unsupported/i.test(msg)) {
      logger.warn(`模型不支持 tools，降级纯对话: ${msg}`);
      full = await runToolLoop(client, model.model, messages, undefined, undefined, onDelta);
    } else {
      throw e;
    }
  }
  return full;
}

/**
 * 带工具调用的对话循环（流式）：
 * - 先发一轮（带 tools），若模型产出了 tool_calls，则在主进程真实执行 SSH 命令，
 *   把结果作为 tool 消息回灌，继续下一轮，直到模型给出最终自然语言答复。
 * - 最多 5 轮，防止异常循环。
 */
async function runToolLoop(
  client: OpenAI,
  modelName: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  tools: OpenAI.Chat.ChatCompletionTool[] | undefined,
  conn: AiConnContext | undefined,
  onDelta: (delta: string) => void,
): Promise<string> {
  let full = '';
  for (let round = 0; round < 5; round++) {
    const stream = await client.chat.completions.create({
      model: modelName,
      messages,
      stream: true,
      temperature: 0.3,
      ...(tools ? { tools } : {}),
    });
    let content = '';
    const calls: Record<number, { name?: string; arguments?: string }> = {};
    for await (const part of stream) {
      const d = part.choices[0]?.delta;
      if (d?.content) {
        content += d.content;
        full += d.content;
        onDelta(d.content);
      }
      if (d?.tool_calls) {
        for (const tc of d.tool_calls) {
          const idx = tc.index ?? 0;
          calls[idx] = calls[idx] ?? {};
          if (tc.function?.name) calls[idx].name = (calls[idx].name ?? '') + tc.function.name;
          if (tc.function?.arguments) calls[idx].arguments = (calls[idx].arguments ?? '') + tc.function.arguments;
        }
      }
    }
    const list = Object.values(calls).filter((c) => c.name);
    if (!list.length) break; // 没有工具调用 = 最终答复，结束

    // 把 assistant 的工具调用消息追加进去
    const toolCallMsgs = list.map((c, i) => ({
      id: `call_${round}_${i}`,
      type: 'function' as const,
      function: { name: c.name ?? '', arguments: c.arguments ?? '{}' },
    }));
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCallMsgs });
    if (conn) {
      for (let i = 0; i < toolCallMsgs.length; i++) {
        const name = toolCallMsgs[i].function.name;
        // 按工具名路由：run_sql_query → 数据库只读查询；run_ssh_command → SSH 命令
        const out = name === 'run_sql_query' ? await invokeSqlTool(conn, toolCallMsgs[i].function.arguments) : await invokeSshTool(conn, name, toolCallMsgs[i].function.arguments);
        messages.push({ role: 'tool', tool_call_id: toolCallMsgs[i].id, content: out });
      }
    }
  }
  return full;
}
