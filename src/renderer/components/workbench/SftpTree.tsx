import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@renderer/api';
import { useAppStore } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import type { FileNode } from '@shared/types';
import { Empty, ErrorBox } from '@renderer/components/common/States';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { chmodDialog, promptDialog } from '@renderer/components/common/PromptDialog';
import { TransferMini } from '@renderer/components/common/TransferMini';
import { canEdit, MAX_EDIT_BYTES } from '@renderer/theme/file-types';
import { fileIconKind, iconColorClass } from '@renderer/theme/file-icons';

/**
 * SFTP 文件面板（真实实现 · 树形资源管理器）。
 *
 * 通过已建立的 SSH 连接的 `api.listDir / mkdir / remove / rename` 真实操作远端文件系统。
 * 目录为 VS Code 风格树形：文件夹点击内联展开/折叠（懒加载子级），地址栏可直接输入回车跳转，
 * 树会跟随跳转自动展开对应层级链路。底部传输队列迷你面板订阅 `api.onTransferProgress` 实时显示进度。
 *
 * @since 0.1.0
 */

/** 目录排序：文件夹在前，同类型按名称 */
function sortNodes(list: FileNode[]): FileNode[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 规范化远端绝对路径：以 / 开头、去除末尾 /（根除外） */
function normalizePath(p: string): string {
  let s = (p || '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s || '/';
}

/** 由路径取层级链：/etc/nginx -> ['/', '/etc', '/etc/nginx'] */
function chainOf(p: string): string[] {
  const segs = normalizePath(p).split('/').filter(Boolean);
  const chain = ['/'];
  let cur = '';
  for (const seg of segs) {
    cur += '/' + seg;
    chain.push(cur);
  }
  return chain;
}

/** 由路径取父目录（根返回根） */
function parentOf(p: string): string {
  const n = normalizePath(p);
  if (n === '/') return '/';
  const idx = n.lastIndexOf('/');
  return idx <= 0 ? '/' : n.slice(0, idx);
}

/** 本地路径取文件名（兼容 / 与 \ 分隔） */
function localBasename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

/** shell 单引号安全转义 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function SftpTree({ connectionId, hostLabel }: { connectionId: string | null; hostLabel?: string }) {
  /** 已加载的目录子级缓存：dirPath -> children */
  const [children, setChildren] = useState<Record<string, FileNode[]>>({});
  /** 已展开的目录集合（根默认展开） */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']));
  /** 地址栏路径（树跟随它展开链路） */
  const [pwd, setPwd] = useState('/');
  const [pathDraft, setPathDraft] = useState('/');
  const [filter, setFilter] = useState('');
  const [loadingDir, setLoadingDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FileNode | null>(null);
  /** 右键菜单目标：某个节点；空白处为当前目录的伪节点 */
  const [menu, setMenu] = useState<{ node: FileNode; x: number; y: number } | null>(null);
  /** 菜单关闭后的提示消息（操作结果） */
  const [toast, setToast] = useState<string | null>(null);
  /** 拖拽悬停的目标目录（高亮提示可放置） */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const loadDir = useCallback(
    async (dir: string) => {
      if (!connectionId) return;
      setLoadingDir(dir);
      try {
        const list = await api.listDir(connectionId, dir);
        setChildren((prev) => ({ ...prev, [dir]: list.filter((n) => n.name !== '.' && n.name !== '..') }));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoadingDir(null);
      }
    },
    [connectionId],
  );

  /** 连接切换：重置树，从根开始 */
  useEffect(() => {
    setChildren({});
    setExpanded(new Set(['/']));
    setPwd('/');
    setPathDraft('/');
    setSelected(null);
    setError(null);
    if (connectionId) void loadDir('/');
  }, [connectionId, loadDir]);

  /** 树跟随地址栏：展开整条层级链并确保每级已加载 */
  const revealPath = useCallback(
    (target: string) => {
      const p = normalizePath(target);
      const chain = chainOf(p);
      setExpanded((prev) => {
        const next = new Set(prev);
        chain.forEach((c) => next.add(c));
        return next;
      });
      chain.forEach((c) => {
        if (!children[c]) void loadDir(c);
      });
      setPwd(p);
      setPathDraft(p);
    },
    [children, loadDir],
  );

  /** 跟随终端：终端 cd 后当前目录变化即自动展开链路并跳转（仅 cwd 实际变化时触发，手动浏览不被拉回） */
  const cwd = useConnections((s) => (connectionId ? s.cwdByConn[connectionId] : undefined));
  const following = useAppStore((s) => s.status.sftpFollowing);
  const setStatus = useAppStore((s) => s.setStatus);
  const prevCwdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevCwdRef.current;
    prevCwdRef.current = cwd;
    if (!following || !cwd || cwd === prev || cwd === pwd) return;
    revealPath(cwd);
  }, [cwd, following, pwd, revealPath]);

  const toggleDir = (n: FileNode) => {
    if (expanded.has(n.path)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(n.path);
        return next;
      });
    } else {
      setExpanded((prev) => new Set(prev).add(n.path));
      if (!children[n.path]) void loadDir(n.path);
    }
    setPwd(n.path);
    setPathDraft(n.path);
  };

  const refresh = () => {
    setError(null);
    setChildren({});
    // 重新加载根 + 所有已展开目录
    const dirs = new Set(['/']);
    expanded.forEach((d) => dirs.add(d));
    dirs.forEach((d) => void loadDir(d));
  };

  // 内置编辑器保存成功后刷新（文件大小/修改时间已变）
  useEffect(() => {
    const onRefresh = (e: Event) => {
      if ((e as CustomEvent<string>).detail === connectionId) refresh();
    };
    window.addEventListener('dataroost:sftp-refresh', onRefresh);
    return () => window.removeEventListener('dataroost:sftp-refresh', onRefresh);
  }, [connectionId, expanded, children]);

  const newFolder = () => void newFolderIn(pwd);
  const doDelete = async (n: FileNode) => {
    if (!connectionId) return;
    const rec = n.type === 'dir';
    if (!window.confirm(`确认删除 ${rec ? '目录（递归）' : '文件'} ${n.path}？`)) return;
    await api.remove(connectionId, n.path, true).catch((e) => setError((e as Error).message));
    refresh();
  };
  const doRename = async (n: FileNode) => {
    const name = await promptDialog({ title: `重命名：${n.name}`, value: n.name, okText: '重命名' });
    if (!name || !connectionId) return;
    const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
    await api.rename(connectionId, n.path, `${parent}/${name}`).catch((e) => setError((e as Error).message));
    refresh();
  };

  /** 修改权限（chmod）：九宫格勾选（所有者/属组/其他 × 读/写/执行），确认后下发八进制值并刷新 */
  const doChmod = async (n: FileNode) => {
    if (!connectionId) return;
    const cur = n.mode && n.mode !== '0000' ? n.mode.slice(-3) : '644';
    const mode = await chmodDialog({ title: `修改权限：${n.name}（当前 ${cur}）`, mode: cur, okText: '应用' });
    if (!mode) return;
    await api.chmod(connectionId, n.path, mode)
      .then(() => setToast(`已修改权限：${n.path} → ${mode}`))
      .catch((e) => setError((e as Error).message));
    refresh();
  };

  /** 上传本地文件到指定目录 */
  const uploadFileTo = async (dir: string) => {
    if (!connectionId) return;
    const local = await api.openDialog({ kind: 'file', title: '选择要上传的文件' });
    if (!local) return;
    await api.upload(connectionId, local, `${dir === '/' ? '' : dir}/${localBasename(local)}`).catch((e) => setError((e as Error).message));
    revealPath(dir);
    void loadDir(dir);
  };
  /** 递归上传本地目录 */
  const uploadDirTo = async (dir: string) => {
    if (!connectionId) return;
    const local = await api.openDialog({ kind: 'folder', title: '选择要上传的文件夹' });
    if (!local) return;
    await api.uploadDir(connectionId, local, `${dir === '/' ? '' : dir}/${localBasename(local)}`).catch((e) => setError((e as Error).message));
    revealPath(dir);
    void loadDir(dir);
  };
  /** 新建远端空文件夹 */
  const newFolderIn = async (dir: string) => {
    if (!connectionId) return;
    const name = await promptDialog({ title: '新建文件夹', value: 'new-folder' });
    if (!name) return;
    await api.mkdir(connectionId, `${dir === '/' ? '' : dir}/${name}`).catch((e) => setError((e as Error).message));
    void loadDir(dir);
  };

  // —— 拖拽（本机文件拖入上传 / 树内远端拖动移动）——

  /** 拖入的多个本机文件/目录依次上传到目标远端目录（localList 成功 ⇒ 目录，走递归上传） */
  const uploadDropped = async (files: File[], targetDir: string) => {
    if (!connectionId || !files.length) return;
    setToast(`开始上传 ${files.length} 项到 ${targetDir} …`);
    for (const f of files) {
      const local = api.pathForFile(f);
      if (!local) continue;
      const isDir = await api.localList(local).then(() => true).catch(() => false);
      const remotePath = `${targetDir === '/' ? '' : targetDir}/${localBasename(local)}`;
      const task = isDir ? api.uploadDir(connectionId, local, remotePath) : api.upload(connectionId, local, remotePath);
      await task.catch((e) => setError(`上传失败：${(e as Error).message}`));
    }
    revealPath(targetDir);
    void loadDir(targetDir);
  };

  /** 树内拖动：把远端节点移动到目标目录（rename 语义），并刷新两侧 */
  const moveRemoteTo = async (src: string, targetDir: string) => {
    if (!connectionId) return;
    const name = src.split('/').filter(Boolean).pop() ?? src;
    if (targetDir === src || (targetDir + '/').startsWith(src + '/')) {
      setError('不能把目录移动到它自己（或其子目录）里');
      return;
    }
    const dest = `${targetDir === '/' ? '' : targetDir}/${name}`;
    if (dest === src) return;
    await api.rename(connectionId, src, dest)
      .then(() => setToast(`已移动：${src} → ${dest}`))
      .catch((e) => setError((e as Error).message));
    refresh();
  };

  /** 统一 drop 入口：优先树内远端移动，否则按本机文件上传 */
  const handleDrop = async (e: React.DragEvent, targetDir: string) => {
    if (!connectionId) return;
    const remote = e.dataTransfer.getData('application/x-dataroost-remote');
    if (remote) {
      await moveRemoteTo(remote, targetDir);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length) await uploadDropped(files, targetDir);
  };

  /** 从事件目标向上找行的放置目录：目录行=自身，文件行=其父目录，空白=当前目录 */
  const dropDirOf = (e: React.DragEvent): string => {
    const el = (e.target as HTMLElement).closest?.('[data-drop-dir]') as HTMLElement | null;
    return el?.dataset.dropDir ?? pwd;
  };
  /** 新建远端空文件（touch） */
  const newFileIn = async (dir: string) => {
    if (!connectionId) return;
    const name = await promptDialog({ title: '新建文件', value: 'new-file.txt' });
    if (!name) return;
    await api.touch(connectionId, `${dir === '/' ? '' : dir}/${name}`).catch((e) => setError((e as Error).message));
    void loadDir(dir);
  };
  /** 下载：文件→另存为；目录→递归下载到所选文件夹 */
  const downloadNode = async (n: FileNode) => {
    if (!connectionId) return;
    if (n.type === 'file') {
      const local = await api.openDialog({ kind: 'save', title: '保存到…', defaultPath: n.name });
      if (!local) return;
      await api.download(connectionId, n.path, local).catch((e) => setError((e as Error).message));
    } else {
      const local = await api.openDialog({ kind: 'folder', title: '选择下载到哪个文件夹' });
      if (!local) return;
      await api.downloadDir(connectionId, n.path, `${local}\\${n.name}`).catch((e) => setError((e as Error).message));
    }
    setToast('下载任务已加入传输队列');
  };
  /** 复制远端绝对路径 */
  const copyPath = (n: FileNode) => {
    void navigator.clipboard.writeText(n.path);
    setToast(`已复制：${n.path}`);
  };
  /** 切到工作台终端并 cd 到目标目录 */
  const openTerminalAt = (dir: string) => {
    if (!connectionId) return;
    useAppStore.getState().setScreen('shell');
    // 等工作台终端建立后注入 cd 命令（终端创建为异步，稍作延迟）
    window.setTimeout(() => api.terminalWrite(connectionId, `cd ${shQuote(dir)} && clear\n`), 600);
  };

  /** 在新标签页用内置编辑器打开远端文件（仅可编辑的文本文件；二进制/超限文件给出提示） */
  const openInEditor = (n: FileNode) => {
    if (!connectionId || n.type !== 'file') return;
    if (!canEdit(n.path, n.type, n.size)) {
      setToast(`${n.name} 不可编辑（二进制或超过 ${MAX_EDIT_BYTES / 1024 / 1024} MB 上限）`);
      return;
    }
    useAppStore.getState().setScreen('shell');
    useAppStore.getState().openEditor({ connId: connectionId, path: n.path, title: n.name });
  };

  /** 按参考客户端结构生成右键菜单（目标为节点；空白处为当前目录伪节点） */
  const menuItemsFor = (n: FileNode): MenuItem[] => {
    const isPseudo = n.name === '';
    const dir = n.type === 'dir' ? n.path : parentOf(n.path);
    return [
      { label: '刷新', onClick: refresh },
      {
        label: '上传',
        children: [
          { label: '上传文件…', onClick: () => void uploadFileTo(dir) },
          { label: '上传文件夹…', onClick: () => void uploadDirTo(dir) },
        ],
      },
      {
        label: '新建',
        children: [
          { label: '新建文件夹', onClick: () => void newFolderIn(dir) },
          { label: '新建文件', onClick: () => void newFileIn(dir) },
        ],
      },
      // 文件 / 非伪节点才可下载（当前目录伪节点不提供整目录下载，避免误下整盘）
      { label: '下载', onClick: () => void downloadNode(n), disabled: isPseudo },
      // 可编辑文本文件 → 在新标签打开内置编辑器（VSCode 式）
      {
        label: '在编辑器打开',
        onClick: () => openInEditor(n),
        disabled: isPseudo || n.type !== 'file' || !canEdit(n.path, n.type, n.size),
      },
      { label: '复制路径', onClick: () => copyPath(n) },
      {
        label: '终端',
        children: [{ label: '在此处打开终端', onClick: () => openTerminalAt(dir) }],
      },
      {
        label: '其他',
        children: [
          { label: '重命名…', onClick: () => void doRename(n), disabled: isPseudo },
          { label: '设置权限…', onClick: () => void doChmod(n), disabled: isPseudo },
          { label: '复制名称', onClick: () => { void navigator.clipboard.writeText(n.name); setToast(`已复制：${n.name}`); }, disabled: isPseudo },
        ],
      },
      { separator: true, label: '' },
      { label: '删除', danger: true, onClick: () => void doDelete(n), disabled: isPseudo },
    ];
  };

  /** 空白处右键 = 对当前目录操作 */
  const onBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ node: { path: pwd, name: '', type: 'dir', size: 0, mode: '0000', modifiedAt: new Date().toISOString() }, x: e.clientX, y: e.clientY });
  };

  if (!connectionId) {
    return (
      <div className="flex h-full w-full shrink-0 flex-col border-l border-line bg-panel">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="text-[12px] font-medium">SFTP</span>
        </div>
        <Empty text="主机尚未连接。连接成功后即可浏览其文件系统。" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full shrink-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <svg className="h-3.5 w-3.5 text-ok" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span className="text-[12px] font-medium">SFTP</span>
        <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        <span className="text-[10px] text-dim2">{hostLabel ?? connectionId}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn
            title={following ? '跟随终端：已开启（终端 cd 后自动跳转，点击关闭）' : '跟随终端：已关闭（点击开启）'}
            onClick={() => setStatus({ sftpFollowing: !following })}
          >
            <svg
              className={`h-3.5 w-3.5 ${following ? 'text-accent' : 'text-dim2'}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              viewBox="0 0 24 24"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconBtn>
          <IconBtn title="SFTP 全屏" onClick={() => useAppStore.getState().openOverlay({ kind: 'sftpfull', connectionId })}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
            </svg>
          </IconBtn>
          <IconBtn title="刷新" onClick={refresh}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <path d="M21 12a9 9 0 1 1-2.6-6.4" />
              <path d="M21 3v6h-6" />
            </svg>
          </IconBtn>
          <IconBtn title="新建文件夹" onClick={newFolder}>
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </IconBtn>
        </div>
      </div>

      {/* 地址栏 + 过滤：合成一条（面包屑显示当前路径，可直接输入跳转；下方一行内嵌过滤框） */}
      <div className="shrink-0 border-b border-line px-2 py-1.5">
        <div className="flex h-7 items-center gap-1.5 rounded border border-line bg-bg px-2 transition-colors focus-within:border-accent/60">
          <svg className="h-3 w-3 shrink-0 text-dim2" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <input
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') revealPath(pathDraft);
              if (e.key === 'Escape') setPathDraft(pwd);
            }}
            onBlur={() => setPathDraft(pwd)}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg outline-none placeholder:text-dim2"
            placeholder="输入远端路径后回车"
            title="输入路径回车跳转（如 /etc/nginx）"
          />
          {/* 过滤：路径栏右侧内嵌的小放大镜 + 输入 */}
          <div className="flex h-5 w-[92px] shrink-0 items-center gap-1 rounded bg-panel2 px-1.5 transition-all focus-within:w-[130px]">
            <svg className="h-2.5 w-2.5 shrink-0 text-dim2" fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="过滤"
              className="w-full min-w-0 bg-transparent text-[11px] text-fg outline-none placeholder:text-dim2"
              title="按名称过滤当前目录"
            />
          </div>
        </div>
      </div>

      {error && <ErrorBox message={error} onRetry={refresh} />}
      {toast && (
        <div
          className="shrink-0 cursor-pointer border-b border-line bg-accent/10 px-3 py-1 text-[11px] text-accent2"
          onClick={() => setToast(null)}
          title="点击关闭"
        >
          {toast}
        </div>
      )}

      <div
        ref={treeContainerRef}
        className={`flex-1 select-none overflow-y-auto px-1 py-1 ${dropTarget ? 'ring-1 ring-inset ring-accent/50' : ''}`}
        onContextMenu={onBlankContextMenu}
        onDragOver={(e) => {
          e.preventDefault();
          setDropTarget(dropDirOf(e));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const dir = dropDirOf(e);
          setDropTarget(null);
          void handleDrop(e, dir);
        }}
      >
        <TreeRows
          dir="/"
          depth={0}
          childrenMap={children}
          expanded={expanded}
          filter={filter}
          loadingDir={loadingDir}
          selectedPath={selected?.path ?? null}
          dropTarget={dropTarget}
          onToggle={toggleDir}
          onSelect={setSelected}
          onContext={(n, x, y) => setMenu({ node: n, x, y })}
          onOpenInEditor={openInEditor}
        />
      </div>

      {/* 右键菜单：刷新 / 上传 / 新建 / 下载 / 复制路径 / 终端 / 其他 / 删除 */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItemsFor(menu.node)} onClose={() => setMenu(null)} />}

      {selected && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-line bg-panel2 px-2 py-1.5 text-[11px]">
          <FileIcon node={selected} />
          <span className="min-w-0 flex-1 truncate text-fg" title={selected.path}>
            {selected.name}
          </span>
          <button
            className="shrink-0 rounded border border-line2 px-1.5 py-0.5 text-dim transition-colors hover:bg-panel3 hover:text-fg"
            onClick={() => void doRename(selected)}
            title="重命名"
          >
            重命名
          </button>
          <button
            className="shrink-0 rounded border border-prod/40 px-1.5 py-0.5 text-prod transition-colors hover:bg-prod/10"
            onClick={() => void doDelete(selected)}
            title="删除"
          >
            删除
          </button>
        </div>
      )}

      <TransferMini />
    </div>
  );
}

/** 树容器 DOM（roving tabindex 的方向键焦点转移需要查询行元素；树递归渲染，不逐层透传 ref） */
const treeContainerRef: { current: HTMLDivElement | null } = { current: null };

/** 递归树行：按层级缩进，文件夹内联展开子级（懒加载）；支持拖拽（本机拖入上传 / 树内拖动移动） */
function TreeRows({
  dir,
  depth,
  childrenMap,
  expanded,
  filter,
  loadingDir,
  selectedPath,
  dropTarget,
  onToggle,
  onSelect,
  onContext,
  onOpenInEditor,
}: {
  dir: string;
  depth: number;
  childrenMap: Record<string, FileNode[]>;
  expanded: Set<string>;
  filter: string;
  loadingDir: string | null;
  selectedPath: string | null;
  dropTarget: string | null;
  onToggle: (n: FileNode) => void;
  onSelect: (n: FileNode) => void;
  onContext: (n: FileNode, x: number, y: number) => void;
  /** 双击文件：在新标签页用内置编辑器打开 */
  onOpenInEditor: (n: FileNode) => void;
}) {
  const list = childrenMap[dir];
  if (!list) {
    return (
      <div className="px-2 py-1 text-[11px] text-dim2" style={{ paddingLeft: 10 + depth * 14 }}>
        {loadingDir === dir ? '读取中…' : '…'}
      </div>
    );
  }
  const f = filter.trim().toLowerCase();
  const visible = f ? list.filter((n) => n.name.toLowerCase().includes(f)) : sortNodes(list);

  /**
   * roving tabindex 的焦点转移：把目标行设为组内唯一 tabIndex=0 的元素并聚焦。
   * 通过 DOM 查询实现（树是递归渲染的，父级拿不到子级 ref）。
   */
  const focusRow = (list: FileNode[], idx: number) => {
    const target = list[Math.max(0, Math.min(list.length - 1, idx))];
    if (!target) return;
    const el = treeContainerRef.current?.querySelector<HTMLButtonElement>(`[data-sftp-path="${CSS.escape(target.path)}"]`);
    if (el) {
      el.tabIndex = 0;
      el.focus();
    }
  };

  return (
    <>
      {visible.map((n) => {
        const isDir = n.type === 'dir';
        const isOpen = isDir && expanded.has(n.path);
        // 目录行=放到自身；文件行=放到其父目录
        const dropDir = isDir ? n.path : parentOf(n.path);
        const isDropTarget = dropTarget === dropDir;
        // 点开头的隐藏文件（.bashrc / .ssh 等）淡化显示，让常规文件更突出
        const isHidden = !isDir && n.name.startsWith('.');
        return (
          <div key={n.path}>
            <button
              draggable
              // roving tabindex：整棵树只占一个 Tab 停靠点（当前选中行；未选中则第一行），
              // 组内用 ↑↓←→ 浏览，避免 Tab 逐行遍历几十个节点。
              tabIndex={selectedPath === n.path || (!selectedPath && depth === 0 && n === visible[0]) ? 0 : -1}
              onKeyDown={(e) => {
                if (!visible.length) return;
                const i = visible.indexOf(n);
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  (visible[i + 1] ?? visible[i]) && focusRow(visible, i + 1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (i > 0) focusRow(visible, i - 1);
                } else if (e.key === 'ArrowRight' && isDir) {
                  e.preventDefault();
                  onToggle(n);
                } else if (e.key === 'ArrowLeft' && isDir && isOpen) {
                  e.preventDefault();
                  onToggle(n);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  if (isDir) onToggle(n);
                  else onOpenInEditor(n);
                }
              }}
              onDragStart={(e) => {
                // 树内拖动：记录远端源路径（本机文件拖入走 dataTransfer.files，两者互不干扰）
                e.dataTransfer.setData('application/x-dataroost-remote', n.path);
                e.dataTransfer.effectAllowed = 'move';
              }}
              data-drop-dir={dropDir}
              data-sftp-path={n.path}
              onClick={() => (isDir ? onToggle(n) : onSelect(n))}
              // 双击文件 = 在编辑器打开（VSCode 习惯）；双击目录 = 展开/折叠
              onDoubleClick={() => {
                if (isDir) onToggle(n);
                else onOpenInEditor(n);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(n);
                onContext(n, e.clientX, e.clientY);
              }}
              title={isDir ? '点击展开/折叠 · 拖到其他目录可移动 · 右键操作菜单' : `${n.path}（双击在编辑器打开 · 可拖到其他目录移动 · 右键操作菜单）`}
              className={`group tree-row flex w-full items-center gap-1.5 py-[3px] pr-2 text-left ${selectedPath === n.path ? 'active' : ''} ${isDropTarget ? 'bg-accent/20 ring-1 ring-inset ring-accent/60' : ''}`}
              style={{ paddingLeft: 6 + depth * 13 }}
            >
              {/* 展开箭头（目录才有，占位保持对齐）；hover 时才显形，减少视觉噪音 */}
              {isDir ? (
                <svg
                  className={`h-3 w-3 shrink-0 text-dim2 transition-transform ${isOpen ? 'rotate-90 text-dim' : ''} group-hover:text-dim`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  viewBox="0 0 24 24"
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <FileIcon node={n} open={isOpen} />
              {/* 文件名：默认 UI 字体（等宽字体渲染文件名反而不易读），超长中间省略 */}
              <span
                className={`min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.857)] ${isDir ? 'font-medium' : ''} ${isHidden ? 'text-dim2' : ''}`}
              >
                {n.name}
              </span>
              {/* 尺寸：默认隐藏，hover 或选中时才显示（去视觉噪音） */}
              {!isDir && (
                <span className="shrink-0 tabular-nums text-[10px] text-dim2 opacity-0 transition-opacity group-hover:opacity-100">
                  {formatSize(n.size)}
                </span>
              )}
            </button>
            {/* 子级：内联展开（懒加载） */}
            {isDir && isOpen && (
              <TreeRows
                dir={n.path}
                depth={depth + 1}
                childrenMap={childrenMap}
                expanded={expanded}
                filter={filter}
                loadingDir={loadingDir}
                selectedPath={selectedPath}
                dropTarget={dropTarget}
                onToggle={onToggle}
                onSelect={onSelect}
                onContext={onContext}
                onOpenInEditor={onOpenInEditor}
              />
            )}
          </div>
        );
      })}
      {visible.length === 0 && f ? null : visible.length === 0 && <div className="px-3 py-1 text-[11px] text-dim2" style={{ paddingLeft: 10 + depth * 14 }}>空目录</div>}
    </>
  );
}

/** 传输队列迷你面板已抽为公共组件 `@renderer/components/common/TransferMini`（上传/下载共用） */

function formatSize(n: number): string {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
/**
 * 文件图标（按类型区分形态与配色，见 theme/file-icons.ts）。
 * 之前所有文件共用一个绿色文档图标，扫一眼完全分不出类型。
 */
function FileIcon({ node, open }: { node: FileNode; open?: boolean }) {
  const kind = fileIconKind(node.name, node.type === 'dir', open);
  const cls = `h-3.5 w-3.5 shrink-0 ${iconColorClass(kind)}`;
  const S = ({ children }: { children: React.ReactNode }) => (
    <svg className={cls} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
      {children}
    </svg>
  );
  switch (kind) {
    // 目录：闭合 = 实心文件夹，展开 = 打开的文件夹
    case 'dir':
      return (
        <svg className={cls} fill="currentColor" viewBox="0 0 24 24">
          <path d="M3 7a2 2 0 0 1 2-2h3.9c.5 0 1 .2 1.3.6L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
        </svg>
      );
    case 'dir-open':
      return (
        <svg className={cls} fill="currentColor" viewBox="0 0 24 24">
          <path d="M3 8a2 2 0 0 1 2-2h3.6c.5 0 1 .2 1.3.6L11.2 8H20a1 1 0 0 1 1 1.2l-1.4 7A2 2 0 0 1 17.6 18H5a2 2 0 0 1-2-2V8z" opacity="0.85" />
        </svg>
      );
    // 代码：尖括号
    case 'code':
      return (
        <S>
          <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
        </S>
      );
    // 脚本：终端符 + 光标
    case 'script':
      return (
        <S>
          <path d="m5 7 4 4-4 4M12 16h7" />
        </S>
      );
    // 配置：滑杆
    case 'config':
      return (
        <S>
          <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </S>
      );
    // 数据：表格
    case 'data':
      return (
        <S>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 10h18M9 10v9" />
        </S>
      );
    // 查询：数据库
    case 'query':
      return (
        <S>
          <ellipse cx="12" cy="6" rx="7" ry="3" />
          <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
        </S>
      );
    // 标记：尖括号 + 斜杠
    case 'markup':
      return (
        <S>
          <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5l-3 14" />
        </S>
      );
    // 压缩包：拉链
    case 'archive':
      return (
        <S>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M12 4v3M12 10v2M12 15v2" />
        </S>
      );
    // 日志：横线文本
    case 'log':
      return (
        <S>
          <path d="M5 6h14M5 10h14M5 14h9M5 18h6" />
        </S>
      );
    // 图片：山峦
    case 'image':
      return (
        <S>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m4 18 5-5 4 4 3-2 4 3" />
        </S>
      );
    // 证书：绶带
    case 'cert':
      return (
        <S>
          <circle cx="12" cy="10" r="5" />
          <path d="m8.5 14-1.5 7 5-2.5 5 2.5-1.5-7" />
        </S>
      );
    // 锁/密钥
    case 'lock':
      return (
        <S>
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </S>
      );
    // 二进制：方块
    case 'binary':
      return (
        <S>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 9h2v2H9zM13 9h2v2h-2zM9 13h2v2H9zM13 13h2v2h-2z" fill="currentColor" />
        </S>
      );
    default:
      // 普通文件：文档
      return (
        <S>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </S>
      );
  }
}
function IconBtn({ title, children, onClick }: { title: string; children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3" title={title} onClick={onClick}>
      {children}
    </button>
  );
}
