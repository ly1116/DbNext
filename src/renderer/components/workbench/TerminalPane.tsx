import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { api } from '@renderer/api';
import { usePrefs } from '@renderer/store/prefsStore';
import { useConnections } from '@renderer/store/connectionStore';
import { terminalTheme } from '@renderer/theme/terminal-themes';
import { Empty } from '@renderer/components/common/States';

/**
 * 终端不向远端 shell 注入任何初始化脚本（提示符/别名/OSC 7 注入均已移除）：
 * 连接建立后原样呈现远端 shell，零回显、零副作用。
 * OSC 7 解析保留：远端若自带该序列则跟随 cwd，没有也不影响。
 *
 * 「@ai 提问」为纯本地拦截：回车时读取 xterm 缓冲里的当前输入行，若含 @ai 记号则
 * 不把该行发给远端 shell，改为调 AI（带本连接上下文，模型可用 run_ssh_command 在
 * 真实主机核实），回答以流式写入终端，结束后整段按 Markdown 渲染为 ANSI 富文本
 * （标题/粗体/表格/代码块着色）。远端 shell 本身零感知。
 */

/** 从远端数据流中解析 OSC 7 序列（file://host/path），返回 path；无则返回 null */
function parseOsc7(data: string): string | null {
  const re = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b\\]*)/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(data)) !== null) last = m[1];
  return last;
}

/**
 * 从 bash 默认提示符行尾解析 cwd（OSC 7 之外的纯本地兜底，不向远端注入任何命令）：
 * - CentOS/RHEL 风格：[root@host ~]# / [root@host /opt]#
 * - Ubuntu/Debian 风格：root@host:~# / user@host:~/dir$
 * ~ 按用户名推断家目录（root → /root，其余 → /home/<user>）。
 * 只认缓冲区末尾的「裸提示符行」：命令回显行（提示符后跟命令文本）不会命中。
 */
function parsePromptCwd(tail: string): string | null {
  // 格式 A：[user@host path]# / $
  let m = /(?:^|\r?\n)\[([A-Za-z_][\w.-]*)@[^\]\s]+\s+([^\]]+)\]\s*[#$][ \t]*$/.exec(tail);
  // 格式 B：user@host:path# / $
  if (!m) m = /(?:^|\r?\n)([A-Za-z_][\w.-]*)@[^\s:]+:([^\s#$]+)\s*[#$][ \t]*$/.exec(tail);
  if (!m) return null;
  const user = m[1];
  const raw = (m[2] || '').trim();
  if (!raw) return null;
  const home = user === 'root' ? '/root' : `/home/${user}`;
  let p: string;
  if (raw === '~') p = home;
  else if (raw.startsWith('~/')) p = home + raw.slice(1);
  else if (raw.startsWith('/')) p = raw;
  else return null; // 其它形态（如 git 分支后缀混入）不可靠，忽略
  return p;
}

/** 从 xterm 缓冲读取当前输入行（向上合并软换行行；含提示符文本，@ai 提取时按记号定位无影响） */
function readInputLine(term: Terminal): string {
  try {
    const buf = term.buffer.active;
    let y = buf.cursorY;
    const cur = buf.getLine(y);
    if (!cur) return '';
    let text = cur.translateToString(true);
    while (y > 0) {
      const prev = buf.getLine(y - 1);
      if (!prev || !prev.isWrapped) break;
      text = prev.translateToString(true) + text;
      y--;
    }
    return text;
  } catch {
    return '';
  }
}

/** 提取行内最后一个 @ai 记号之后的指令文本；无 @ai 或其后为空返回 null（不拦截）。
 *  记号边界要求后面是空白或行尾（`@ai(?![\w-])`），避免误匹配主机名/路径里的 `@ai-xxx` */
function extractAiInstruction(line: string): string | null {
  const re = /@ai(?![\w-])/gi;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) last = m;
  if (!last) return null;
  const after = line.slice(last.index + last[0].length).trim();
  return after || null;
}

/**
 * Markdown → 终端纯文本（整段转换，只在回答结束后调用一次）。
 *
 * 刻意不做「逐块流式转换」：跨块拆开的标记（`**` 被切成 `*`+`*`）用逐块正则/状态机
 * 都无法可靠还原（实测逐字符/随机切块都会漏标记甚至吞字）。
 * 因此流式阶段原样输出增量（可能短暂看到 ** / ` 等符号），结束后整段转换定稿。
 */
/**
 * Markdown → 终端富文本渲染（ANSI）。
 *
 * 终端虽是纯文本环境，但可用 ANSI 转义序列还原 Markdown 的视觉层次（类似 glow / mdcat）：
 * - 标题：加粗 + 青色（# 越多越亮）
 * - **粗体** / *斜体* / ~~删除线~~
 * - `行内代码`：灰底前景
 * - 代码块：整块保留原文，围栏用暗色横线替代
 * - 表格：保留对齐竖线，表头加粗
 * - 有序/无序列表、项目符号着色
 * - 引用块、暗色
 *
 * 整段转换，只在回答结束后调用一次（流式阶段原样输出，避免跨块标记错乱）。
 */
function mdToAnsi(s: string): string {
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;

  const inline = (t: string): string =>
    t
      // 行内代码（先处理，避免其内部的 * 被当作强调）
      .replace(/`([^`\n]+)`/g, (_m, c: string) => `\x1b[90m\x1b[107m ${c} \x1b[0m`)
      // 链接：显示文字 + 暗色 URL
      .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, a: string, b: string) => `\x1b[36m${a}\x1b[0m \x1b[90m${b}\x1b[0m`)
      // 粗斜体 / 粗体 / 斜体 / 删除线
      .replace(/\*\*\*([^*]+)\*\*\*/g, (_m, c: string) => `\x1b[1m\x1b[3m${c}\x1b[0m`)
      .replace(/\*\*([^*]+)\*\*/g, (_m, c: string) => `\x1b[1m${c}\x1b[0m`)
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。：:；;]|$)/g, (_m, p: string, c: string) => `${p}\x1b[3m${c}\x1b[0m`)
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,，。：:；;]|$)/g, (_m, p: string, c: string) => `${p}\x1b[3m${c}\x1b[0m`)
      .replace(/~~([^~]+)~~/g, (_m, c: string) => `\x1b[2m${c}\x1b[0m`);

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];

    // —— 代码块围栏 ——
    const fence = /^[ \t]*```([^\n]*)$/.exec(raw);
    if (fence) {
      // 开围栏：先空一行分隔；关围栏：留一个空行
      if (!inFence) {
        if (out.length && out[out.length - 1] !== '') out.push('');
        inFence = true;
      } else {
        inFence = false;
        out.push('');
      }
      continue;
    }
    if (inFence) {
      out.push(`\x1b[93m${raw}\x1b[0m`); // 命令原文用黄色，醒目可复制
      continue;
    }

    // —— 表格 ——
    if (raw.includes('|') && /^[ \t]*\|?[^\n]*\|/.test(raw)) {
      // 对齐分隔行不渲染
      if (/^[ \t]*\|[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(raw)) continue;
      const isHeader = idx + 1 < lines.length && /^[ \t]*\|[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/.test(lines[idx + 1]);
      // split 出的首尾元素通常是空串（行首/行尾的竖线），过滤掉再算列数
      const cells = raw.split('|').map((c) => c.trim()).filter((c, i, arr) => !(c === '' && (i === 0 || i === arr.length - 1)));
      if (isHeader) {
        out.push(`\x1b[1m\x1b[36m${cells.join(' | ')}\x1b[0m`);
        // 分隔线按「列数」画，而不是单元格数
        out.push(`\x1b[90m${cells.map(() => '──────').join('─┼─')}\x1b[0m`);
      } else {
        out.push(cells.join(' \x1b[90m|\x1b[0m '));
      }
      continue;
    }

    // —— 标题 ——
    const h = /^[ \t]*(#{1,6})[ \t]+(.*)$/.exec(raw);
    if (h) {
      const level = h[1].length;
      // # → 亮青加粗，## → 青，###+ → 亮青但弱化
      const color = level <= 2 ? '\x1b[1m\x1b[96m' : level === 3 ? '\x1b[1m\x1b[36m' : '\x1b[1m\x1b[96m';
      out.push(`${color}${inline(h[2])}\x1b[0m`);
      continue;
    }

    // —— 水平分割线 ——
    if (/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(raw)) {
      out.push('\x1b[90m' + '─'.repeat(48) + '\x1b[0m');
      continue;
    }

    // —— 引用块 ——
    const quote = /^[ \t]*>[ \t]?(.*)$/.exec(raw);
    if (quote) {
      out.push(`\x1b[2m\x1b[36m│ \x1b[0m\x1b[2m${inline(quote[1])}\x1b[0m`);
      continue;
    }

    // —— 列表 ——
    const ul = /^([ \t]*)([-*+])[ \t]+(.*)$/.exec(raw);
    if (ul) {
      out.push(`${ul[1]}\x1b[36m${ul[2]}\x1b[0m ${inline(ul[3])}`);
      continue;
    }
    const ol = /^([ \t]*)(\d+\.)[ \t]+(.*)$/.exec(raw);
    if (ol) {
      out.push(`${ol[1]}\x1b[36m${ol[2]}\x1b[0m ${inline(ol[3])}`);
      continue;
    }

    if (raw.trim() === '') {
      out.push('');
      continue;
    }
    out.push(inline(raw));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
}

/** 提取行内 @ai 记号之前的用户输入起点（用于把输入文字留在屏幕上）；无 @ai 返回 -1 */
function aiTypedStart(line: string): number {
  const m = /@ai(?![\w-])/i.exec(line);
  return m ? m.index : -1;
}

/** 终端写入（\n → \r\n；实例已销毁时静默忽略） */
function termWrite(term: Terminal, text: string): void {
  try {
    term.write(text.replace(/\r?\n/g, '\r\n'));
  } catch {
    /* 终端已 dispose */
  }
}

/** 终端实例序号：每次 effect 运行（含 StrictMode 双跑/重连/HMR 重挂载）分配唯一 sessionKey，
 *  使主进程按实例精确建/销会话，杜绝「旧实例 shell 泄漏在远端主机」导致的重复连接 */
let paneSeq = 0;

/**
 * 终端右键上下文菜单的状态形状（相对视口的坐标，用 fixed 定位）。
 */
interface CtxMenu {
  x: number;
  y: number;
}

/**
 * SSH 终端面板（真实实现）。
 *
 * 用 xterm 渲染真实远端 shell：键盘输入经 `api.terminalWrite` 发往主进程的 ssh2 shell，
 * 远端输出经 `api.onTerminalData` 回流并显示。无任何 mock 回显。
 * 需要一条已连接的 SSH / 堡垒机连接 id；未提供时提示先连主机。
 *
 * 复制 / 粘贴（XTerminal 风格）：
 * - Ctrl+C：有选区时复制选区到系统剪贴板；无选区时放行给 shell（即 SIGINT 中断）。
 * - Ctrl+V / Shift+Insert：从系统剪贴板粘贴到终端。
 * - Ctrl+Shift+C：复制（即使无选区也能复制当前选中，等价于 Ctrl+C 有选区时）。
 * - 右键：弹出「复制 / 粘贴 / 全选 / 清除选中」菜单。
 *
 * 字体大小与配色方案来自「设置」通用偏好，修改即时生效（无需重开会话）。
 *
 * @since 0.1.0
 */
export function TerminalPane({ connectionId, active }: { connectionId: string | null; hostLabel?: string; active?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const fontSize = usePrefs((s) => s.prefs.fontSize);
  const themeName = usePrefs((s) => s.prefs.theme);
  const scrollback = usePrefs((s) => s.prefs.terminalScrollback);
  const cursorStyle = usePrefs((s) => s.prefs.cursorStyle);
  const cursorBlink = usePrefs((s) => s.prefs.cursorBlink);
  const rightClickPaste = usePrefs((s) => s.prefs.rightClickPaste);
  const autoReconnect = usePrefs((s) => s.prefs.autoReconnect);
  // 连接状态（来自全局推送）：断线自动重连用
  const connStatus = useConnections((s) => s.connections.find((c) => c.id === connectionId)?.status);
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  // 连接就绪前显示加载遮罩（同时兜住初始化期间的任何回显泄漏）
  const [ready, setReady] = useState(false);
  /** 当前 effect 实例的会话键（resize 等旁路 effect 用它把请求路由到本实例会话） */
  const sessionKeyRef = useRef('0');
  // @ai 回答进行中标记：同一终端同一时刻只跑一轮 AI，避免两次提问的输出交错
  const aiBusyRef = useRef(false);
  // 当前 @ai 提问的流式订阅退订函数（卸载时兜底清理）
  const aiChunkOffRef = useRef<(() => void) | null>(null);
  // 终端背景色跟随所选配色方案，避免容器与 xterm 画布出现色差
  const termBg = useMemo(() => terminalTheme(themeName).background ?? '#1e1e1e', [themeName]);

  useEffect(() => {
    if (!connectionId || !containerRef.current) return;
    setReady(false);
    const { fontSize: fs, theme, terminalScrollback: sb, cursorStyle: cs, cursorBlink: cb } = usePrefs.getState().prefs;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: fs,
      theme: terminalTheme(theme),
      cursorBlink: cb,
      cursorStyle: cs,
      scrollback: sb,
      convertEol: true,
      // 暗色背景下保证任何 ANSI 颜色与背景至少有 4.5:1 对比度，暗淡色自动提亮
      minimumContrastRatio: 4.5,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch { /* 容器未布局时忽略 */ }
    termRef.current = term;
    fitRef.current = fit;

    const cols = term.cols;
    const rows = term.rows;
    // 本实例专属会话键：write/resize/exit/数据过滤都按它精确路由
    const sessionKey = `p${++paneSeq}`;
    sessionKeyRef.current = sessionKey;

    // 先订阅、后建会话：主进程在 TERMINAL_CREATE 处理期间就可能开始推送 shell 数据
    // （本地主机 shell 秒开，早于 invoke 响应回达渲染端），此时若尚未订阅会丢失
    // 首屏横幅/提示符（表现为「连上后终端一片空白」）。订阅动作同步先于 invoke 发出，
    // 且按 sessionKey（经 ref 读取，断线重连换键后同一订阅继续有效）过滤，
    // 旧实例/他标签的数据不会串扰。
    // 累计尾部缓冲：bash 默认提示符可能被数据块切开，跨块拼接后再解析行尾提示符
    let tail = '';
    const off = api.onTerminalData((cid, key, data) => {
      if (cid === connectionId && key === sessionKeyRef.current) {
        tail = (tail + data).slice(-256);
        const cwd = parseOsc7(data) ?? parsePromptCwd(tail);
        if (cwd) useConnections.getState().setCwd(connectionId, cwd);
        term.write(data);
      }
    });

    // 选中即复制（偏好关闭时不动作；每次松开选区实时读偏好，改设置即时生效）
    const offSel = term.onSelectionChange(() => {
      if (usePrefs.getState().prefs.copyOnSelect && term.hasSelection()) {
        void api.clipboardWrite(term.getSelection());
      }
    });

    api
      .terminalCreate(connectionId, { cols, rows }, sessionKey)
      .then(() => {
        setReady(true);
        termWrite(
          term,
          '\x1b[90m提示：输入 @ai ＋ 问题，直接向 AI 提问（AI 可在本机执行命令核实）\x1b[0m\r\n',
        );
      })
      .catch((e) => {
        setReady(true);
        term.write(`\r\n\x1b[31m连接失败：${(e as Error).message}\x1b[0m`);
      });

    // —— 复制 / 粘贴辅助 ——
    const doCopy = (): boolean => {
      const sel = term.getSelection();
      if (sel) {
        void api.clipboardWrite(sel);
        return true;
      }
      return false;
    };
    const doPaste = () => {
      void api.clipboardRead().then((text) => {
        if (text) api.terminalWrite(connectionId, text.replace(/\r\n/g, '\n'), sessionKeyRef.current);
      });
    };

    // 拦截 Ctrl+C / Ctrl+V 等，实现选区感知复制 + 剪贴板粘贴
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Ctrl+C：有选区→复制并吞掉（不触发 SIGINT）；无选区→放行给 shell
      if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        if (term.getSelection()) {
          e.preventDefault();
          doCopy();
          return false;
        }
        return true;
      }
      // Ctrl+Shift+C：强制复制（无论是否有选区）
      if (e.ctrlKey && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        doCopy();
        return false;
      }
      // Ctrl+V：粘贴；Shift+Insert：粘贴
      if ((e.ctrlKey && (e.key === 'v' || e.key === 'V')) || (e.shiftKey && e.key === 'Insert')) {
        e.preventDefault();
        doPaste();
        return false;
      }
      return true;
    });

    // —— @ai 提问：把指令交给 AI（带 SSH 连接上下文，模型可在当前主机执行命令核实）——
    // 流式回答直接写回终端（订阅 AI_CHUNK 增量逐块输出，边生成边显示）。
    //
    // 关于「用户输入行」：回车被拦截后，shell 的 readline 缓冲里仍留着「@ai ...」整行，
    // 若之后补发 \r 会被远端当命令执行并报 `-bash: @ai: command not found`。
    // 故先发 Ctrl+U（\x15）清缓冲 —— 但这会连带抹掉屏幕上的输入，
    // 所以随后用灰色把用户输入原文重写一遍（保留「我输入了什么」的可见性），再输出 AI 回答。
    const clearShellLine = () => {
      api.terminalWrite(connectionId, '\x15', sessionKeyRef.current);
    };

    const runTerminalAi = async (instruction: string, typedLine: string) => {
      aiBusyRef.current = true;
      const st = useConnections.getState();
      const conn = st.connections.find((x) => x.id === connectionId);
      const cwd = st.cwdByConn[connectionId];
      const context: string[] = [];
      if (cwd) context.push(`当前 shell 工作目录：${cwd}`);

      // 清掉 shell 侧残留行（不执行），等远端回显到达
      clearShellLine();
      await new Promise((r) => setTimeout(r, 120));
      // 灰色重显用户输入原文（保留「我输入了什么」的可见性），再开始 AI 输出
      if (typedLine) termWrite(term, `\x1b[90m${typedLine}\x1b[0m\r\n`);
      termWrite(term, '\x1b[36m● AI\x1b[0m ');

      // 流式：逐块原样输出（先看到字，定稿见下方回写）
      let streamed = '';
      const offChunk = api.onAiChunk((d: string) => {
        if (!d) return;
        streamed += d;
        termWrite(term, d);
      });
      // 组件卸载 / 换连接时兜底退订，避免回调打到已销毁的终端
      aiChunkOffRef.current = offChunk;

      /** 擦掉已流式输出的内容，回到该回答的起始位置（用于定稿回写） */
      const rewindStream = () => {
        const lines = streamed.split('\n').length - 1;
        if (lines <= 0) return;
        termWrite(term, `\r\x1b[${lines}A\x1b[J`);
      };

      try {
        const answer = await api.aiAsk(
          [{ id: `term-${Date.now().toString(36)}`, role: 'user', content: instruction, ts: Date.now() }],
          context.length ? context : undefined,
          undefined,
          { id: connectionId, label: conn ? `${conn.host} (${conn.username})` : connectionId, kind: conn?.kind },
        );
        // 定稿：擦掉流式原文，整段做 Markdown→ANSI 转换后重打。
        // 注意必须无条件重写：流式阶段展示的是未转换的原始 markdown，
        // 若 answer === streamed 就跳过重写，裸表格/加粗/反引号会一直留在屏上。
        if (answer) {
          if (streamed) rewindStream();
          termWrite(term, mdToAnsi(answer));
        } else if (!streamed) {
          termWrite(term, '\x1b[90m（无输出）\x1b[0m');
        }
        termWrite(term, '\r\n');
      } catch (e) {
        offChunk();
        termWrite(term, `\r\n\x1b[31mAI 调用失败：${(e as Error).message}\x1b[0m\r\n`);
      } finally {
        offChunk();
        aiChunkOffRef.current = null;
        aiBusyRef.current = false;
      }
    };

    const onData = term.onData((d) => {
      // 回车：当前输入行含 @ai 提问记号 → 拦截交给 AI，不发给远端 shell（从终端缓冲读行，
      // 对历史召回 / Tab 补全 / 软换行都成立）
      if (d === '\r') {
        const line = readInputLine(term);
        const instruction = extractAiInstruction(line);
        if (instruction !== null) {
          const s = aiTypedStart(line);
          const typedLine = s >= 0 ? line.slice(s).trim() : '';
          if (aiBusyRef.current) {
            // 同样要清掉残留行，否则这行 @ai 文本会留在 shell 里等下次回车被执行
            clearShellLine();
            if (typedLine) termWrite(term, `\x1b[90m${typedLine}\x1b[0m\r\n`);
            termWrite(term, '\x1b[90m（AI 正在回答中，请稍候…）\x1b[0m\r\n');
          } else {
            void runTerminalAi(instruction, typedLine);
          }
          return;
        }
      }
      api.terminalWrite(connectionId, d, sessionKey);
    });
    // 外部「清屏」工具条按钮：监听自定义事件，仅清本连接终端
    const onClear = (e: Event) => {
      if ((e as CustomEvent<string>).detail === connectionId) term.clear();
    };
    window.addEventListener('dataroost:term-clear', onClear);

    /**
     * 尺寸自愈式适配：把 xterm 画布对齐到宿主容器实际大小。
     * 只在 cols/rows 真正变化时才通知远端 resize（避免无谓的 SIGWINCH）。
     * 容器尺寸为 0（隐藏中 / 尚未布局）时跳过，等待下一次触发。
     */
    const refit = () => {
      const el = containerRef.current;
      if (!el || !el.isConnected) return;
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      const prevCols = term.cols;
      const prevRows = term.rows;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols !== prevCols || term.rows !== prevRows) {
        api.terminalResize(connectionId, { cols: term.cols, rows: term.rows }, sessionKeyRef.current);
      }
    };

    // 观察宿主容器与其父级：任一尺寸变化（窗口缩放、面板拖动、底部快捷栏出现）都重新适配
    const ro = new ResizeObserver(() => refit());
    ro.observe(containerRef.current);
    if (containerRef.current.parentElement) ro.observe(containerRef.current.parentElement);
    const onWinResize = () => refit();
    window.addEventListener('resize', onWinResize);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refit();
    };
    document.addEventListener('visibilitychange', onVisible);
    // 首屏布局稳定后再适配一次（字体加载 / 工具栏与快捷栏就位都会改变可用高度）
    const raf1 = requestAnimationFrame(() => refit());
    const settleTimer = window.setTimeout(refit, 200);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf1);
      window.clearTimeout(settleTimer);
      window.removeEventListener('resize', onWinResize);
      document.removeEventListener('visibilitychange', onVisible);
      onData.dispose();
      offSel.dispose();
      aiBusyRef.current = false;
      aiChunkOffRef.current?.();
      aiChunkOffRef.current = null;
      window.removeEventListener('dataroost:term-clear', onClear);
      off?.();
      api.terminalExit(connectionId, sessionKey);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [connectionId]);

  // 设置修改即时生效：字号/配色/回滚行数/光标变化直接应用到现有终端实例并重新适配
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.theme = terminalTheme(themeName);
    term.options.scrollback = scrollback;
    term.options.cursorStyle = cursorStyle;
    term.options.cursorBlink = cursorBlink;
    // 字号变化会改变行数：必须把新 rows 通知远端，否则远端按旧行数折行、本地显示错位
    const prevCols = term.cols;
    const prevRows = term.rows;
    try {
      fitRef.current?.fit();
      if (connectionId && (term.cols !== prevCols || term.rows !== prevRows)) {
        api.terminalResize(connectionId, { cols: term.cols, rows: term.rows }, sessionKeyRef.current);
      }
    } catch { /* ignore */ }
  }, [fontSize, themeName, scrollback, cursorStyle, cursorBlink]);

  // 断线自动重连：连接由断开/错误恢复为已连接时，自动重开 shell（换新 sessionKey，复用既有订阅与终端实例）
  const prevStatusRef = useRef(connStatus);
  const deadRef = useRef(false);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = connStatus;
    if (!connectionId) return;
    if (connStatus === 'disconnected' || connStatus === 'error') {
      deadRef.current = true;
      return;
    }
    if (connStatus === 'connected' && deadRef.current && prev && prev !== connStatus) {
      const term = termRef.current;
      if (!term) return;
      if (!autoReconnect) return;
      deadRef.current = false;
      setReady(false);
      sessionKeyRef.current = `r${++paneSeq}`;
      api
        .terminalCreate(connectionId, { cols: term.cols, rows: term.rows }, sessionKeyRef.current)
        .then(() => setReady(true))
        .catch((e) => {
          setReady(true);
          deadRef.current = true;
          term.write(`\r\n\x1b[31m自动重连失败：${(e as Error).message}\x1b[0m`);
        });
    }
  }, [connStatus, autoReconnect, connectionId]);

  // 标签变为激活时重新适配（隐藏（display:none）期间容器尺寸为 0，需手动 fit；
  // 面板显示后布局还需一帧才稳定，故 rAF + 短延时各适配一次）
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    const doFit = () => {
      const prevCols = term.cols;
      const prevRows = term.rows;
      try {
        fitRef.current?.fit();
        if (connectionId && (term.cols !== prevCols || term.rows !== prevRows)) {
          api.terminalResize(connectionId, { cols: term.cols, rows: term.rows }, sessionKeyRef.current);
        }
      } catch { /* ignore */ }
    };
    const raf = requestAnimationFrame(doFit);
    const t = window.setTimeout(doFit, 120);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [active, connectionId]);

  if (!connectionId) {
    return <Empty text="请在左侧连接树选中并连上一台 SSH / 堡垒机主机，将在此打开真实终端。" />;
  }

  // 右键菜单动作
  const onCopy = () => { doCopyFromRef(); setMenu(null); };
  const onPaste = () => { doPasteFromRef(); setMenu(null); };
  const onSelectAll = () => { termRef.current?.selectAll(); setMenu(null); };
  const onClearSelection = () => { termRef.current?.clearSelection(); setMenu(null); };

  // 复用与键盘处理相同的逻辑（从 ref 取实例）
  const doCopyFromRef = () => {
    const sel = termRef.current?.getSelection();
    if (sel) void api.clipboardWrite(sel);
  };
  const doPasteFromRef = () => {
    void api.clipboardRead().then((text) => {
      if (text && connectionId) api.terminalWrite(connectionId, text.replace(/\r\n/g, '\n'), sessionKeyRef.current);
    });
  };

  return (
    <>
      <div className="relative h-full w-full">
        <div
          ref={containerRef}
          // 绝对定位铺满根容器：宿主尺寸只由外层决定，不会被 xterm 画布反向撑小，
          // 也不受 cols/rows 变化影响，从根上避免「终端只占上半部分、下半部分留黑」
          className="absolute inset-0 p-2"
          style={{ background: termBg }}
          onContextMenu={(e) => {
            e.preventDefault();
            // 偏好开启：右键直接粘贴（终端常用习惯）；否则弹复制/粘贴菜单
            if (rightClickPaste) {
              doPasteFromRef();
            } else {
              setMenu({ x: e.clientX, y: e.clientY });
            }
          }}
        />
        {/* 连接加载遮罩：远端 shell 就绪前盖住终端 */}
        {!ready && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3" style={{ background: termBg }}>
            <svg className="h-7 w-7 animate-spin text-accent" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            <span className="text-[12px] text-dim">正在连接主机并初始化 shell…</span>
          </div>
        )}
      </div>
      {menu && (
        <>
          {/* 点击遮罩关闭菜单 */}
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[136px] overflow-hidden rounded-md border border-line bg-panel2 py-1 text-sm text-fg shadow-lg"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="block w-full px-3 py-1.5 text-left hover:bg-sel disabled:cursor-not-allowed disabled:opacity-40"
              onClick={onCopy}
            >
              复制
            </button>
            <button className="block w-full px-3 py-1.5 text-left hover:bg-sel" onClick={onPaste}>
              粘贴
            </button>
            <div className="my-1 h-px bg-line2" />
            <button className="block w-full px-3 py-1.5 text-left hover:bg-sel" onClick={onSelectAll}>
              全选
            </button>
            <button className="block w-full px-3 py-1.5 text-left hover:bg-sel" onClick={onClearSelection}>
              清除选中
            </button>
          </div>
        </>
      )}
    </>
  );
}
