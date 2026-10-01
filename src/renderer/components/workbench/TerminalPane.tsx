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
 */

/** 从远端数据流中解析 OSC 7 序列（file://host/path），返回 path；无则返回 null */
function parseOsc7(data: string): string | null {
  const re = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b\\]*)/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(data)) !== null) last = m[1];
  return last;
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
    const off = api.onTerminalData((cid, key, data) => {
      if (cid === connectionId && key === sessionKeyRef.current) {
        const cwd = parseOsc7(data);
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

    const onData = term.onData((d) => api.terminalWrite(connectionId, d, sessionKey));
    // 外部「清屏」工具条按钮：监听自定义事件，仅清本连接终端
    const onClear = (e: Event) => {
      if ((e as CustomEvent<string>).detail === connectionId) term.clear();
    };
    window.addEventListener('dataroost:term-clear', onClear);
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        api.terminalResize(connectionId, { cols: term.cols, rows: term.rows }, sessionKey);
      } catch { /* ignore */ }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      onData.dispose();
      offSel.dispose();
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
    try { fitRef.current?.fit(); } catch { /* ignore */ }
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

  // 标签变为激活时重新适配（隐藏（display:none）期间容器尺寸为 0，需手动 fit）
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        api.terminalResize(connectionId!, { cols: term.cols, rows: term.rows }, sessionKeyRef.current);
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
      if (text && connectionId) api.terminalWrite(connectionId, text.replace(/\r\n/g, '\n'), sessionKeyRef.current);
    });
  };

  return (
    <>
      <div className="relative h-full w-full">
        <div
          ref={containerRef}
          className="h-full w-full p-2"
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
