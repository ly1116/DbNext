import { useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { useAppStore } from '@renderer/store/appStore';
import { useConnections } from '@renderer/store/connectionStore';
import { useScriptStore } from '@renderer/store/scriptStore';
import type { ConnectionFolder, ConnectionSummary, DbCreateOptions, DbCreateSpec } from '@shared/types';
import { folderScope } from '@shared/types';
import { StatusDot } from '@renderer/components/common/States';
import { ContextMenu, type MenuItem } from '@renderer/components/common/ContextMenu';

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
  /** 记录树中选中节点的查询上下文（工具栏「新建查询」据此把查询直接落到该连接的该库/模式） */
  const setTreeQueryCtx = useAppStore((s) => s.setTreeQueryCtx);

  const dbConns = connections.filter((c) => c.kind === 'mysql' || c.kind === 'postgres' || c.kind === 'oracle' || c.kind === 'redis');

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
  /* —— SQL 脚本节点（连接级，localStorage 持久化，查询页 Ctrl+S 保存）—— */
  const scripts = useScriptStore((s) => s.scriptsByConn);
  const loadScripts = useScriptStore((s) => s.load);
  const removeScript = useScriptStore((s) => s.remove);
  /** 脚本节点展开状态（按连接） */
  const [openScripts, setOpenScripts] = useState<Set<string>>(new Set());
  /** 脚本右键菜单 */
  const [scriptMenu, setScriptMenu] = useState<{ connId: string; id: string; name: string; sql: string; x: number; y: number } | null>(null);
  /** 「脚本」文件夹节点右键菜单（打开脚本目录） */
  const [scriptFolderMenu, setScriptFolderMenu] = useState<{ connId: string; x: number; y: number } | null>(null);

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
      {
        label: '编辑…',
        onClick: () =>
          openOverlay({
            kind: 'connection-edit',
            connectionId: c.id,
            // 编辑时类型选择器只显示与该连接同类别的选项（数据库连接不给 SSH/堡垒机）
            preset: {
              kindScope:
                c.kind === 'ssh' || c.kind === 'bastion' ? ['ssh', 'bastion'] : ['mysql', 'postgres', 'oracle', 'redis'],
            },
          }),
      },
      ...(c.kind !== 'redis' && c.status === 'connected' ? ([{ label: '新建数据库…', onClick: () => void createDb(c.id, c.kind === 'postgres' ? 'postgres' : c.kind === 'oracle' ? 'oracle' : 'mysql') }] as MenuItem[]) : []),
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
      onClick: () => openOverlay({ kind: 'connection-edit', preset: { group: f.name, kind: 'mysql', kindScope: ['mysql', 'postgres', 'oracle', 'redis'] } }),
    },
    { separator: true, label: '' },
    { label: '重命名…', onClick: () => setRenaming({ id: f.id, name: f.name }) },
    { separator: true, label: '' },
    { label: '删除文件夹', danger: true, onClick: () => void removeFolder(f.id) },
  ];

  /** 表/对象节点右键菜单（新建表/视图/函数等，按方言过滤） */
  const [objMenu, setObjMenu] = useState<{ connId: string; db: string | undefined; schema: string; kind: 'table' | 'view' | 'mview' | 'sequence' | 'function'; name?: string; x: number; y: number } | null>(null);

  const objMenuItems = (connId: string, db: string | undefined, schema: string, kind: 'table' | 'view' | 'mview' | 'sequence' | 'function', name?: string): MenuItem[] => {
    const items: MenuItem[] = [];

    if (kind === 'table') {
      items.push(
        { label: '新建表…', onClick: () => openOverlay({ kind: 'create-table', connectionId: connId, preset: { db, schema, objectKind: 'table' } }) },
        { separator: true, label: '' },
        { label: '刷新', onClick: () => void refreshAll() }
      );
    }

    if (name) {
      // 具体对象上的右键：查看/编辑/删除等
      const openLabel = kind === 'table' ? '打开表数据' : kind === 'sequence' ? '打开序列' : kind === 'function' ? '打开函数定义' : '打开定义';
      items.unshift(
        { label: openLabel, onClick: () => void openObject(connId, db, schema, kind, name) },
        { separator: true, label: '' }
      );
      if (kind === 'table' || kind === 'view' || kind === 'mview') {
        items.push(
          { label: '编辑结构…', onClick: () => openOverlay({ kind: 'create-table', connectionId: connId, preset: { db, schema, objectKind: kind, editName: name } }) },
          { separator: true, label: '' },
          { label: '删除', danger: true, onClick: () => void api.dropObject(connId, kind, schema, name, db) }
        );
      }
    }

    return items;
  };

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
      // Redis 为键值库：双击展开 db0-db15 节点，并加载各库 key 数量
      setOpenConns((s) => {
        const n = new Set(s);
        n.add(c.id);
        return n;
      });
      void loadRedisCounts(c.id);
      return;
    }
    toggleConn(c.id);
  };

  const [openConns, setOpenConns] = useState<Set<string>>(new Set());
  /** Redis 各 db 的 key 数量（key=connId，value=db序号→数量；展开 Redis 节点时加载） */
  const [redisCounts, setRedisCounts] = useState<Record<string, Record<number, number>>>({});
  /** 加载 Redis 各 db key 数量（INFO keyspace 一次拿全） */
  const loadRedisCounts = async (connId: string) => {
    try {
      const info = await api.redisDbInfo(connId);
      setRedisCounts((m) => ({ ...m, [connId]: info }));
    } catch {
      /* 未连接/连接失败：忽略，保持空 */
    }
  };
  /** 连接失败的真实错误信息（展示在连接节点下方） */
  const [connErr, setConnErr] = useState<Record<string, string>>({});
  const [dbsByConn, setDbsByConn] = useState<Record<string, string[]>>({});
  const [loadingDbs, setLoadingDbs] = useState<string | null>(null);

  const [openDbs, setOpenDbs] = useState<Set<string>>(new Set());
  /** PG：连接下「数据库」文件夹展开状态（Navicat 风格 连接 → 数据库 → 库） */
  const [openDbFolder, setOpenDbFolder] = useState<Set<string>>(new Set());
  /** 库下模式列表（PG 专有；key=`connId::db`，db 为真实库名——展开哪个库就连哪个库内省）。MySQL 无模式层 */
  const [schemasByDb, setSchemasByDb] = useState<Record<string, string[]>>({});
  const [loadingSchemas, setLoadingSchemas] = useState<string | null>(null);
  /** 已展开的模式节点（key=`connId::db::schema`） */
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(new Set());
  /** 库级内省失败的真实错误（如无权限连该库；key=`connId::db`） */
  const [dbErr, setDbErr] = useState<Record<string, string>>({});

  /** PG 库下的元数据分类节点（Navicat 风格：模式 + 服务器级对象） */
  const PG_META_CATS = [
    { meta: 'schemas', label: '模式' },
    { meta: 'event_trigger', label: '事件触发器' },
    { meta: 'extension', label: '扩展' },
    { meta: 'tablespace', label: '存储' },
    { meta: 'sysinfo', label: '系统信息' },
    { meta: 'role', label: '角色' },
  ] as const;
  type PgMetaCat = (typeof PG_META_CATS)[number]['meta'];
  /** 元数据分类展开状态（key=`connId::db::meta`）与其内容 */
  const [openMeta, setOpenMeta] = useState<Set<string>>(new Set());
  const [metaByCat, setMetaByCat] = useState<Record<string, string[]>>({});
  const [loadingMeta, setLoadingMeta] = useState<string | null>(null);

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

  /** 展开/折叠某连接的库列表（懒加载；PG 同时自动展开「数据库」文件夹层） */
  const toggleConn = async (id: string) => {
    setOpenConns((s) => {
      const n = new Set(s);
      const opening = !n.has(id);
      if (opening) n.add(id);
      else n.delete(id);
      // 展开 PG 连接时「数据库」文件夹层默认展开（Navicat 习惯：能看到库列表）
      setOpenDbFolder((f) => {
        const m = new Set(f);
        if (opening) m.add(id);
        else m.delete(id);
        return m;
      });
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

  /** 展开/折叠某库（仅切换展开状态；模式列表由「模式」分类节点懒加载） */
  const toggleDb = async (connId: string, db: string) => {
    const key = `${connId}::${db}`;
    setOpenDbs((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };

  /** 加载某库的模式列表（PG 专有，真实连到该库内省；key=`connId::db`） */
  const loadSchemas = async (connId: string, db: string) => {
    const key = `${connId}::${db}`;
    if (schemasByDb[key] || loadingSchemas) return;
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
  };

  /** 展开/折叠库下元数据分类：「模式」复用 listSchemas，其余走 listPgMeta（事件触发器/扩展/存储/角色/系统信息） */
  const toggleMeta = async (connId: string, db: string, meta: PgMetaCat) => {
    const mKey = `${connId}::${db}::${meta}`;
    setOpenMeta((s) => {
      const n = new Set(s);
      if (n.has(mKey)) n.delete(mKey);
      else n.add(mKey);
      return n;
    });
    if (meta === 'schemas') {
      await loadSchemas(connId, db);
      return;
    }
    if (metaByCat[mKey] || loadingMeta) return;
    setLoadingMeta(mKey);
    try {
      const items = await api.listPgMeta(connId, meta, db);
      setMetaByCat((m) => ({ ...m, [mKey]: items }));
    } catch {
      setMetaByCat((m) => ({ ...m, [mKey]: [] }));
    } finally {
      setLoadingMeta(null);
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

  /** 双击表 → 中间区打开数据标签页（PG：db=schema、pgDb=库名，网格按 库.模式.表 精确定位） */
  const openTable = (connId: string, dbName: string | undefined, schema: string | undefined, table: string) => {
    openDbTab({ id: `t:${connId}:${dbName ?? ''}:${schema ?? ''}:${table}`, connId, type: 'table', db: schema, pgDb: dbName, table, title: table });
  };

  /** 双击 视图/物化视图/函数/序列 → 中间区打开定义标签页（视图浏览器 / 函数浏览器 / 序列浏览器） */
  const openObject = (connId: string, dbName: string | undefined, schema: string, kind: 'table' | 'view' | 'mview' | 'sequence' | 'function', name: string) => {
    if (kind === 'table') return openTable(connId, dbName, schema, name);
    if (kind === 'sequence')
      return openDbTab({ id: `s:${connId}:${dbName ?? ''}:${schema}:${name}`, connId, type: 'sequence', db: schema, pgDb: dbName, schema, name, title: name });
    return openDbTab({
      id: `d:${connId}:${dbName ?? ''}:${schema}:${kind}:${name}`,
      connId,
      type: 'def',
      kind,
      db: schema,
      pgDb: dbName,
      schema,
      name,
      title: name,
    });
  };

  /** 单击分类节点（表/视图/物化视图）→ 中间区打开对象清单页（DBeaver 风格：名称 + 注释，Ctrl+F 搜索，双击行打开表） */
  const openObjList = (connId: string, dbName: string | undefined, schema: string, kind: 'table' | 'view' | 'mview') => {
    const label = kind === 'table' ? '表' : kind === 'view' ? '视图' : '物化视图';
    openDbTab({ id: `l:${connId}:${dbName ?? ''}:${schema}:${kind}`, connId, type: 'objlist', db: schema, pgDb: dbName, schema, kind, title: `${label} · ${schema}` });
  };

  /** 刷新整棵树：重新加载所有已展开的 库 / 模式 / 分类对象 / 字段；Redis 连接顺带刷新各库 key 数量 */
  const refreshAll = async () => {
    await Promise.all(
      [...openConns].map(async (id) => {
        const conn = connections.find((c) => c.id === id);
        if (conn?.kind === 'redis') {
          await loadRedisCounts(id);
          return;
        }
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
    // PG：库下元数据分类（事件触发器/扩展/存储/角色/系统信息）也一并刷新
    await Promise.all(
      [...openMeta].map(async (key) => {
        const [connId, db, meta] = key.split('::') as [string, string, PgMetaCat];
        if (meta === 'schemas') return;
        try {
          const items = await api.listPgMeta(connId, meta, db);
          setMetaByCat((m) => ({ ...m, [key]: items }));
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
  };

  /** 新建数据库对话框开关（kind 决定走 MySQL / PG / Oracle 哪套方言表单） */
  const [createDbState, setCreateDbState] = useState<{ connId: string; kind: 'mysql' | 'postgres' | 'oracle' } | null>(null);
  const openCreateDb = (connId: string, kind: 'mysql' | 'postgres' | 'oracle') => setCreateDbState({ connId, kind });
  const createDb = openCreateDb;

  /** 顶层菜单「刷新」通过自定义事件触发整个树的重新内省 */
  useEffect(() => {
    const onRefresh = () => void refreshAll();
    window.addEventListener('dbnest:refresh-tree', onRefresh);
    return () => window.removeEventListener('dbnest:refresh-tree', onRefresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConns, openDbs, openMeta, openCats]);

  /** Redis 标签页内增删 key 后广播最新统计 → 同步树节点上的计数 */
  useEffect(() => {
    const onCounts = (e: Event) => {
      const d = (e as CustomEvent<{ connId: string; info: Record<number, number> }>).detail;
      if (d?.connId && d.info) setRedisCounts((m) => ({ ...m, [d.connId]: d.info }));
    };
    window.addEventListener('dbnest:redis-counts', onCounts);
    return () => window.removeEventListener('dbnest:redis-counts', onCounts);
  }, []);

  return (
    <div className="flex w-[268px] shrink-0 flex-col border-r border-line bg-panel">
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
            title="新建数据库连接（MySQL / PostgreSQL / Oracle / Redis）"
            onClick={() =>
              openOverlay({ kind: 'connection-edit', preset: { kind: 'mysql', kindScope: ['mysql', 'postgres', 'oracle', 'redis'] } })
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
          <div className="px-3 py-4 text-[11px] text-dim2">暂无数据库连接，点击右上「+」新建（MySQL / PostgreSQL / Oracle / Redis）。</div>
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
                  // 选中连接节点：更新查询上下文（Redis 无库表查询语义，清空）
                  setTreeQueryCtx(c.kind === 'redis' ? null : { connId: c.id });
                  // 已连接：单击即展开/折叠库列表（Navicat 习惯）；
                  // 未连接：单击直接发起连接并展开层级（比双击更直观）
                  if (c.status === 'connected') {
                    if (c.kind === 'redis') {
                      // Redis：单击切换展开/折叠 db0-db15（展开时顺带刷新各库 key 数量）
                      setOpenConns((s) => {
                        const n = new Set(s);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        return n;
                      });
                      if (!open) void loadRedisCounts(c.id);
                    } else {
                      void toggleConn(c.id);
                    }
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
                title={c.status === 'connected' ? '单击展开/折叠 db 列表；右键更多操作' : '单击连接并展开 db 列表；右键更多操作'}
              >
                <Chevron open={open} />
                <ConnIcon kind={c.kind} />
                <span className="truncate font-medium text-fg">{c.name}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
                  <StatusDot status={c.status} />
                  <span className="text-[9px] text-dim2" title={`${c.kind} · ${c.host}:${c.port}`}>
                    {c.host}:${c.port}
                  </span>
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
                    <div className="py-0.5">
                      {Array.from({ length: 16 }, (_, i) => (
                        <div
                          key={i}
                          onClick={() => openDbTab({ id: `redis:${c.id}::${i}`, connId: c.id, type: 'redis', title: `db${i}`, dbIndex: i })}
                          className="tree-row flex w-full items-center gap-1.5 py-1 pl-8 pr-2 text-left hover:bg-panel3 cursor-pointer"
                        >
                          <span className="w-2 shrink-0" />
                          <span className="text-[11px] text-fg">db{i}</span>
                          {redisCounts[c.id] && (
                            <span className="ml-auto text-[10px] text-dim2">{redisCounts[c.id][i] ?? 0}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 用户与权限管理：连接级「用户」节点（PG 角色 / MySQL 用户 / Oracle 用户） */}
                  {c.kind !== 'redis' && (
                    <button
                      onClick={() => openDbTab({ id: `users:${c.id}`, connId: c.id, type: 'users', title: '用户' })}
                      className="tree-row flex w-full items-center gap-1.5 py-1 pl-7 text-left hover:bg-panel3"
                      title="用户与权限管理（PG 角色 / MySQL 用户 / Oracle 用户）"
                    >
                      <UsersIcon />
                      <span className="truncate text-fg">用户</span>
                    </button>
                  )}
                  {loadingDbs === c.id && <div className="py-0.5 pl-8 text-[10px] text-dim2">加载数据库…</div>}
                  {dbs?.length === 0 && loadingDbs !== c.id && (
                    <div className="py-0.5 pl-8 text-[10px] text-dim2">{c.status === 'connected' ? '（无数据库）' : '未连接，双击上方连接'}</div>
                  )}
                  {(() => {
                    /** 库节点（含元数据分类）：PG 挂 模式/事件触发器/扩展/存储/系统信息/角色；MySQL 直接挂 表/视图 */
                    const renderDbNode = (db: string, dbIndent: string) => {
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
                      _colIndent: string,
                    ) => {
                      const catKey = `${c.id}::${db2}::${schema}::${cat.kind}`;
                      const catOpen = openCats.has(catKey);
                      const objs = objsByCat[catKey];
                      // 表/视图/物化视图：单击即在中间区打开对象清单，树里不再展开具体对象名；
                      // 序列/函数无清单页，保留树内展开作为唯一入口
                      const isListKind = cat.kind === 'table' || cat.kind === 'view' || cat.kind === 'mview';
                      const expandable = !isListKind; // sequence | function
                      return (
                        <div key={catKey}>
                          <button
                            onClick={() => {
                              // 选中分类节点：按方言记录查询上下文（PG=库+模式 / MySQL=库 / Oracle=模式）
                              if (c.kind === 'postgres') setTreeQueryCtx({ connId: c.id, db: db2, schema });
                              else if (c.kind === 'mysql') setTreeQueryCtx({ connId: c.id, db: db2 });
                              else setTreeQueryCtx({ connId: c.id, schema: db2 });
                              if (expandable) void toggleCat(c.id, db2, schema, cat.kind);
                              else if (isListKind) openObjList(c.id, db2, schema, cat.kind as 'table' | 'view' | 'mview');
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setObjMenu({ connId: c.id, db: db2, schema, kind: cat.kind, x: e.clientX, y: e.clientY });
                            }}
                            className={`tree-row flex w-full items-center gap-1 py-1 text-left ${catIndent} ${catOpen ? 'bg-panel3' : ''}`}
                          >
                            {expandable ? <Chevron open={catOpen} /> : <span className="w-2 shrink-0" />}
                            <ObjIcon kind={cat.kind} />
                            <span className="truncate text-fg">{cat.label}</span>
                            {expandable && objs && <span className="ml-1 text-[10px] text-dim2">{objs.length}</span>}
                          </button>
                          {expandable && catOpen && (
                            <>
                              {loadingObjs === catKey && <div className={`py-0.5 text-[10px] text-dim2 ${itemIndent}`}>加载…</div>}
                              {objs?.length === 0 && loadingObjs !== catKey && <div className={`py-0.5 text-[10px] text-dim2 ${itemIndent}`}>（空）</div>}
                              {(objs ?? []).map((name) => {
                                const objTitle = cat.kind === 'sequence' ? '双击打开序列' : '双击打开函数定义';
                                return (
                                  <div key={name}>
                                    <div className={`tree-row flex w-full items-center gap-1 py-1 ${itemIndent}`}>
                                      <button
                                        onClick={() => {
                                          // 选中具体对象（序列/函数）：查询上下文跟随其所属 库/模式
                                          if (c.kind === 'postgres') setTreeQueryCtx({ connId: c.id, db: db2, schema });
                                          else if (c.kind === 'mysql') setTreeQueryCtx({ connId: c.id, db: db2 });
                                          else setTreeQueryCtx({ connId: c.id, schema: db2 });
                                        }}
                                        onDoubleClick={() => openObject(c.id, db2, schema, cat.kind, name)}
                                        onContextMenu={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          setObjMenu({ connId: c.id, db: db2, schema, kind: cat.kind, name, x: e.clientX, y: e.clientY });
                                        }}
                                        className="flex min-w-0 flex-1 items-center gap-1 text-left"
                                        title={objTitle}
                                      >
                                        <ObjIcon kind={cat.kind} />
                                        <span className="truncate text-dim">{name}</span>
                                      </button>
                                    </div>
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
                          onClick={() => {
                            // 选中库节点：同时选中其所属连接（工具栏连接/断开随之跟随），并记录查询上下文
                            select(c.id);
                            if (c.kind === 'oracle') setTreeQueryCtx({ connId: c.id, schema: db });
                            else setTreeQueryCtx({ connId: c.id, db });
                            void toggleDb(c.id, db);
                          }}
                          className={`tree-row flex w-full items-center gap-1 py-1 text-left ${dbIndent} ${dbOpen ? 'bg-panel3' : ''}`}
                        >
                          <Chevron open={dbOpen} />
                          <DbIcon />
                          <span className="truncate text-fg">{db}</span>
                        </button>
                        {dbOpen && (
                          <>
                            {/* PG：库 → 元数据分类（模式/事件触发器/扩展/存储/系统信息/角色，Navicat 风格） */}
                            {isPg && loadingSchemas === dbKey && <div className="py-0.5 pl-[3.25rem] text-[10px] text-dim2">连接该库并加载模式…</div>}
                            {isPg && dbErr[dbKey] && (
                              <div className="py-0.5 pl-[3.25rem] pr-2 text-[10px] text-prod" title={dbErr[dbKey]}>
                                内省失败：{dbErr[dbKey]}
                              </div>
                            )}
                            {isPg &&
                              PG_META_CATS.map((mc) => {
                                const mKey = `${c.id}::${db}::${mc.meta}`;
                                const mOpen = openMeta.has(mKey);
                                const items = mc.meta === 'schemas' ? schemas : metaByCat[mKey];
                                return (
                                  <div key={mc.meta}>
                                    <button
                                      onClick={() => void toggleMeta(c.id, db, mc.meta)}
                                      className={`tree-row flex w-full items-center gap-1 py-1 pl-[3.25rem] text-left ${mOpen ? 'bg-panel3' : ''}`}
                                    >
                                      <Chevron open={mOpen} />
                                      <FolderIcon className="shrink-0 text-[#e48e00]" />
                                      <span className="truncate text-fg">{mc.label}</span>
                                      {items && <span className="ml-1 text-[10px] text-dim2">{items.length}</span>}
                                    </button>
                                    {mOpen && mc.meta === 'schemas' && (
                                      <>
                                        {(schemas ?? []).map((schema) => {
                                          const sKey = `${dbKey}::${schema}`;
                                          const sOpen = openSchemas.has(sKey);
                                          return (
                                            <div key={schema}>
                                              <button
                                                onClick={() => {
                                                  // 选中 PG 模式节点：记录 库+模式 查询上下文
                                                  select(c.id);
                                                  setTreeQueryCtx({ connId: c.id, db, schema });
                                                  setOpenSchemas((s) => {
                                                    const n = new Set(s);
                                                    if (n.has(sKey)) n.delete(sKey);
                                                    else n.add(sKey);
                                                    return n;
                                                  });
                                                }}
                                                className={`tree-row flex w-full items-center gap-1 py-1 pl-[4.25rem] text-left ${sOpen ? 'bg-panel3' : ''}`}
                                              >
                                                <Chevron open={sOpen} />
                                                <SchemaIcon />
                                                <span className="truncate text-fg">{schema}</span>
                                              </button>
                                              {sOpen &&
                                                OBJ_KINDS.map((cat) => renderCat(db, schema, cat, 'pl-[5.25rem]', 'pl-[6.25rem]', 'pl-[7.25rem]'))}
                                            </div>
                                          );
                                        })}
                                      </>
                                    )}
                                    {mOpen && mc.meta !== 'schemas' && (
                                      <>
                                        {loadingMeta === mKey && <div className="py-0.5 pl-[4.25rem] text-[10px] text-dim2">加载…</div>}
                                        {items?.length === 0 && loadingMeta !== mKey && (
                                          <div className="py-0.5 pl-[4.25rem] text-[10px] text-dim2">（空）</div>
                                        )}
                                        {(items ?? []).map((n) => (
                                          <div key={n} className="flex w-full items-center gap-1.5 py-0.5 pl-[4.25rem] text-[11px] text-dim2" title={n}>
                                            <ColIcon />
                                            <span className="truncate text-fg">{n}</span>
                                          </div>
                                        ))}
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            {/* MySQL：无模式层，库下直接挂 表/视图 两类；Oracle：Schema 即库，挂 表/视图/物化视图/序列/函数 五类 */}
                            {!isPg && (c.kind === 'oracle' ? OBJ_KINDS : MYSQL_KINDS).map((cat) => renderCat(db, db, cat, 'pl-10', 'pl-[3.25rem]', 'pl-[4.25rem]'))}
                          </>
                        )}
                      </div>
                    );
                    };
                    return c.kind === 'postgres' ? (
                      /* PG：连接 → 「数据库」文件夹 → 库（Navicat 风格层级） */
                      <div>
                        <button
                          onClick={() => {
                            // 选中 PG「数据库」文件夹节点：上下文等同连接级（未指定具体库）
                            select(c.id);
                            setTreeQueryCtx({ connId: c.id });
                            setOpenDbFolder((s) => {
                              const n = new Set(s);
                              if (n.has(c.id)) n.delete(c.id);
                              else n.add(c.id);
                              return n;
                            });
                          }}
                          className={`tree-row flex w-full items-center gap-1 py-1 pl-5 text-left ${openDbFolder.has(c.id) ? 'bg-panel3' : ''}`}
                        >
                          <Chevron open={openDbFolder.has(c.id)} />
                          <FolderIcon className="shrink-0 text-[#e48e00]" />
                          <span className="truncate text-fg">数据库</span>
                          {dbs && <span className="ml-1 text-[10px] text-dim2">{dbs.length}</span>}
                        </button>
                        {openDbFolder.has(c.id) && (dbs ?? []).map((db) => renderDbNode(db, 'pl-9'))}
                      </div>
                    ) : (
                      /* MySQL：连接 → 库 → 表/视图 */
                      <>{(dbs ?? []).map((db) => renderDbNode(db, 'pl-7'))}</>
                    );
                  })()}
                  {/* —— SQL 脚本：连接级脚本库（查询页 Ctrl+S 保存；双击打开执行）—— */}
                  {c.kind !== 'redis' && (() => {
                    const scOpen = openScripts.has(c.id);
                    const list = scripts[c.id] ?? [];
                    return (
                      <div>
                        <button
                          onClick={() => {
                            setOpenScripts((s) => {
                              const n = new Set(s);
                              if (n.has(c.id)) n.delete(c.id);
                              else n.add(c.id);
                              return n;
                            });
                            if (!scOpen) loadScripts(c.id);
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setScriptFolderMenu({ connId: c.id, x: e.clientX, y: e.clientY });
                          }}
                          className={`tree-row flex w-full items-center gap-1 py-1 pl-5 text-left ${scOpen ? 'bg-panel3' : ''}`}
                          title="SQL 脚本：查询页 Ctrl+S 保存；双击脚本打开执行；右键打开脚本目录"
                        >
                          <Chevron open={scOpen} />
                          <FolderIcon className="shrink-0 text-[#e48e00]" />
                          <span className="truncate text-fg">脚本</span>
                          {list.length > 0 && <span className="ml-1 text-[10px] text-dim2">{list.length}</span>}
                        </button>
                        {scOpen &&
                          (list.length === 0 ? (
                            <div className="py-0.5 pl-10 text-[10px] text-dim2">暂无脚本（查询页 Ctrl+S 保存）</div>
                          ) : (
                            list.map((s) => (
                              <div
                                key={s.id}
                                onDoubleClick={() =>
                                  openDbTab({ id: `q:${c.id}:sc:${s.id}:${Date.now()}`, connId: c.id, type: 'query', title: s.name, sql: s.sql })
                                }
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setScriptMenu({ connId: c.id, id: s.id, name: s.name, sql: s.sql, x: e.clientX, y: e.clientY });
                                }}
                                className="tree-row flex w-full cursor-pointer items-center gap-1.5 py-1 pl-10 pr-2 text-left hover:bg-panel3"
                                title="双击打开到查询标签执行；右键更多操作"
                              >
                                <DocIcon />
                                <span className="truncate text-fg">{s.name}</span>
                              </div>
                            ))
                          ))}
                      </div>
                    );
                  })()}
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
      {/* 表/对象节点右键菜单（新建表/编辑/删除） */}
      {objMenu && (
        <ContextMenu
          x={objMenu.x}
          y={objMenu.y}
          items={objMenuItems(objMenu.connId, objMenu.db, objMenu.schema, objMenu.kind, objMenu.name)}
          onClose={() => setObjMenu(null)}
        />
      )}
      {/* 脚本右键菜单（打开执行 / 删除 / 在文件夹中显示） */}
      {scriptMenu && (
        <ContextMenu
          x={scriptMenu.x}
          y={scriptMenu.y}
          items={[
            {
              label: '打开执行',
              onClick: () =>
                openDbTab({
                  id: `q:${scriptMenu.connId}:sc:${scriptMenu.id}:${Date.now()}`,
                  connId: scriptMenu.connId,
                  type: 'query',
                  title: scriptMenu.name,
                  sql: scriptMenu.sql,
                }),
            },
            { label: '删除', onClick: () => removeScript(scriptMenu.connId, scriptMenu.id) },
            { label: '', separator: true },
            { label: '在文件夹中显示', onClick: () => void api.revealScript(scriptMenu.connId, scriptMenu.id) },
          ]}
          onClose={() => setScriptMenu(null)}
        />
      )}
      {/* 「脚本」文件夹节点右键菜单（打开脚本目录） */}
      {scriptFolderMenu && (
        <ContextMenu
          x={scriptFolderMenu.x}
          y={scriptFolderMenu.y}
          items={[
            { label: '在文件夹中打开', onClick: () => void api.openScriptsFolder(scriptFolderMenu.connId) },
          ]}
          onClose={() => setScriptFolderMenu(null)}
        />
      )}
      {/* 方言化「新建数据库」对话框（MySQL/PG 一套表单） */}
      {createDbState && (
        <DbCreateDialog
          connId={createDbState.connId}
          kind={createDbState.kind}
          onClose={() => setCreateDbState(null)}
          onCreated={() => {
            const id = createDbState.connId;
            setCreateDbState(null);
            void (async () => {
              try {
                const d = await api.listDatabases(id);
                setDbsByConn((m) => ({ ...m, [id]: d }));
                setOpenConns((s) => new Set(s).add(id));
                setOpenDbFolder((s) => new Set(s).add(id));
              } catch {
                /* ignore */
              }
            })();
          }}
        />
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

/** 脚本文件图标 */
function DocIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-[#7aa2f7]" fill="none" stroke="currentColor" strokeWidth={1.6} viewBox="0 0 16 16">
      <path d="M4 1.5h5.5L13 5v9.5H4z" strokeLinejoin="round" />
      <path d="M9.5 1.5V5H13" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 方言化「新建数据库」对话框（Navicat 风格）：
 * - MySQL：字符集 + 排序规则；
 * - PostgreSQL：属主 / 编码 / LC_COLLATE / LC_CTYPE / 模板 / 表空间 / 连接数上限；
 * - Oracle / Redis 暂不支持（菜单中不会触发本对话框）。
 */
function DbCreateDialog({
  connId,
  kind,
  onClose,
  onCreated,
}: {
  connId: string;
  kind: 'mysql' | 'postgres' | 'oracle';
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [opts, setOpts] = useState<DbCreateOptions | null>(null);
  const [loadingOpts, setLoadingOpts] = useState(true);
  // —— 公共 ——
  const [charset, setCharset] = useState('utf8mb4');
  const [collation, setCollation] = useState('');
  const [owner, setOwner] = useState('');
  const [encoding, setEncoding] = useState('UTF8');
  const [lcCollate, setLcCollate] = useState('');
  const [lcCtype, setLcCtype] = useState('');
  const [template, setTemplate] = useState('template1');
  const [tablespace, setTablespace] = useState('');
  const [connLimit, setConnLimit] = useState(-1);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadingOpts(true);
    api
      .dbCreateOptions(connId)
      .then((o) => {
        if (!alive) return;
        setOpts(o);
        if (o.kind === 'mysql') {
          const cs = o.charsets?.includes('utf8mb4') ? 'utf8mb4' : (o.charsets?.[0] ?? '');
          setCharset(cs);
        }
        setLoadingOpts(false);
      })
      .catch(() => alive && setLoadingOpts(false));
    return () => {
      alive = false;
    };
  }, [connId]);

  const nameOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim());
  const collationsForCharset = kind === 'mysql' ? (opts?.collations ?? []).filter((c) => c.charset === charset) : [];

  const submit = async () => {
    if (!nameOk || !name.trim()) {
      setErr('请填写合法的数据库名（字母/数字/下划线，以字母或下划线开头）');
      return;
    }
    setSubmitting(true);
    setErr(null);
    const spec: DbCreateSpec = { name: name.trim() };
    if (kind === 'mysql') {
      if (charset) spec.charset = charset;
      if (collation) spec.collation = collation;
    } else if (isOra) {
      if (tablespace) spec.tablespace = tablespace;
    } else {
      if (owner) spec.owner = owner;
      if (encoding) spec.encoding = encoding;
      if (lcCollate) spec.lcCollate = lcCollate;
      if (lcCtype) spec.lcCtype = lcCtype;
      if (template) spec.template = template;
      if (tablespace) spec.tablespace = tablespace;
      if (connLimit != null && Number.isFinite(connLimit)) spec.connectionLimit = connLimit;
    }
    try {
      await api.createDatabase(connId, spec);
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const isPg = kind === 'postgres';
  const isOra = kind === 'oracle';
  const fieldCls = 'w-full rounded-sm border border-line bg-bg px-1.5 py-1 text-[11px] text-fg outline-none focus:border-accent';
  const labelCls = 'text-[11px] text-dim';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div className="w-[420px] rounded-lg border border-line bg-panel2 p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold text-fg">
          <DbIcon />
          新建数据库
          <span className="ml-1 rounded bg-panel3 px-1.5 py-0.5 text-[10px] font-normal text-dim2">{isPg ? 'PostgreSQL' : isOra ? 'Oracle' : 'MySQL'}</span>
        </div>

        {loadingOpts && <div className="mb-3 text-[10px] text-dim2">加载服务器选项…</div>}

        <div className="grid grid-cols-[88px_1fr] items-center gap-x-2 gap-y-2.5">
          <span className={labelCls}>数据库名</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            placeholder="db_name"
            className={fieldCls}
          />

          {isPg ? (
            <>
              <span className={labelCls}>属主</span>
              <select value={owner} onChange={(e) => setOwner(e.target.value)} className={fieldCls}>
                <option value="">（默认当前角色）</option>
                {(opts?.owners ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>

              <span className={labelCls}>编码</span>
              <select value={encoding} onChange={(e) => setEncoding(e.target.value)} className={fieldCls}>
                {(opts?.encodings ?? ['UTF8']).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>

              <span className={labelCls}>排序规则 (C)</span>
              <select value={lcCollate} onChange={(e) => setLcCollate(e.target.value)} className={fieldCls}>
                <option value="">（服务器默认）</option>
                {(opts?.pgCollations ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>

              <span className={labelCls}>字符类型 (C)</span>
              <select value={lcCtype} onChange={(e) => setLcCtype(e.target.value)} className={fieldCls}>
                <option value="">（服务器默认）</option>
                {(opts?.pgCollations ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>

              <span className={labelCls}>模板</span>
              <select value={template} onChange={(e) => setTemplate(e.target.value)} className={fieldCls}>
                {(opts?.templates ?? ['template1']).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>

              <span className={labelCls}>表空间</span>
              <select value={tablespace} onChange={(e) => setTablespace(e.target.value)} className={fieldCls}>
                <option value="">（默认 pg_default）</option>
                {(opts?.tablespaces ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>

              <span className={labelCls}>连接数上限</span>
              <input
                type="number"
                value={connLimit}
                min={-1}
                onChange={(e) => setConnLimit(Number(e.target.value))}
                className={fieldCls}
                title="-1 表示不限"
              />
            </>
          ) : isOra ? (
            <>
              <span className={labelCls}>表空间</span>
              <select value={tablespace} onChange={(e) => setTablespace(e.target.value)} className={fieldCls}>
                <option value="">（默认 USERS）</option>
                {(opts?.tablespaces ?? []).map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </>
          ) : (
            <>
              <span className={labelCls}>字符集</span>
              <select
                value={charset}
                onChange={(e) => {
                  setCharset(e.target.value);
                  setCollation('');
                }}
                className={fieldCls}
              >
                {(opts?.charsets ?? ['utf8mb4']).map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>

              <span className={labelCls}>排序规则</span>
              <select value={collation} onChange={(e) => setCollation(e.target.value)} className={fieldCls}>
                <option value="">（默认跟随字符集）</option>
                {collationsForCharset.map((c) => (
                  <option key={c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
            </>
          )}
        </div>

        {!nameOk && name.trim() !== '' && (
          <div className="mt-2 text-[10px] text-prod">数据库名仅允许字母、数字、下划线，且以字母或下划线开头</div>
        )}
        {err && <div className="mt-2 text-[10px] text-prod">创建失败：{err}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="h-7 rounded border border-line px-3 text-[11px] text-dim hover:bg-panel3">
            取消
          </button>
          <button
            disabled={!nameOk || submitting}
            onClick={() => void submit()}
            className="h-7 rounded bg-accent px-3 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? '创建中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
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
/** 用户与权限管理节点图标（连接级「用户」入口） */
function UsersIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-[#36c2a6]" fill="none" stroke="currentColor" strokeWidth={1.7} viewBox="0 0 24 24">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 6.2a3 3 0 010 5.6M16.5 19c0-2.4 1.4-4.1 3.5-4.6" />
    </svg>
  );
}
/** 连接类型图标：按方言绘制官方风格标识 —— MySQL 蓝橙双色圆柱 / PostgreSQL 大象头 / Oracle 红环 / Redis 菱形堆，对标 Navicat 连接节点 */
export function ConnIcon({ kind }: { kind: ConnectionSummary['kind'] }) {
  if (kind === 'mysql') {
    return (
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24">
        <title>MySQL</title>
        {/* 官方双色：蓝 #00758F 主体 + 橙 #F29111 顶部 */}
        <path d="M4 5.5v13c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8v-13z" fill="#00758f" />
        <ellipse cx="12" cy="5.5" rx="8" ry="2.8" fill="#f29111" />
        <ellipse cx="12" cy="5.5" rx="4.6" ry="1.5" fill="#ffb35c" />
      </svg>
    );
  }
  if (kind === 'postgres') {
    return (
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24">
        <title>PostgreSQL</title>
        {/* 大象头正面：双耳 + 头 + 垂鼻 + 白眼，官方蓝灰 #336791 */}
        <ellipse cx="5.6" cy="10.8" rx="3.1" ry="3.9" fill="#336791" />
        <ellipse cx="18.4" cy="10.8" rx="3.1" ry="3.9" fill="#336791" />
        <circle cx="12" cy="10.8" r="6.2" fill="#336791" />
        <rect x="10.6" y="13.5" width="2.8" height="7.3" rx="1.4" fill="#336791" />
        <circle cx="9.7" cy="9.8" r=".95" fill="#fff" />
        <circle cx="14.3" cy="9.8" r=".95" fill="#fff" />
      </svg>
    );
  }
  if (kind === 'oracle') {
    return (
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24">
        <title>Oracle</title>
        {/* 官方 logo 即红色椭圆环 #F80000 */}
        <ellipse cx="12" cy="12" rx="9" ry="5.8" fill="none" stroke="#f80000" strokeWidth="3" />
      </svg>
    );
  }
  if (kind === 'redis') {
    return (
      <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24">
        <title>Redis</title>
        {/* 官方红色 #D82C20 三层菱形堆叠 */}
        <path d="M12 2.6 21 6.9 12 11.2 3 6.9Z" fill="#d82c20" />
        <path d="M3 10.6 12 14.9 21 10.6v2.3L12 17.2 3 12.9Z" fill="#a82318" />
        <path d="M3 15.2 12 19.5 21 15.2v2.3L12 21.8 3 17.5Z" fill="#d82c20" />
      </svg>
    );
  }
  // ssh / bastion / 未知：灰色终端样式兜底
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="#9aa3ad" strokeWidth="2">
      <title>{kind}</title>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5l3.5 3L7 15.5M12.5 15.5H17" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
