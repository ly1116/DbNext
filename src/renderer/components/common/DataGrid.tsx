import { useMemo, useState } from 'react';
import type { QueryColumn, QueryResult } from '@shared/types';

/**
 * 通用数据网格（结果集表格）。
 *
 * 功能：
 * - 主键列显示钥匙图标
 * - NULL 值斜体灰显
 * - 数字右对齐
 * - 点击表头列排序（升/降切换）
 * - 表头 sticky 吸顶
 *
 * 设计为纯展示组件，输入 `QueryResult`，便于在 SQL 编辑器结果与独立数据网格屏复用。
 *
 * @since 0.1.0
 */
export function DataGrid({ result }: { result: QueryResult }) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [asc, setAsc] = useState(true);

  // 排序后的行
  const rows = useMemo(() => {
    if (!sortKey) return result.rows;
    const sorted = [...result.rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av! < bv! ? -1 : 1;
    });
    return asc ? sorted : sorted.reverse();
  }, [result.rows, sortKey, asc]);

  const onSort = (name: string) => {
    if (sortKey === name) setAsc((v) => !v);
    else {
      setSortKey(name);
      setAsc(true);
    }
  };

  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full text-[12px] mono">
        <thead className="sticky top-0 z-10 bg-panel2">
          <tr className="border-b border-line2 text-left text-dim">
            <th className="w-10 border-r border-line px-2 py-1.5 text-center font-normal">#</th>
            {result.columns.map((c) => (
              <ColumnHeader key={c.name} col={c} active={sortKey === c.name} asc={asc} onClick={() => onSort(c.name)} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="row-hover border-b border-line/50">
              <td className="border-r border-line/50 bg-panel2/30 px-2 py-1.5 text-center text-dim2">{i + 1}</td>
              {result.columns.map((c) => (
                <Cell key={c.name} value={row[c.name]} />
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={result.columns.length + 1} className="px-3 py-6 text-center text-dim2">
                无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 列头（可排序） */
function ColumnHeader({ col, active, asc, onClick }: { col: QueryColumn; active: boolean; asc: boolean; onClick: () => void }) {
  return (
    <th
      onClick={onClick}
      className="cursor-pointer select-none border-r border-line px-3 py-1.5 font-medium hover:text-fg"
    >
      {col.primaryKey && <span className="mr-1">🔑</span>}
      {col.name}
      {active && <span className="ml-1 text-dim2">{asc ? '▲' : '▼'}</span>}
    </th>
  );
}

/** 单元格（区分数字/空值） */
function Cell({ value }: { value: unknown }) {
  const isNum = typeof value === 'number';
  const isNull = value === null || value === undefined;
  return (
    <td
      className={`border-r border-line/50 px-3 py-1.5 ${isNum ? 'text-right text-num' : ''} ${
        isNull ? 'italic text-dim' : ''
      }`}
    >
      {isNull ? 'NULL' : String(value)}
    </td>
  );
}
