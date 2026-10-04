import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/api';
import { shortTypeName } from '@renderer/utils/dbTypes';
import type { DbColumnSpec, DbColumnAlterSpec, DbCreateOptions } from '@shared/types';

/** 字段行（带稳定 uid：编辑模式按 uid 对齐原行做 diff，改名/删行都不会错位） */
type ColRow = DbColumnSpec & { uid: number };

interface CreateTableDialogProps {
  connectionId: string;
  /** 预置：db/schema/objectKind/editName */
  preset?: { db?: string; schema?: string; objectKind?: 'table' | 'view' | 'mview' | 'sequence' | 'function'; editName?: string };
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTableDialog({ connectionId, preset, onClose, onCreated }: CreateTableDialogProps) {
  const isEditing = !!preset?.editName;
  const kind = preset?.objectKind ?? 'table';
  const db = preset?.db;
  const schema = preset?.schema;
  const initialName = preset?.editName ?? '';

  const [name, setName] = useState(initialName);
  const uidRef = useRef(1);
  const [columns, setColumns] = useState<ColRow[]>([{ name: '', fullType: 'varchar(255)', nullable: true, uid: 0 }]);
  /** 编辑模式：加载时的原始行快照（按 uid 对齐）与原始表注释，保存时据此 diff */
  const [origRows, setOrigRows] = useState<ColRow[]>([]);
  const [origComment, setOrigComment] = useState('');
  const [comment, setComment] = useState('');
  const [pkCols, setPkCols] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<DbCreateOptions | null>(null);
  const [dialect, setDialect] = useState<'mysql' | 'postgres' | 'oracle'>('mysql');

  // 常用类型下拉（按方言区分）
  const [commonTypes] = useState(() => {
    const base = [
      'varchar(255)', 'char(36)', 'text', 'longtext',
      'int', 'bigint', 'smallint', 'tinyint',
      'decimal(10,2)', 'float', 'double',
      'date', 'datetime', 'timestamp', 'time',
      'boolean', 'json', 'uuid'
    ];
    return base;
  });
  // 加载连接方言和方言选项（字符集/排序规则/PG 表空间等）
  useEffect(() => {
    let cancelled = false;
    api.listConnections().then((conns) => {
      const conn = conns.find((c) => c.id === connectionId);
      if (conn && !cancelled) setDialect(conn.kind === 'postgres' ? 'postgres' : conn.kind === 'oracle' ? 'oracle' : 'mysql');
    });
    api.dbCreateOptions(connectionId).then((o) => {
      if (!cancelled) setOptions(o);
    });
    return () => { cancelled = true; };
  }, [connectionId]);

  const addColumn = () => setColumns((c) => [...c, { name: '', fullType: 'varchar(255)', nullable: true, uid: uidRef.current++ }]);
  const removeColumn = (i: number) => setColumns((c) => c.filter((_, idx) => idx !== i));
  const updateColumn = (i: number, field: keyof DbColumnSpec, value: string | boolean) =>
    setColumns((c) => c.map((col, idx) => (idx === i ? { ...col, [field]: value } : col)));

  const togglePk = (colName: string) =>
    setPkCols((p) => p.includes(colName) ? p.filter((n) => n !== colName) : [...p, colName]);

  const handleSubmit = async () => {
    if (!name.trim()) { setError('请输入表名'); return; }
    if (columns.some((c) => !c.name.trim())) { setError('所有字段必须填写名称'); return; }
    // MySQL 自增约束：必须为整数类型列且已设为主键（否则服务端建表报错）
    if (!isEditing && dialect === 'mysql') {
      for (const c of columns) {
        if (!c.autoIncrement) continue;
        const base = splitFullType(c.fullType).base.toLowerCase();
        if (!/^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(base)) {
          setError(`自增列「${c.name}」必须是整数类型（当前 ${base}）`);
          return;
        }
        if (!pkCols.includes(c.name.trim())) {
          setError(`自增列「${c.name}」必须设置为主键`);
          return;
        }
      }
    }
    setLoading(true);
    setError(null);
    try {
      if (isEditing) {
        await saveEdits();
      } else {
        let sql = '';
        if (dialect === 'mysql') {
          sql = buildMySQLCreateTable(name.trim(), columns, pkCols, comment);
        } else if (dialect === 'postgres') {
          sql = buildPGCreateTable(name.trim(), columns, pkCols, comment, schema);
        } else if (dialect === 'oracle') {
          sql = buildOracleCreateTable(name.trim(), columns, pkCols, comment);
        } else {
          throw new Error('不支持的方言: ' + dialect);
        }
        await api.runSql(connectionId, sql);
      }
      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  /**
   * 编辑模式保存：与加载时的快照做 diff，逐项提交真实的 DDL：
   * - 新增字段 → addColumn；删除字段 → dropColumn；修改字段 → alterColumn（仅变化项）；
   * - 主键变化 → 按方言 DROP/ADD PRIMARY KEY；
   * - 表注释变化 → 按方言 ALTER ... COMMENT / COMMENT ON TABLE。
   */
  const saveEdits = async () => {
    const table = name.trim();
    const origMap = new Map(origRows.map((r) => [r.uid, r]));
    const curUids = new Set(columns.map((c) => c.uid));

    // 1) 新增 / 修改字段
    for (const row of columns) {
      const orig = origMap.get(row.uid);
      if (!orig) {
        if (!row.name.trim()) continue;
        await api.addColumn(connectionId, schema, table, row, db);
        continue;
      }
      const spec: DbColumnAlterSpec = {};
      const changed =
        row.name.trim() !== orig.name ||
        row.fullType !== orig.fullType ||
        row.nullable !== orig.nullable ||
        (row.defaultValue ?? '') !== (orig.defaultValue ?? '') ||
        (row.comment ?? '') !== (orig.comment ?? '') ||
        (!!row.autoIncrement) !== (!!orig.autoIncrement);
      if (!changed) continue;
      if (row.name.trim() !== orig.name) spec.name = row.name.trim();
      if (row.fullType !== orig.fullType) spec.fullType = row.fullType;
      if (row.nullable !== orig.nullable) spec.nullable = row.nullable;
      if ((row.defaultValue ?? '') !== (orig.defaultValue ?? '')) spec.defaultValue = row.defaultValue ?? '';
      if ((row.comment ?? '') !== (orig.comment ?? '')) spec.comment = row.comment ?? '';
      if (dialect === 'mysql') {
        // MySQL MODIFY 是整列定义替换：必须带上完整定义（含未变化的默认值/注释），否则会被清掉
        spec.fullType = row.fullType;
        spec.nullable = row.nullable;
        spec.defaultValue = row.defaultValue ?? '';
        spec.comment = row.comment ?? '';
        spec.autoIncrement = row.autoIncrement === true;
      }
      await api.alterColumn(connectionId, schema, table, orig.name, spec, db);
    }

    // 2) 删除字段
    for (const orig of origRows) {
      if (!curUids.has(orig.uid)) await api.dropColumn(connectionId, schema, table, orig.name, db);
    }

    // 3) 主键变化 → DROP/ADD PRIMARY KEY（按方言）；重命名的主键列映射为新名
    const renames = new Map(origRows.filter((r) => curUids.has(r.uid)).map((r) => [r.name, columns.find((c) => c.uid === r.uid)?.name ?? r.name]));
    const before = [...origMap.values()].filter((r) => curUids.has(r.uid)).map((r) => r.name);
    const afterPk = pkCols.map((n) => renames.get(n) ?? n);
    const pkChanged = JSON.stringify([...before].sort()) !== JSON.stringify([...afterPk].sort());
    if (pkChanged) {
      for (const stmt of pkStatements(dialect, schema, table, afterPk, before.length > 0, afterPk.length > 0)) {
        await api.runSql(connectionId, stmt, db);
      }
    }

    // 4) 表注释变化
    if (comment !== origComment) {
      await api.runSql(connectionId, tableCommentStatement(dialect, schema, table, comment), db);
    }
  };

  // 如果是编辑模式，加载现有表结构（含表注释回填），并留存快照供保存时 diff
  useEffect(() => {
    if (isEditing && preset?.editName) {
      let cancelled = false;
      api.listColumns(connectionId, schema ?? '', preset.editName, db).then((cols) => {
        if (!cancelled) {
          const rows: ColRow[] = cols.map((c) => ({
            uid: uidRef.current++,
            name: c.name,
            fullType: shortTypeName(c.fullType ?? c.dataType),
            nullable: c.nullable,
            defaultValue: c.defaultValue,
            comment: c.comment,
            autoIncrement: c.key === 'PRI' && c.dataType.includes('int'),
            identity: c.key === 'PRI' && c.dataType.includes('int') ? 'default' : undefined,
          }));
          setColumns(rows);
          setOrigRows(rows);
          setPkCols(cols.filter((c) => c.key === 'PRI').map((c) => c.name));
        }
      });
      api
        .listObjectsMeta(connectionId, 'table', schema ?? '', db)
        .then((metas) => {
          if (!cancelled) {
            const c = metas.find((m) => m.name === preset?.editName)?.comment ?? '';
            setComment(c);
            setOrigComment(c);
          }
        })
        .catch(() => undefined);
      return () => { cancelled = true; };
    }
  }, [isEditing, preset?.editName, connectionId, schema, db]);

  /** 对话框内紧凑输入框（与数据网格编辑态一致的 h-7 尺寸） */
  const cellInputCls = 'h-7 w-full min-w-0 rounded border border-line bg-bg px-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-fg outline-none placeholder:text-dim2 focus:border-accent/60';

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fade-in" onClick={onClose}>
      <div className="flex max-h-[90vh] w-[860px] max-w-[95vw] flex-col overflow-hidden rounded-[10px] border border-line bg-panel shadow-xl animate-slide-up" onClick={(e) => e.stopPropagation()}>
        {/* 标题栏：竖条 + 标题 + 表名 pill（对齐应用卡头语言） */}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-accent2" />
          <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-fg">
            {isEditing ? '编辑表' : kind === 'table' ? '新建表' : `新建${kind}`}
          </span>
          <span className="max-w-[280px] shrink-0 truncate rounded-full border border-line2/70 bg-panel2 px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 text-dim">
            {name || '<未命名>'}
          </span>
          {schema && <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.714)] text-dim2">{schema}</span>}
          <button onClick={onClose} className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim hover:bg-panel3 hover:text-fg" title="关闭 (Esc)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 space-y-3 overflow-auto p-4">
          {/* 基本信息 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[length:calc(var(--pref-fs)*0.714)] text-dim2">表名 *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isEditing}
                className="ipt w-full disabled:opacity-50"
                placeholder="输入表名"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-[length:calc(var(--pref-fs)*0.714)] text-dim2">备注</label>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="ipt w-full"
                placeholder="表注释"
              />
            </div>
          </div>

          {/* 字段定义：网格同款表头 + 紧凑编辑行 */}
          <div className="overflow-hidden rounded-[10px] border border-line">
            <div className="flex h-9 items-center gap-2 border-b border-line bg-panel2 px-3">
              <span className="h-3 w-[3px] shrink-0 rounded-full bg-accent2" />
              <span className="shrink-0 text-[length:calc(var(--pref-fs)*0.786)] font-semibold text-fg">字段定义</span>
              <span className="shrink-0 rounded-full border border-line2/70 bg-panel px-2 text-[length:calc(var(--pref-fs)*0.714)] leading-4 tabular-nums text-dim">
                {columns.length} 列
              </span>
              <span className="min-w-0 flex-1 truncate text-[length:calc(var(--pref-fs)*0.714)] text-dim2">默认值为裸表达式：0 / '文本' / CURRENT_TIMESTAMP</span>
              <button onClick={addColumn} className="flex shrink-0 items-center gap-1 text-[length:calc(var(--pref-fs)*0.714)] text-accent hover:underline">
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                添加字段
              </button>
            </div>
            <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '36px' }} />
                <col />
                <col style={{ width: '156px' }} />
                <col style={{ width: '72px' }} />
                <col style={{ width: '140px' }} />
                <col style={{ width: '56px' }} />
                <col style={{ width: '48px' }} />
                <col style={{ width: '48px' }} />
                <col style={{ width: '40px' }} />
              </colgroup>
              {/* 表头：数据网格同款（panel2 + 2px 下边线） */}
              <thead>
                <tr className="bg-panel2 text-dim2">
                  <th className="border-b-2 border-line px-1 py-1.5 text-right font-normal">#</th>
                  <th className="border-b-2 border-line px-2 py-1.5 text-left font-medium text-fg">字段名</th>
                  <th className="border-b-2 border-line px-2 py-1.5 text-left font-medium text-fg">类型</th>
                  <th className="border-b-2 border-line px-2 py-1.5 text-left font-medium text-fg">长度</th>
                  <th className="border-b-2 border-line px-2 py-1.5 text-left font-medium text-fg">默认值</th>
                  <th className="border-b-2 border-line px-1 py-1.5 text-center font-medium text-fg">允许空</th>
                  <th className="border-b-2 border-line px-1 py-1.5 text-center font-medium text-fg">主键</th>
                  <th className="border-b-2 border-line px-1 py-1.5 text-center font-medium text-fg">自增</th>
                  <th className="border-b-2 border-line px-1 py-1.5 text-center font-medium text-fg">操作</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((col, i) => {
                  const base = splitFullType(col.fullType).base;
                  const hasArgs = TYPES_WITH_ARGS.has(base);
                  return (
                    <tr key={col.uid} className="hover:bg-panel2/40">
                      <td className="border-b border-line px-1 py-1 text-right text-dim2 tabular-nums">{i + 1}</td>
                      <td className="border-b border-line px-2 py-1">
                        <input
                          value={col.name}
                          onChange={(e) => updateColumn(i, 'name', e.target.value)}
                          className={cellInputCls}
                          placeholder="字段名"
                        />
                      </td>
                      <td className="border-b border-line px-2 py-1">
                        <select
                          value={base}
                          onChange={(e) => updateColumn(i, 'fullType', defaultFullType(e.target.value))}
                          className={cellInputCls}
                          title={col.fullType}
                        >
                          {/* 当前 fullType 与该基类型的默认参数不同（如 varchar(50)）时，首项动态显示真实类型，避免 select 永远显示默认文案 */}
                          {col.fullType !== defaultFullType(base) && <option value={base}>{col.fullType}</option>}
                          {commonTypes.map((t) => (
                            <option key={t} value={t.split('(')[0]}>{t}</option>
                          ))}
                        </select>
                      </td>
                      <td className="border-b border-line px-2 py-1">
                        <input
                          value={splitFullType(col.fullType).args}
                          onChange={(e) => {
                            const { base: b } = splitFullType(col.fullType);
                            updateColumn(i, 'fullType', e.target.value.trim() ? `${b}(${e.target.value.trim()})` : b);
                          }}
                          disabled={!hasArgs}
                          className={`${cellInputCls} text-center disabled:opacity-40`}
                          placeholder={hasArgs ? (['decimal', 'numeric'].includes(base) ? '精度,标度' : '长度') : '—'}
                        />
                      </td>
                      <td className="border-b border-line px-2 py-1">
                        <input
                          value={col.defaultValue ?? ''}
                          onChange={(e) => updateColumn(i, 'defaultValue', e.target.value)}
                          className={cellInputCls}
                          placeholder="0 / '文本' / …"
                          title="DEFAULT 表达式：字符串需自带引号，如 0、'abc'、CURRENT_TIMESTAMP"
                        />
                      </td>
                      <td className="border-b border-line px-1 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={col.nullable}
                          onChange={(e) => updateColumn(i, 'nullable', e.target.checked)}
                          className="h-3.5 w-3.5 cursor-pointer accent-accent"
                          title="允许 NULL"
                        />
                      </td>
                      <td className="border-b border-line px-1 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={pkCols.includes(col.name)}
                          onChange={() => togglePk(col.name)}
                          className="h-3.5 w-3.5 cursor-pointer accent-accent"
                          title="主键"
                        />
                      </td>
                      <td className="border-b border-line px-1 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={!!col.autoIncrement}
                          disabled={dialect !== 'mysql'}
                          onChange={(e) => updateColumn(i, 'autoIncrement', e.target.checked)}
                          className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:opacity-40"
                          title={dialect === 'mysql' ? 'AUTO_INCREMENT（需为主键的整数列）' : '仅 MySQL 支持自增；PG 可用 serial/identity 类型'}
                        />
                      </td>
                      <td className="border-b border-line px-1 py-1 text-center">
                        <button
                          onClick={() => removeColumn(i)}
                          disabled={columns.length === 1}
                          className="inline-flex h-5 w-5 items-center justify-center rounded text-prod/80 hover:bg-prod/10 hover:text-prod disabled:opacity-30 disabled:hover:bg-transparent"
                          title="删除字段"
                        >
                          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 方言特有选项 */}
          {options && (
            <details className="rounded-[10px] border border-line bg-panel2/40 p-3">
              <summary className="cursor-pointer text-[length:calc(var(--pref-fs)*0.786)] font-medium text-fg">高级选项（{dialect}）</summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {options.charsets?.length && (
                  <div>
                    <label className="mb-1 block text-[length:calc(var(--pref-fs)*0.714)] text-dim2">字符集</label>
                    <select className="ipt w-full">
                      <option value="">默认</option>
                      {options.charsets.map((c: unknown) => {
                        const cs = c as { name: string } | string;
                        const val = typeof cs === 'string' ? cs : cs.name;
                        return <option key={val} value={val}>{val}</option>;
                      })}
                    </select>
                  </div>
                )}
                {options.collations?.length && (
                  <div>
                    <label className="mb-1 block text-[length:calc(var(--pref-fs)*0.714)] text-dim2">排序规则</label>
                    <select className="ipt w-full">
                      <option value="">默认</option>
                      {options.collations.map((c: unknown) => {
                        const cl = c as { name: string } | string;
                        const val = typeof cl === 'string' ? cl : cl.name;
                        return <option key={val} value={val}>{val}</option>;
                      })}
                    </select>
                  </div>
                )}
                {options.tablespaces?.length && (
                  <div>
                    <label className="mb-1 block text-[length:calc(var(--pref-fs)*0.714)] text-dim2">表空间</label>
                    <select className="ipt w-full">
                      <option value="">默认</option>
                      {(options.tablespaces as string[]).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </details>
          )}

          {error && <div className="rounded border border-prod/20 bg-prod/10 p-2 text-[length:calc(var(--pref-fs)*0.786)] text-prod">{error}</div>}
        </div>

        {/* 底部按钮 */}
        <div className="flex h-11 shrink-0 items-center justify-end gap-2 border-t border-line bg-panel2/50 px-4">
          <button onClick={onClose} disabled={loading} className="h-7 rounded border border-line px-3 text-[length:calc(var(--pref-fs)*0.786)] text-fg hover:bg-panel3 disabled:opacity-50">取消</button>
          <button onClick={handleSubmit} disabled={loading} className="btn-primary h-7 px-4 text-[length:calc(var(--pref-fs)*0.786)]">
            {loading ? '创建中…' : isEditing ? '保存修改' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}

// —— 类型参数规则：切换基类型时重置括号参数，避免把 varchar(255) 的 255 拼到 decimal 上 ——
/** 允许带括号参数的基类型（decimal/numeric 参数为「精度,标度」） */
const TYPES_WITH_ARGS = new Set(['varchar', 'char', 'decimal', 'numeric', 'float', 'double']);
/** 基类型切换时的默认 fullType（不在表内的基类型一律不带参数） */
const TYPE_DEFAULT_ARGS: Record<string, string> = { varchar: 'varchar(255)', char: 'char(36)', decimal: 'decimal(10,2)', numeric: 'numeric(10,2)' };

/** 由基类型得到切换后的默认 fullType */
function defaultFullType(base: string): string {
  return TYPE_DEFAULT_ARGS[base] ?? base;
}

/** 从 fullType 拆出基类型与括号内参数（无参数返回 ''） */
function splitFullType(fullType: string): { base: string; args: string } {
  const i = fullType.indexOf('(');
  if (i < 0) return { base: fullType, args: '' };
  return { base: fullType.slice(0, i), args: fullType.slice(i + 1, -1) };
}

// —— 方言化建表 SQL 生成 ——
function buildMySQLCreateTable(name: string, cols: DbColumnSpec[], pkCols: string[], comment: string): string {
  const colDefs = cols.map((c) => {
    let def = `\`${c.name}\` ${c.fullType}`;
    if (!c.nullable) def += ' NOT NULL';
    if (c.defaultValue !== undefined && c.defaultValue !== '') def += ` DEFAULT ${c.defaultValue}`;
    if (c.autoIncrement) def += ' AUTO_INCREMENT';
    if (c.comment) def += ` COMMENT '${c.comment.replace(/'/g, "\\'")}'`;
    return def;
  });
  if (pkCols.length > 0) {
    colDefs.push(`PRIMARY KEY (${pkCols.map((n) => `\`${n}\``).join(', ')})`);
  }
  let sql = `CREATE TABLE \`${name}\` (\n  ${colDefs.join(',\n  ')}\n)`;
  if (comment) sql += ` COMMENT='${comment.replace(/'/g, "\\'")}'`;
  sql += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;';
  return sql;
}

function buildPGCreateTable(name: string, cols: DbColumnSpec[], pkCols: string[], comment: string, schema?: string): string {
  const prefix = schema ? `"${schema}".` : '';
  const colDefs = cols.map((c) => {
    let def = `"${c.name}" ${c.fullType}`;
    if (!c.nullable) def += ' NOT NULL';
    if (c.defaultValue !== undefined && c.defaultValue !== '') def += ` DEFAULT ${c.defaultValue}`;
    if (c.identity) def += c.identity === 'always' ? ' GENERATED ALWAYS AS IDENTITY' : ' GENERATED BY DEFAULT AS IDENTITY';
    return def;
  });
  if (pkCols.length > 0) {
    colDefs.push(`PRIMARY KEY (${pkCols.map((n) => `"${n}"`).join(', ')})`);
  }
  let sql = `CREATE TABLE ${prefix}"${name}" (\n  ${colDefs.join(',\n  ')}\n);`;
  if (comment) sql += ` COMMENT ON TABLE ${prefix}"${name}" IS '${comment.replace(/'/g, "\\'")}';`;
  return sql;
}

function buildOracleCreateTable(name: string, cols: DbColumnSpec[], pkCols: string[], comment: string): string {
  const colDefs = cols.map((c) => {
    let def = `"${c.name}" ${c.fullType}`;
    if (!c.nullable) def += ' NOT NULL';
    if (c.defaultValue !== undefined && c.defaultValue !== '') def += ` DEFAULT ${c.defaultValue}`;
    return def;
  });
  if (pkCols.length > 0) {
    colDefs.push(`CONSTRAINT "${name}_PK" PRIMARY KEY (${pkCols.map((n) => `"${n}"`).join(', ')})`);
  }
  let sql = `CREATE TABLE "${name}" (\n  ${colDefs.join(',\n  ')}\n);`;
  if (comment) sql += ` COMMENT ON TABLE "${name}" IS '${comment.replace(/'/g, "\\'")}';`;
  return sql;
}

// —— 编辑模式辅助：主键 / 表注释的方言化 DDL ——

/** MySQL 单引号转义（与建表生成保持一致） */
const escMy = (s: string) => s.replace(/'/g, "\\'");

/** 限定表名（编辑模式 DDL 用）：MySQL 库前缀反引号；PG 模式前缀双引号；Oracle 双引号 */
function qualifiedName(dialect: string, schema: string | undefined, table: string): string {
  if (dialect === 'mysql') return `\`${table.replace(/`/g, '``')}\``;
  const t = `"${table.replace(/"/g, '""')}"`;
  if (dialect === 'postgres' && schema) return `"${schema.replace(/"/g, '""')}".${t}`;
  return t;
}

/** 主键列清单片段 */
function pkList(dialect: string, cols: string[]): string {
  const q = (n: string) => (dialect === 'mysql' ? `\`${n.replace(/`/g, '``')}\`` : `"${n.replace(/"/g, '""')}"`);
  return cols.map(q).join(', ');
}

/** 主键变化时的 DDL 语句序列（hasPkBefore/hasPkAfter 决定 DROP/ADD） */
function pkStatements(dialect: string, schema: string | undefined, table: string, pkCols: string[], hasPkBefore: boolean, hasPkAfter: boolean): string[] {
  const t = qualifiedName(dialect, schema, table);
  const stmts: string[] = [];
  if (hasPkBefore && !hasPkAfter) {
    stmts.push(dialect === 'postgres' ? `ALTER TABLE ${t} DROP CONSTRAINT "${table}_pkey";` : `ALTER TABLE ${t} DROP PRIMARY KEY;`);
  } else if (hasPkBefore && hasPkAfter) {
    if (dialect === 'mysql') stmts.push(`ALTER TABLE ${t} DROP PRIMARY KEY, ADD PRIMARY KEY (${pkList(dialect, pkCols)});`);
    else if (dialect === 'postgres') stmts.push(`ALTER TABLE ${t} DROP CONSTRAINT "${table}_pkey", ADD CONSTRAINT "${table}_pkey" PRIMARY KEY (${pkList(dialect, pkCols)});`);
    else { stmts.push(`ALTER TABLE ${t} DROP PRIMARY KEY;`); stmts.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${pkList(dialect, pkCols)});`); }
  } else if (!hasPkBefore && hasPkAfter) {
    stmts.push(dialect === 'postgres' ? `ALTER TABLE ${t} ADD CONSTRAINT "${table}_pkey" PRIMARY KEY (${pkList(dialect, pkCols)});` : `ALTER TABLE ${t} ADD PRIMARY KEY (${pkList(dialect, pkCols)});`);
  }
  return stmts;
}

/** 表注释更新语句（按方言） */
function tableCommentStatement(dialect: string, schema: string | undefined, table: string, comment: string): string {
  if (dialect === 'mysql') return `ALTER TABLE ${qualifiedName(dialect, schema, table)} COMMENT='${escMy(comment)}';`;
  return `COMMENT ON TABLE ${qualifiedName(dialect, schema, table)} IS '${comment.replace(/'/g, "''")}';`;
}