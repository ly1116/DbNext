import { useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { useAppStore } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import type { ConnectionFolder, ConnectionSummary, DbColumn } from '@shared/types';
import { folderScope } from '@shared/types';
import { StatusDot } from '@renderer/components/common/States';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';
import { promptDialog } from '@renderer/components/common/PromptDialog';

/**
 * 工作台左侧栏「数据库」树（Navicat 风格，嵌入工作台而非独立屏）。
 *
 * 层级：数据库连接 → 库 → 表 → 字段（懒加载，真实 information_schema 内省）。
 * - 单击连接：选中；
 * - 双击连接：自动连接并展开其库列表；
 * - 双击表：在中间区打开数据网格标签页（与终端标签并列）。
 *
 * @since 0.2.0
 */
export function DbTree() {
  const connections = useConnections((s) => s.connections);
  const folders = useConnections((s) => s.folders);
  const selectedId = useConnections((s) => s.selectedId);
  const select = useConnections((s) => s.select);
  const setStatus = useConnections((s) => s.setStatus);
  const removeConn = useConnections((s) => s.remove);
  const addFolder = useConnections((s) => s.addFolder);
  const renameFolder = useConnections((s) => s.renameFolder);
  const removeFolder = useConnections((s) => s.removeFolder);
  const moveToFolder = useConnections((s) => s.moveToFolder);
  const openDbTab = useAppStore((s) => s.openDbTab);
  const openOverlay = useAppStore((s) => s.openOverlay);

  const dbConns = connections.filter((c) => c.kind === 'mysql' || c.kind === 'postgres' || c.kind === 'redis');

  /* —— 文件夹（数据库侧专属作用域，与 SSH 树完全独立，互不串门）—— */
  /** 本侧栏专属文件夹（仅 db 作用域） */
  const myFolders = useMemo(() => folders.filter((f) => folderScope(f) === 'db'), [folders]);
  /** 新建文件夹：内联命名输入 */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  /** 正在重命名的文件夹（内联输入） */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  /** 文件夹折叠状态 */
  const [collapsedF, setCollapsedF] = useState<Record<string, boolean>>({});
  /** 右键菜单：数据库连接 / 文件夹 */
  const [connMenu, setConnMenu] = useState<{ conn: ConnectionSummary; x: number; y: number } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folder: ConnectionFolder; x: number; y: number } | null>(null);
  /** 拖拽归组：正在拖动的连接 id / 拖拽悬停的目标文件夹 id */
  const [dragConn, setDragConn] = useState<string | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);

  /** 归入本侧栏自定义文件夹的连接名集合（未分组列表里排除这些） */
  const folderedNames = useMemo(() => new Set(myFolders.map((f) => f.name)), [myFolders]);
  const ungrouped = useMemo(
    () => dbConns.filter((c) => !c.group || !folderedNames.has(c.group)),
    [dbConns, folderedNames],
  );

  const submitCreate = () => {
    if (newName.trim()) void addFolder(newName, 'db');
    setNewName('');
    setCreating(false);
  };
  const submitRename = () => {
    if (renaming && renaming.name.trim()) void renameFolder(renaming.id, renaming.name);
    setRenaming(null);
  };

  /** 数据库连接右键菜单（连接 / 编辑 / 移动到文件夹 / 删除） */
  const connMenuItems = (c: ConnectionSummary): MenuItem[] => {
    const currentFolder = folders.find((f) => f.name === c.group);
    return [
      { label: c.status === 'connected' ? '断开' : '连接', onClick: () => void activate(c) },
      { label: '编辑…', onClick: () => openOverlay({ kind: 'connection-edit', connectionId: c.id }) },
      ...(c.kind !== 'redis' && c.status === 'connected' ? ([{ label: '新建数据库…', onClick: () => void createDb(c.id) }] as MenuItem[]) : []),
      { separator: true, label: '' },
      {
        label: '移动到文件夹',
        children: [
          ...myFolders.map((f) => ({
            label: `${f.name}${currentFolder?.id === f.id ? ' ✓' : ''}`,
            onClick: () => void moveToFolder(c.id, f.id),
          })),
          ...(myFolders.length === 0 ? ([{ label: '（暂无文件夹，先在树上方新建）', disabled: true }] as MenuItem[]) : []),
          ...(currentFolder
            ? ([{ separator: true, label: '' }, { label: '移出文件夹', onClick: () => void moveToFolder(c.id, null) }] as MenuItem[])
            : []),
        ],
      },
      { separator: true, label: '' },
      {
        label: '删除',
        danger: true,
        onClick: () => {
          void api.deleteConnection(c.id).catch(() => undefined);
          removeConn(c.id);
        },
      },
    ];
  };

  /** 文件夹右键菜单（新建连接归入此文件夹 / 重命名 / 删除文件夹） */
  const folderMenuItems = (f: ConnectionFolder): MenuItem[] => [
    {
      label: '新建数据库连接（归入此文件夹）',
      onClick: () => openOverlay({ kind: 'connection-edit', preset: { group: f.name, kind: 'mysql', kindScope: ['mysql', 'postgres', 'redis'] } }),
    },
    { separator: true, label: '' },
    { label: '重命名…', onClick: () => setRenaming({ id: f.id, name: f.name }) },
    { separator: true, label: '' },
    { label: '删除文件夹', danger: true, onClick: () => void removeFolder(f.id) },
  ];

  /** 双击/单击连接：连接（如未连）→ 展开其库列表（Redis 不支持库表浏览，只展开提示） */
  const activate = async (c: ConnectionSummary) => {
    select(c.id);
    // 正在连接中：忽略重复触发（单击+双击连点保护）
    if (c.status === 'connecting') return;
    if (c.status !== 'connected') {
      setStatus(c.id, 'connecting');
      try {
        const s = await api.connect(c.id);
        select(s.id);
        setConnErr((m) => {
          const n = { ...m };
          delete n[c.id];
          return n;
        });
      } catch (e) {
        setStatus(c.id, 'error');
        setConnErr((m) => ({ ...m, [c.id]: (e as Error).message }));
        return;
      }
    }
    if (c.kind === 'redis') {
      // Redis 为键值库，无库表树；仅展开一行提示
      setOpenConns((s) => {
        const n = new Set(s);
        n.add(c.id);
        return n;
      });
      return;
    }
    toggleConn(c.id);
  };

  const [openConns, setOpenConns] = useState<Set<string>>(new Set());
  /** 连接失败的真实错误信息（展示在连接节点下方） */
  const [connErr, setConnErr] = useState<Record<string, string>>({});
  const [dbsByConn, setDbsByConn] = useState<Record<string, string[]>>({});
  const [loadingDbs, setLoadingDbs] = useState<string | null>(null);

  const [openDbs, setOpenDbs] = useState<Set<string>>(new Set());
  /** 库下模式列表（PG 专有；key=`connId::db`，db 为真实库名——展开哪个库就连哪个库内省）。MySQL 无模式层 */
  const [schemasByDb, setSchemasByDb] = useState<Record<string, string[]>>({});
  const [loadingSchemas, setLoadingSchemas] = useState<string | null>(null);
  /** 已展开的模式节点（key=`connId::db::schema`） */
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  /** 库级内省失败的真实错误（如无权限连该库；key=`connId::db`） */
  const [dbErr, setDbErr] = useState<Record<string, string>>({});

  /** 对象分类节点：固定五类（Navicat 同款层级 库 → 模式 → 表/视图/物化视图/序列/函数） */
  const OBJ_KINDS = [
    { kind: 'table', label: '表' },
    { kind: 'view', label: '视图' },
    { kind: 'mview', label: '物化视图' },
    { kind: 'sequence', label: '序列' },
    { kind: 'function', label: '函数' },
  ] as const;
  /** MySQL 只支持 表/视图 两类 */
  const MYSQL_KINDS = [
    { kind: 'table', label: '表' },
    { kind: 'view', label: '视图' },
  ] as const;

  const [openCats, setOpenCats] = useState<Set<string>>(new Set());
  /** 分类下的对象名列表（key=`connId::db::schema::kind`；PG 的 db 槽存 schema） */
  const [objsByCat, setObjsByCat] = useState<Record<string, string[]>>({});
  const [loadingObjs, setLoadingObjs] = useState<string | null>(null);

  const [openTables, setOpenTables] = useState<Set<string>>(new Set());
  const [colsByTable, setColsByTable] = useState<Record<string, DbColumn[]>>({});
  const [loadingCols, setLoadingCols] = useState<string | null>(null);

  /** 展开/折叠某连接的库列表（懒加载） */
  const toggleConn = async (id: string) => {
    setOpenConns((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
    if (!dbsByConn[id] && !loadingDbs) {
      setLoadingDbs(id);
      try {
        const d = await api.listDatabases(id);
        setDbsByConn((m) => ({ ...m, [id]: d }));
      } catch {
        setDbsByConn((m) => ({ ...m, [id]: [] }));
      } finally {
        setLoadingDbs(null);
      }
    }
  };

  /** 展开/折叠某库：PG 实际连到该库加载模式列表（跨库内省），MySQL 直接挂表/视图分类（无模式层） */
  const toggleDb = async (connId: string, db: string, isPg: boolean) => {
    const key = `${connId}::${db}`;
    setOpenDbs((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
    if (isPg && !schemasByDb[key] && !loadingSchemas) {
      setLoadingSchemas(key);
      try {
        // 真实连到目标库内省（主进程为该库建/复用附加池；无权限等错误会在此抛出）
        const schemas = await api.listSchemas(connId, db);
        setSchemasByDb((m) => ({ ...m, [key]: schemas.length ? schemas : ['public'] }));
        setDbErr((m) => {
          const n = { ...m };
          delete n[key];
          return n;
        });
      } catch (e) {
        setDbErr((m) => ({ ...m, [key]: (e as Error).message }));
      } finally {
        setLoadingSchemas(null);
      }
    }
  };

  /** 展开/折叠某个分类节点（表/视图/…，懒加载对象名；db=真实库名用于 PG 跨库） */
  const toggleCat = async (connId: string, db: string, schema: string, kind: 'table' | 'view' | 'mview' | 'sequence' | 'function') => {
    const key = `${connId}::${db}::${schema}::${kind}`;
    setOpenCats((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
    if (!objsByCat[key] && !loadingObjs) {
      setLoadingObjs(key);
      try {
        const objs = await api.listObjects(connId, kind, schema, db);
        setObjsByCat((m) => ({ ...m, [key]: objs }));
      } catch {
        setObjsByCat((m) => ({ ...m, [key]: [] }));
      } finally {
        setLoadingObjs(null);
      }
    }
  };

  /** 展开/折叠字段（PG：dbName=真实库名、schema=模式；MySQL：dbName 传库名、schema 同值） */
  const toggleTable = async (connId: string, dbName: string | undefined, schema: string | undefined, table: string) => {
    const key = `${connId}::${dbName ?? ''}::${schema ?? ''}::${table}`;
    setOpenTables((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
    if (!colsByTable[key] && !loadingCols) {
      setLoadingCols(key);
      try {
        const c = await api.listColumns(connId, schema ?? '', table, dbName);
        setColsByTable((m) => ({ ...m, [key]: c }));
      } catch {
        setColsByTable((m) => ({ ...m, [key]: [] }));
      } finally {
        setLoadingCols(null);
      }
    }
  };

  /** 双击表 → 中间区打开数据标签页（PG：db=schema、pgDb=库名，网格按 库.模式.表 精确定位） */
  const openTable = (connId: string, dbName: string | undefined, schema: string | undefined, table: string) => {
    openDbTab({ id: `t:${connId}:${dbName ?? ''}:${schema ?? ''}:${table}`, connId, type: 'table', db: schema, pgDb: dbName, table, title: table });
  };

  /** 刷新整棵树：重新加载所有已展开的 库 / 模式 / 分类对象 / 字段 */
  const refreshAll = async () => {
    await Promise.all(
      [...openConns].map(async (id) => {
        try {
          const d = await api.listDatabases(id);
          setDbsByConn((m) => ({ ...m, [id]: d }));
        } catch {
          /* 连接已断开等：保持原状 */
        }
      }),
    );
    // PG：对每个已展开库重新内省模式列表（真实连到该库）
    await Promise.all(
      [...openDbs].map(async (key) => {
        const [connId, db] = key.split('::');
        const conn = connections.find((c) => c.id === connId);
        if (conn?.kind !== 'postgres' || !db) return;
        try {
          const schemas = await api.listSchemas(connId, db);
          setSchemasByDb((m) => ({ ...m, [key]: schemas.length ? schemas : ['public'] }));
        } catch {
          /* ignore */
        }
      }),
    );
    await Promise.all(
      [...openCats].map(async (key) => {
        const [connId, db, schema, kind] = key.split('::') as [string, string, string, 'table'];
        try {
          const objs = await api.listObjects(connId, kind, schema, db);
          setObjsByCat((m) => ({ ...m, [key]: objs }));
        } catch {
          /* ignore */
        }
      }),
    );
    await Promise.all(
      [...openTables].map(async (key) => {
        const [connId, dbName, schema, table] = key.split('::');
        try {
          const c = await api.listColumns(connId, schema ?? '', table ?? '', dbName || undefined);
          setColsByTable((m) => ({ ...m, [key]: c }));
        } catch {
          /* ignore */
        }
      }),
    );
  };

  /** 在某连接下新建数据库（数据库侧的「创建目录」） */
  const createDb = async (connId: string) => {
    const name = await promptDialog({ title: '新建数据库', placeholder: '数据库名称' });
    if (!name || !name.trim()) return;
    try {
      await api.createDatabase(connId, name.trim());
      const d = await api.listDatabases(connId);
      setDbsByConn((m) => ({ ...m, [connId]: d }));
      setOpenConns((s) => new Set(s).add(connId));
    } catch (e) {
      window.alert(`创建数据库失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="flex w-[236px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-dim">数据库</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3 hover:text-fg"
            title="刷新数据库树"
            onClick={() => void refreshAll()}
          >
            <RefreshIcon />
          </button>
          {/* 新建文件夹：树内内联命名（与 SSH 树同一套持久化） */}
          <button
            className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3 hover:text-fg"
            title="新建文件夹"
            aria-label="新建文件夹"
            onClick={() => {
              setCreating(true);
              setNewName('');
            }}
          >
            <FolderPlusIcon />
          </button>
          <button
            className="flex h-6 w-6 items-center justify-center rounded bg-accent text-white hover:bg-accent2"
            title="新建数据库连接（MySQL / PostgreSQL / Redis）"
            onClick={() =>
              openOverlay({ kind: 'connection-edit', preset: { kind: 'mysql', kindScope: ['mysql', 'postgres', 'redis'] } })
            }
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      {/* 新建文件夹内联命名输入（Enter 确认 / Esc 取消） */}
      {creating && (
        <div className="shrink-0 border-b border-line px-2 py-2">
          <div className="flex h-6 items-center gap-1.5 rounded border border-accent bg-bg px-2">
            <FolderIcon className="shrink-0 text-warn" />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCreate();
                if (e.key === 'Escape') {
                  setCreating(false);
                  setNewName('');
                }
              }}
              onBlur={submitCreate}
              placeholder="文件夹名称，Enter 确认"
              className="flex-1 bg-transparent text-[11px] text-fg outline-none placeholder:text-dim2"
            />
          </div>
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto py-1 text-[12px] mono"
        onDragOver={(e) => {
          // 拖动连接经过树的空白区域：允许放置 = 移出文件夹
          if (!dragConn) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData('text/dbnest-conn') || dragConn;
          if (id) void moveToFolder(id, null);
          setDragConn(null);
          setDropFolderId(null);
        }}
      >
        {dbConns.length === 0 && (
          <div className="px-3 py-4 text-[11px] text-dim2">暂无数据库连接，点击右上「+」新建（MySQL / PostgreSQL / Redis）。</div>
        )}
        {(() => {
          /** 单个数据库连接节点（库 → 表 → 字段懒加载树） */
          const renderConn = (c: ConnectionSummary) => {
          const open = openConns.has(c.id);
          const dbs = dbsByConn[c.id];
          return (
            <div>
              <button
                onClick={() => {
                  select(c.id);
                  // 已连接：单击即展开/折叠库列表（Navicat 习惯）；
                  // 未连接：单击直接发起连接并展开层级（比双击更直观）
                  if (c.status === 'connected') {
                    if (c.kind !== 'redis') void toggleConn(c.id);
                  } else if (c.status !== 'connecting') {
                    void activate(c);
                  }
                }}
                onDoubleClick={() => void activate(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setConnMenu({ conn: c, x: e.clientX, y: e.clientY });
                }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/dbnest-conn', c.id);
                  e.dataTransfer.effectAllowed = 'move';
                  setDragConn(c.id);
                }}
                onDragEnd={() => setDragConn(null)}
                className={`tree-row flex w-full items-center gap-1.5 px-2 py-1 text-left ${selectedId === c.id ? 'bg-panel3' : ''}`}
                title={c.status === 'connected' ? '单击展开/折叠库列表；右键更多操作' : '单击连接并展开库列表；右键更多操作'}
              >
                <Chevron open={open} />
                <StatusDot status={c.status} />
                <span className="truncate font-medium text-fg">{c.name}</span>
                <span className="ml-auto text-[9px] text-dim2">
                  {c.kind === 'mysql' ? 'MySQL' : c.kind === 'postgres' ? 'PG' : 'Redis'}
                </span>
              </button>

              {c.status === 'connecting' && (
                <div className="py-0.5 pl-8 text-[10px] text-dim2">连接中…</div>
              )}

              {connErr[c.id] && (
                <div className="py-0.5 pl-8 pr-2 text-[10px] text-prod" title={connErr[c.id]}>
                  连接失败：{connErr[c.id]}
                </div>
              )}

              {open && (
                <>
                  {c.kind === 'redis' && (
                    <div className="py-1 pl-8 text-[10px] text-dim2">Redis 为键值库，无库/表树，请在「Redis」屏查看。</div>
                  )}
                  {loadingDbs === c.id && <div className="py-0.5 pl-8 text-[10px] text-dim2">加载数据库…</div>}
                  {dbs?.length === 0 && loadingDbs !== c.id && (
                    <div className="py-0.5 pl-8 text-[10px] text-dim2">{c.status === 'connected' ? '（无数据库）' : '未连接，双击上方连接'}</div>
                  )}
                  {(dbs ?? []).map((db) => {
                    const dbKey = `${c.id}::${db}`;
                    const dbOpen = openDbs.has(dbKey);
                    const isPg = c.kind === 'postgres';
                    const schemas = schemasByDb[dbKey];
                    /** 分类节点（表/视图/物化视图/序列/函数）：懒加载对象名，可展开的类别还能再展开字段 */
                    const renderCat = (
                      db2: string,
                      schema: string,
                      cat: { kind: 'table' | 'view' | 'mview' | 'sequence' | 'function'; label: string },
                      catIndent: string,
                      itemIndent: string,
                      colIndent: string,
                    ) => {
                      const catKey = `${c.id}::${db2}::${schema}::${cat.kind}`;
                      const catOpen = openCats.has(catKey);
                      const objs = objsByCat[catKey];
                      const expandable = cat.kind === 'table' || cat.kind === 'view' || cat.kind === 'mview';
                      return (
                        <div key={catKey}>
                          <button
                            onClick={() => void toggleCat(c.id, db2, schema, cat.kind)}
                            className={`tree-row flex w-full items-center gap-1 py-1 text-left ${catIndent} ${catOpen ? 'bg-panel3' : ''}`}
                          >
                            <Chevron open={catOpen} />
                            <ObjIcon kind={cat.kind} />
                            <span className="truncate text-fg">{cat.label}</span>
                            {objs && <span className="ml-1 text-[10px] text-dim2">{objs.length}</span>}
                          </button>
                          {catOpen && (
                            <>
                              {loadingObjs === catKey && <div className={`py-0.5 text-[10px] text-dim2 ${itemIndent}`}>加载…</div>}
                              {objs?.length === 0 && loadingObjs !== catKey && <div className={`py-0.5 text-[10px] text-dim2 ${itemIndent}`}>（空）</div>}
                              {(objs ?? []).map((name) => {
                                const tKey = `${c.id}::${db2}::${schema}::${name}`;
                                const tOpen = openTables.has(tKey);
                                const cols = colsByTable[tKey];
                                return (
                                  <div key={name}>
                                    <div className={`tree-row flex w-full items-center gap-1 py-1 ${itemIndent} ${tOpen ? 'bg-panel3' : ''}`}>
                                      {expandable ? (
                                        <>
                                          <button
                                            onClick={() => void toggleTable(c.id, db2, schema, name)}
                                            className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                            title="单击展开字段 / 双击打开数据"
                                          >
                                            <Chevron open={tOpen} />
                                            <TableIcon />
                                            <span className="truncate text-dim">{name}</span>
                                          </button>
                                          <button
                                            onClick={() => openTable(c.id, db2, schema, name)}
                                            className="shrink-0 rounded px-1 text-[9px] text-ok hover:underline"
                                            title="打开表数据"
                                          >
                                            数据
                                          </button>
                                        </>
                                      ) : (
                                        <div className="flex min-w-0 flex-1 items-center gap-1 pl-4 text-left">
                                          <ObjIcon kind={cat.kind} />
                                          <span className="truncate text-dim">{name}</span>
                                        </div>
                                      )}
                                    </div>
                                    {expandable &&
                                      tOpen &&
                                      (loadingCols === tKey ? (
                                        <div className={`py-0.5 text-[10px] text-dim2 ${colIndent}`}>加载字段…</div>
                                      ) : (
                                        (cols ?? []).map((col) => (
                                          <div key={col.name} className={`flex w-full items-center gap-1.5 py-0.5 text-[11px] text-dim2 ${colIndent}`}>
                                            <ColIcon />
                                            <span className="truncate text-fg">{col.name}</span>
                                            <span className="text-[10px] text-dim2">{col.dataType}</span>
                                            {col.key === 'PRI' && <span className="text-[9px] text-warn" title="主键">🔑</span>}
                                            {!col.nullable && <span className="text-[9px] text-dim2" title="NOT NULL">N</span>}
                                          </div>
                                        ))
                                      ))}
                                  </div>
                                );
                              })}
                            </>
                          )}
                        </div>
                      );
                    };
                    return (
                      <div key={db}>
                        <button
                          onClick={() => void toggleDb(c.id, db, isPg)}
                          className={`tree-row flex w-full items-center gap-1 py-1 pl-7 text-left ${dbOpen ? 'bg-panel3' : ''}`}
                        >
                          <Chevron open={dbOpen} />
                          <DbIcon />
                          <span className="truncate text-fg">{db}</span>
                        </button>
                        {dbOpen && (
                          <>
                            {/* PG：库 → 模式(schema) → 分类（展开哪个库就真实连哪个库内省） */}
                            {isPg && loadingSchemas === dbKey && <div className="py-0.5 pl-10 text-[10px] text-dim2">连接该库并加载模式…</div>}
                            {isPg && dbErr[dbKey] && (
                              <div className="py-0.5 pl-10 pr-2 text-[10px] text-prod" title={dbErr[dbKey]}>
                                内省失败：{dbErr[dbKey]}
                              </div>
                            )}
                            {isPg &&
                              (schemas ?? []).map((schema) => {
                                const sKey = `${dbKey}::${schema}`;
                                const sOpen = openSchemas.has(sKey);
                                return (
                                  <div key={schema}>
                                    <button
                                      onClick={() =>
                                        setOpenSchemas((s) => {
                                          const n = new Set(s);
                                          if (n.has(sKey)) n.delete(sKey);
                                          else n.add(sKey);
                                          return n;
                                        })
                                      }
                                      className={`tree-row flex w-full items-center gap-1 py-1 pl-10 text-left ${sOpen ? 'bg-panel3' : ''}`}
                                    >
                                      <Chevron open={sOpen} />
                                      <SchemaIcon />
                                      <span className="truncate text-fg">{schema}</span>
                                    </button>
                                    {sOpen &&
                                      OBJ_KINDS.map((cat) => renderCat(db, schema, cat, 'pl-[3.25rem]', 'pl-[4.25rem]', 'pl-[5.25rem]'))}
                                  </div>
                                );
                              })}
                            {/* MySQL：无模式层，库下直接挂 表/视图 两类 */}
                            {!isPg && MYSQL_KINDS.map((cat) => renderCat(db, db, cat, 'pl-10', 'pl-[3.25rem]', 'pl-[4.25rem]'))}
                          </>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          );
          };
          return (
            <>
              {/* —— 自定义文件夹（仅数据库侧作用域，与 SSH 树独立）—— */}
              {myFolders.map((f) => {
                const items = dbConns.filter((c) => c.group === f.name);
                const renamingThis = renaming?.id === f.id;
                return (
                  <div key={f.id}>
                    {renamingThis ? (
                      /* 重命名内联输入 */
                      <div className="flex items-center gap-1.5 px-2 py-1">
                        <FolderIcon className="shrink-0 text-warn" />
                        <input
                          autoFocus
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: f.id, name: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitRename();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onBlur={submitRename}
                          className="flex-1 rounded border border-accent bg-bg px-1.5 py-0.5 text-[12px] text-fg outline-none"
                        />
                      </div>
                    ) : (
                      <button
                        onClick={() => setCollapsedF((m) => ({ ...m, [f.id]: !m[f.id] }))}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setFolderMenu({ folder: f, x: e.clientX, y: e.clientY });
                        }}
                        onDragOver={(e) => {
                          if (!dragConn) return;
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'move';
                          setDropFolderId(f.id);
                        }}
                        onDragLeave={() => setDropFolderId((cur) => (cur === f.id ? null : cur))}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const id = e.dataTransfer.getData('text/dbnest-conn') || dragConn;
                          if (id) void moveToFolder(id, f.id);
                          setDropFolderId(null);
                          setDragConn(null);
                        }}
                        className={`tree-row flex w-full items-center gap-1 px-2 py-1 text-left ${dropFolderId === f.id ? 'ring-1 ring-accent' : ''}`}
                        title="拖动数据库连接到此可归入文件夹；右键：重命名 / 删除"
                      >
                        <Chevron open={!collapsedF[f.id]} />
                        <FolderIcon className="shrink-0 text-warn" />
                        <span className="truncate font-medium text-fg">{f.name}</span>
                        <span className="ml-1 text-[10px] text-dim2">{items.length}</span>
                      </button>
                    )}

                    {!collapsedF[f.id] &&
                      (items.length === 0 ? (
                        <div className="py-0.5 pl-9 pr-2 text-[10px] text-dim2">（空）右键连接 → 移动到文件夹</div>
                      ) : (
                        /* 目录内容整体缩进 + 左侧树状引导线，清晰表达 目录 → 连接 的层级 */
                        <div className="ml-3 border-l border-line pl-1">
                          {items.map((c) => (
                            <div key={c.id}>{renderConn(c)}</div>
                          ))}
                        </div>
                      ))}
                  </div>
                );
              })}

              {/* —— 未归入文件夹的数据库连接 —— */}
              {ungrouped.map((c) => (
                <div key={c.id}>{renderConn(c)}</div>
              ))}
            </>
          );
        })()}
      </div>

      {/* 数据库连接右键菜单（连接 / 编辑 / 移动到文件夹 / 删除） */}
      {connMenu && (
        <ContextMenu x={connMenu.x} y={connMenu.y} items={connMenuItems(connMenu.conn)} onClose={() => setConnMenu(null)} />
      )}
      {/* 文件夹右键菜单（新建连接归入 / 重命名 / 删除文件夹） */}
      {folderMenu && (
        <ContextMenu x={folderMenu.x} y={folderMenu.y} items={folderMenuItems(folderMenu.folder)} onClose={() => setFolderMenu(null)} />
      )}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chev h-3 w-3 shrink-0 text-dim2 ${open ? 'open' : ''}`} fill="currentColor" viewBox="0 0 12 12">
      <path d="M4 3l4 3-4 3z" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.4} viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={`h-3.5 w-3.5 ${className ?? ''}`} fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function FolderPlusIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}
function RefreshIcon() {
  return (
    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
function DbIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-[#e48e00]" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  );
}
function TableIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14h18M9 4v16" />
    </svg>
  );
}
/** 模式(schema)节点图标：Navicat 风格的命名空间 */
function SchemaIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-[#b18cff]" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3v5.5M12 15.5V21M3 12h5.5M15.5 12H21" />
    </svg>
  );
}
/** 分类节点图标（表/视图/物化视图/序列/函数），按 kind 换形换色 */
function ObjIcon({ kind }: { kind: 'table' | 'view' | 'mview' | 'sequence' | 'function' }) {
  if (kind === 'table')
    return (
      <svg className="h-3.5 w-3.5 shrink-0 text-ok" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M3 14h18M9 4v16" />
      </svg>
    );
  if (kind === 'view' || kind === 'mview')
    return (
      <svg className="h-3.5 w-3.5 shrink-0 text-[#41b0f5]" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    );
  if (kind === 'sequence')
    return (
      <svg className="h-3.5 w-3.5 shrink-0 text-warn" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
        <path d="M4 6h2M9 6h11M4 12h2M9 12h11M4 18h2M9 18h11" />
      </svg>
    );
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px] font-semibold italic leading-none text-[#e48e00]">ƒ</span>
  );
}
function ColIcon() {
  return (
    <svg className="h-3 w-3 shrink-0 text-dim2" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
      <path d="M8 6h8M8 12h8M8 18h8" />
    </svg>
  );
}
