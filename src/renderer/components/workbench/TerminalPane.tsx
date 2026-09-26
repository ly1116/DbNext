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
 * 远端 shell 静默初始化片段（多行，整体注入一次）：
 * 1. 每次提示符前输出 OSC 7（当前工作目录），供 SFTP 面板跟随终端 cd；
 * 2. 设置彩色提示符（绿色加粗 user@host + 蓝色加粗路径），兼容 bash / zsh；
 * 3. 兜底开启 ls / grep 着色（部分发行版非登录 shell 不带颜色别名）。
 *
 * 为避免这些命令在连接时被远端原样「回显」到终端（主流终端如 Termius / VS Code
 * 都不会显示这段），注入时先 `stty -echo` 关闭回显、注入完成后再 `stty echo` 打开，
 * 渲染端只剥离首行回显，实现连接瞬间零可见的初始化。极少数无 stty 的环境会回退为可见（无害）。
 */
const SHELL_INIT = [
  'export PROMPT_COMMAND=\'printf "\\033]7;file://%s%s\\007" "$HOSTNAME" "$PWD"\'',
  'if [ -n "$ZSH_VERSION" ]; then',
  '  precmd(){ printf "\\033]7;file://%m%s\\007" "$PWD"; }',
  "  PS1='%F{green}%n@%m%f:%F{blue}%~%f$ '",
  'else',
  '  export PS1=\'\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ \'',
  'fi',
  "alias ls='ls --color=auto' 2>/dev/null",
  "alias grep='grep --color=auto' 2>/dev/null",
  'printf "\\033]7;file://%s%s\\007" "$HOSTNAME" "$PWD"',
].join('\n');

/** 注入第一阶段：先单独关闭回显（等 shell 执行完再发主体，避免整段被 tty 原样回显） */
const INIT_ECHO_OFF = 'stty -echo\n';
/** 注入第二阶段：初始化主体 + 恢复回显 + 输出就绪令牌（令牌前的一切输出在本地吞掉） */
const INIT_BODY = `${SHELL_INIT}\nstty echo\necho "__DBNEST""_RDY__"\n`;
/** 就绪令牌（实际输出形态；回显中因带引号拼接不会提前匹配） */
const READY_TOKEN = '__DBNEST_RDY__';

/** 从远端数据流中解析 OSC 7 序列（file://host/path），返回 path；无则返回 null */
function parseOsc7(data: string): string | null {
  const re = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b\\]*)/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(data)) !== null) last = m[1];
  return last;
}

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
  const [menu, setMenu] = useState<CtxMenu | null>(null);
  // 终端背景色跟随所选配色方案，避免容器与 xterm 画布出现色差
  const termBg = useMemo(() => terminalTheme(themeName).background ?? '#1e1e1e', [themeName]);

  useEffect(() => {
    if (!connectionId || !containerRef.current) return;
    const { fontSize: fs, theme } = usePrefs.getState().prefs;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: fs,
      theme: terminalTheme(theme),
      cursorBlink: true,
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
    let off: (() => void) | null = null;
    let cleanupExtra: (() => void) | null = null;

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
        if (text) api.terminalWrite(connectionId, text.replace(/\r\n/g, '\n'));
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

    api
      .terminalCreate(connectionId, { cols, rows })
      .then(() => {
        // 静默注入（对齐 Termius / VS Code）：分两段写入——
        // 1) 先写 `stty -echo`，等 shell 执行后再写主体，否则整段命令会被 tty 原样回显；
        // 2) 渲染端在就绪令牌出现前吞掉一切输出（提示符/回显/ continuation 全部不可见），
        //    令牌出现后恢复正常显示；5 秒兜底防止异常 shell 永久黑屏。
        let suppressing = true;
        let buf = '';
        const feed = (data: string) => {
          if (!suppressing) {
            term.write(data);
            return;
          }
          buf += data;
          const idx = buf.indexOf(READY_TOKEN);
          if (idx >= 0) {
            suppressing = false;
            const rest = buf.slice(idx + READY_TOKEN.length).replace(/^\r?\n/, '');
            buf = '';
            if (rest) term.write(rest);
          }
        };
        const finishSuppression = () => {
          if (suppressing) {
            suppressing = false;
            if (buf) term.write(buf);
            buf = '';
          }
        };
        // 兜底：5 秒内未等到令牌（非 bash/zsh 等）则放弃抑制，恢复正常显示
        const suppressTimer = window.setTimeout(finishSuppression, 5000);

        api.terminalWrite(connectionId, INIT_ECHO_OFF);
        const bodyTimer = window.setTimeout(() => {
          try {
            api.terminalWrite(connectionId, INIT_BODY);
          } catch {
            /* 会话已结束：忽略 */
          }
        }, 300);
        off = api.onTerminalData((cid, data) => {
          if (cid === connectionId) {
            const cwd = parseOsc7(data);
            if (cwd) useConnections.getState().setCwd(connectionId, cwd);
            feed(data);
          }
        });
        cleanupExtra = () => {
          window.clearTimeout(suppressTimer);
          window.clearTimeout(bodyTimer);
        };
      })
      .catch((e) => term.write(`\r\n\x1b[31m连接失败：${(e as Error).message}\x1b[0m`));

    const onData = term.onData((d) => api.terminalWrite(connectionId, d));
    // 外部「清屏」工具条按钮：监听自定义事件，仅清本连接终端
    const onClear = (e: Event) => {
      if ((e as CustomEvent<string>).detail === connectionId) term.clear();
    };
    window.addEventListener('dbnest:term-clear', onClear);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        api.terminalResize(connectionId, { cols: term.cols, rows: term.rows });
      } catch { /* ignore */ }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      onData.dispose();
      window.removeEventListener('dbnest:term-clear', onClear);
      off?.();
      cleanupExtra?.();
      api.terminalExit(connectionId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [connectionId]);

  // 设置修改即时生效：字号/配色变化直接应用到现有终端实例并重新适配
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.theme = terminalTheme(themeName);
    try { fitRef.current?.fit(); } catch { /* ignore */ }
  }, [fontSize, themeName]);

  // 标签变为激活时重新适配（隐藏（display:none）期间容器尺寸为 0，需手动 fit）
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        api.terminalResize(connectionId!, { cols: term.cols, rows: term.rows });
      } catch { /* ignore */ }
    });
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
      if (text && connectionId) api.terminalWrite(connectionId, text.replace(/\r\n/g, '\n'));
    });
  };

  return (
    <>
      <div
        ref={containerRef}
        className="h-full w-full p-2"
        style={{ background: termBg }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu && (
        <>
          {/* 点击遮罩关闭菜单 */}
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[136px] overflow-hidden rounded-md border border-[#3a3a3a] bg-[#252526] py-1 text-sm text-[#e6e6e6] shadow-lg"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button
              className="block w-full px-3 py-1.5 text-left hover:bg-[#094771] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={onCopy}
            >
              复制
            </button>
            <button className="block w-full px-3 py-1.5 text-left hover:bg-[#094771]" onClick={onPaste}>
              粘贴
            </button>
            <div className="my-1 h-px bg-[#3a3a3a]" />
            <button className="block w-full px-3 py-1.5 text-left hover:bg-[#094771]" onClick={onSelectAll}>
              全选
            </button>
            <button className="block w-full px-3 py-1.5 text-left hover:bg-[#094771]" onClick={onClearSelection}>
              清除选中
            </button>
          </div>
        </>
      )}
    </>
  );
}
