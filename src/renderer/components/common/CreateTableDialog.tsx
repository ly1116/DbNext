import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@renderer/api';
import type { DbColumnSpec, DbCreateOptions } from '@shared/types';

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
  const [columns, setColumns] = useState<DbColumnSpec[]>([{ name: '', fullType: 'varchar(255)', nullable: true }]);
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

  const addColumn = () => setColumns((c) => [...c, { name: '', fullType: 'varchar(255)', nullable: true }]);
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
      onCreated();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // 如果是编辑模式，加载现有表结构
  useEffect(() => {
    if (isEditing && preset?.editName) {
      let cancelled = false;
      api.listColumns(connectionId, schema ?? '', preset.editName, db).then((cols) => {
        if (!cancelled) {
          setColumns(cols.map((c) => ({
            name: c.name,
            fullType: c.dataType,
            nullable: c.nullable,
            defaultValue: c.defaultValue,
            comment: c.comment,
            autoIncrement: c.key === 'PRI' && c.dataType.includes('int'),
            identity: c.key === 'PRI' && c.dataType.includes('int') ? 'default' : undefined,
          })));
          setPkCols(cols.filter((c) => c.key === 'PRI').map((c) => c.name));
          setComment('');
        }
      });
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