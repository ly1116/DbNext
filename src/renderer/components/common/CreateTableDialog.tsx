import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/api';
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
        (row.comment ?? '') !== (orig.comment ?? '');
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
        if (orig.autoIncrement) spec.autoIncrement = true;
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
            fullType: c.fullType ?? c.dataType,
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

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fade-in" onClick={onClose}>
      <div className="w-[720px] max-w-[95vw] max-h-[90vh] bg-panel rounded-lg shadow-xl border border-line overflow-hidden flex flex-col animate-slide-up" onClick={(e) => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line bg-panel2 px-4">
          <span className="text-sm font-medium text-fg">{isEditing ? `编辑${kind === 'table' ? '表' : kind}：` : `新建${kind === 'table' ? '表' : kind}：`} {name || '<表名>'}</span>
          <button onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-dim hover:bg-panel3 hover:text-fg" title="关闭">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        {/* 主体 */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* 基本信息 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-dim2 mb-1">表名 *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isEditing}
                className="w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent disabled:opacity-50"
                placeholder="输入表名"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[11px] text-dim2 mb-1">备注</label>
              <input
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="w-full rounded border border-line bg-bg px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
                placeholder="表注释"
              />
            </div>
          </div>

          {/* 字段列表 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-fg">字段定义</label>
              <button onClick={addColumn} className="flex items-center gap-1 text-xs text-accent hover:text-accent2">
                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                添加字段
              </button>
            </div>

            <div className="rounded border border-line bg-bg overflow-hidden">
              {/* 表头 */}
              <div className="grid grid-cols-[40px_1fr_140px_80px_100px_40px_40px] gap-2 px-3 py-2 text-[11px] font-medium text-dim2 bg-panel2 border-b border-line">
                <span>#</span>
                <span>字段名</span>
                <span>类型</span>
                <span>长度/精度</span>
                <span>允许空</span>
                <span>主键</span>
                <span>操作</span>
              </div>

              {/* 字段行 */}
              {columns.map((col, i) => (
                <div key={i} className="grid grid-cols-[40px_1fr_140px_80px_100px_40px_40px] gap-2 px-3 py-1.5 items-center border-b border-line/50 last:border-b-0">
                  <span className="text-dim2 text-[11px]">{i + 1}</span>
                  <input
                    value={col.name}
                    onChange={(e) => updateColumn(i, 'name', e.target.value)}
                    className="rounded border border-line bg-panel px-2 py-1 text-sm text-fg outline-none focus:border-accent"
                    placeholder="字段名"
                  />
                  <select
                    value={col.fullType.split('(')[0]}
                    onChange={(e) => updateColumn(i, 'fullType', e.target.value + (col.fullType.includes('(') ? '(' + col.fullType.split('(')[1] : ''))}
                    className="rounded border border-line bg-panel px-2 py-1 text-sm text-fg outline-none focus:border-accent"
                  >
                    {commonTypes.map((t) => (
                      <option key={t} value={t.split('(')[0]}>{t}</option>
                    ))}
                  </select>
                  <input
                    value={col.fullType.includes('(') ? col.fullType.split('(')[1].replace(')', '') : ''}
                    onChange={(e) => {
                      const base = col.fullType.split('(')[0];
                      updateColumn(i, 'fullType', e.target.value ? `${base}(${e.target.value})` : base);
                    }}
                    className="rounded border border-line bg-panel px-2 py-1 text-sm text-fg outline-none focus:border-accent text-center"
                    placeholder="长度"
                  />
                  <label className="flex items-center justify-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={col.nullable}
                      onChange={(e) => updateColumn(i, 'nullable', e.target.checked)}
                      className="h-4 w-4 accent-accent rounded border-line bg-bg"
                    />
                    <span className="text-[11px] text-dim2">NULL</span>
                  </label>
                  <label className="flex items-center justify-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pkCols.includes(col.name)}
                      onChange={() => togglePk(col.name)}
                      className="h-4 w-4 accent-accent rounded border-line bg-bg"
                    />
                    <span className="text-[11px] text-dim2">PK</span>
                  </label>
                  <button
                    onClick={() => removeColumn(i)}
                    disabled={columns.length === 1}
                    className="flex items-center justify-center text-dim hover:text-prod hover:bg-panel2 rounded"
                    title="删除字段"
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* 方言特有选项 */}
          {options && (
            <details className="border border-line rounded bg-panel2 p-3">
              <summary className="cursor-pointer text-sm font-medium text-fg">高级选项（{dialect}）</summary>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                {options.charsets?.length && (
                  <div>
                    <label className="block text-dim2 mb-1">字符集</label>
                    <select className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg outline-none focus:border-accent">
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
                    <label className="block text-dim2 mb-1">排序规则</label>
                    <select className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg outline-none focus:border-accent">
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
                    <label className="block text-dim2 mb-1">表空间</label>
                    <select className="w-full rounded border border-line bg-bg px-2 py-1.5 text-fg outline-none focus:border-accent">
                      <option value="">默认</option>
                      {(options.tablespaces as string[]).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                )}
              </div>
            </details>
          )}

          {error && <div className="text-sm text-prod p-2 rounded bg-prod/10 border border-prod/20">{error}</div>}
        </div>

        {/* 底部按钮 */}
        <div className="flex h-10 shrink-0 items-center justify-end gap-2 border-t border-line bg-panel2 px-4">
          <button onClick={onClose} disabled={loading} className="rounded border border-line px-3 py-1.5 text-sm text-fg hover:bg-panel3 disabled:opacity-50">取消</button>
          <button onClick={handleSubmit} disabled={loading} className="rounded bg-accent px-4 py-1.5 text-sm text-white hover:bg-accent2 disabled:opacity-50">
            {loading ? '创建中…' : isEditing ? '保存修改' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
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