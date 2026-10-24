import { useEffect, useRef, useState } from "react";
import { Icon } from "@renderer/components/common/icons";
import { api } from "@renderer/api";
import { PageHeaderCard } from "@renderer/components/common/PageHeaderCard";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { useConnections } from "@renderer/store/connectionStore";
import { ErrorBox } from "@renderer/components/common/States";
import { promptDialog } from "@renderer/components/common/PromptDialog";
import { RoutineStudio } from "@renderer/components/workbench/RoutineStudio";
import { errMsg } from "@renderer/utils/errMsg";
import type { DbSequenceInfo } from "@shared/types";

export function DefTab({ connId, kind, pgDb, schema, name }: { connId: string; kind: 'view' | 'mview' | 'function' | 'procedure'; pgDb?: string; schema: string; name: string }) {
  // 单击树上「函数/存储过程」分类打开的浏览器（name 为空 = 清单模式：左清单 + 右选中定义）
  if (!name && (kind === 'function' || kind === 'procedure')) {
    return <RoutineBrowserTab connId={connId} kind={kind} pgDb={pgDb} schema={schema} />;
  }
  return <RoutineStudio connId={connId} pgDb={pgDb} schema={schema} name={name} kind={kind} />;
}

/** ══════ 函数/存储过程 浏览器：左清单 + 右选中对象的 RoutineStudio（对齐序列浏览器双栏布局） ══════ */
function RoutineBrowserTab({ connId, kind, pgDb, schema }: { connId: string; kind: 'function' | 'procedure'; pgDb?: string; schema: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState('');
  const [kw, setKw] = useState('');
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const dialectLabel = conn?.kind === 'oracle' ? 'Oracle' : conn?.kind === 'mysql' ? 'MySQL' : 'PostgreSQL';
  const label = kind === 'function' ? '函数' : '存储过程';

  /** 拉取本 schema 全部函数/存储过程名 */
  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const ns = await api.listObjects(connId, kind, schema, pgDb);
      setNames(ns);
      setSel((s) => (ns.includes(s) ? s : ns[0] ?? ''));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, kind, schema, pgDb]);

  const k = kw.trim().toLowerCase();
  const filtered = names.filter((n) => !k || n.toLowerCase().includes(k));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">
      {/* ══ 页头卡：与用户/对象清单页统一 PageHeaderCard ══ */}
      <PageHeaderCard
        icon={
          kind === 'function' ? (
            <Icon name="code" className="h-[18px] w-[18px]"  />
          ) : (
            <Icon name="bolt" className="h-[18px] w-[18px]"  />
          )
        }
        title={label}
        subtitle={
          <>
            <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium leading-[18px] text-secondary-foreground">{dialectLabel}</span>
            <span className="truncate font-mono">{schema}</span>
            {!loading && !error && <span className="truncate">{filtered.length}{k ? ` / ${names.length}` : ''} 个{label}</span>}
          </>
        }
        search={{ value: kw, onChange: setKw, placeholder: `筛选${label}名…` }}
        actions={
          <Button variant="outline" size="sm" onClick={() => void loadAll()} disabled={loading} title={`重新读取${label}列表`}>
            <Icon name="refresh-4" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}  />
            刷新
          </Button>
        }
      />

      {/* 双栏：左清单 + 右选中定义 */}
      <div className="flex min-h-0 flex-1 gap-2.5 overflow-hidden">
        {/* 左：清单 */}
        <div className="flex w-[260px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="min-h-0 flex-1 overflow-auto">
            {error ? (
              <ErrorBox message={error} onRetry={() => void loadAll()} />
            ) : loading ? (
              <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载{label}列表…</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
                {names.length === 0 ? `该 schema 下没有${label}` : '无匹配项'}
              </div>
            ) : (
              <table className="w-full table-fixed border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-muted text-left text-[length:calc(var(--pref-fs)*0.714)] tracking-wide text-muted-foreground">
                    <th className="border-b border-border px-3 py-1.5 font-medium">名称</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((n) => {
                    const on = n === sel;
                    return (
                      <tr
                        key={n}
                        onClick={() => setSel(n)}
                        className={`cursor-pointer border-b border-border transition-colors ${on ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-secondary'}`}
                      >
                        <td className="truncate px-3 py-1.5 font-mono text-foreground" title={n}>
                          {n}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* 右：选中对象的定义编辑器（RoutineStudio 内嵌，选中切换时重挂载） */}
        {sel ? (
          <RoutineStudio key={sel} connId={connId} pgDb={pgDb} schema={schema} name={sel} kind={kind} embedded />
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center rounded-lg border border-border bg-card text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground shadow-sm">
            请选择左侧{label}
          </div>
        )}
      </div>
    </div>
  );
}

/** ══════ 新建序列弹窗：名称 + 起始/步长/最小/最大/循环，未填项取库默认，按方言拼 CREATE SEQUENCE ══════ */
function CreateSeqDialog({
  schema,
  isPg,
  busy,
  onClose,
  onSubmit,
}: {
  schema: string;
  isPg: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, sql: string) => void;
}) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('1');
  const [inc, setInc] = useState('1');
  const [minv, setMinv] = useState('');
  const [maxv, setMaxv] = useState('');
  const [cycle, setCycle] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  /** 仅接受非负整数；空串返回 '' */
  const num = (s: string) => (/^\d+$/.test(s.trim()) ? s.trim() : '');

  const buildSql = (): string => {
    const seq = schema ? `${schema}.${name.trim()}` : name.trim();
    const parts = [`CREATE SEQUENCE ${seq}`];
    const st = num(start);
    if (st && st !== '1') parts.push(isPg ? `START ${st}` : `START WITH ${st}`);
    const ic = num(inc);
    if (ic && ic !== '1') parts.push(isPg ? `INCREMENT ${ic}` : `INCREMENT BY ${ic}`);
    const mn = num(minv);
    if (mn) parts.push(`MINVALUE ${mn}`);
    const mx = num(maxv);
    if (mx) parts.push(`MAXVALUE ${mx}`);
    if (cycle) parts.push('CYCLE');
    return parts.join(' ');
  };
  const sql = name.trim() ? buildSql() : '';

  const rows: [string, string, string, (v: string) => void][] = [
    ['起始值', start, '默认 1', setStart],
    ['步长', inc, '默认 1', setInc],
    ['最小值', minv, '库默认', setMinv],
    ['最大值', maxv, '库默认', setMaxv],
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        className="w-[400px] overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3.5">
          <div className="text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-foreground">新建序列</div>
          <div className="mt-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
            <span className="font-mono">{schema}</span> · 未填写的选项取数据库默认值
          </div>
        </div>
        <div className="space-y-2 px-4 pt-3">
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-right text-[12px] text-muted-foreground">名称</span>
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
                if (e.key === 'Enter' && name.trim() && !busy) onSubmit(name.trim(), sql);
              }}
              placeholder="序列名"
              spellCheck={false}
              className="h-7 flex-1 text-[12px]"
            />
          </div>
          {rows.map(([label, val, ph, set]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-right text-[12px] text-muted-foreground">{label}</span>
              <Input
                value={val}
                onChange={(e) => set(e.target.value)}
                placeholder={ph}
                spellCheck={false}
                className="h-7 flex-1 text-[12px]"
              />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0" />
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[12px] text-muted-foreground">
              <input
                type="checkbox"
                checked={cycle}
                onChange={(e) => setCycle(e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
              />
              循环（取值耗尽后回到最小值）
            </label>
          </div>
          {sql && (
            <div className="rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-[length:calc(var(--pref-fs)*0.714)] leading-relaxed text-muted-foreground" title="将执行的 SQL">
              {sql}
            </div>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button variant="outline" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" className="disabled:opacity-40" disabled={!name.trim() || busy} onClick={() => onSubmit(name.trim(), sql)}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 序列标签页（序列浏览器：当前值/上下限/步长 + 下一个值） */
export function SequenceTab({ connId, pgDb, schema, name }: { connId: string; pgDb?: string; schema: string; name: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [infos, setInfos] = useState<Record<string, DbSequenceInfo>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string>(name);
  const [kw, setKw] = useState('');
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 新建序列弹窗开关 */
  const [createOpen, setCreateOpen] = useState(false);
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const isMysql = conn?.kind === 'mysql';
  const isPg = conn?.kind === 'postgres';
  const dialectLabel = conn?.kind === 'oracle' ? 'Oracle' : conn?.kind === 'mysql' ? 'MySQL' : 'PostgreSQL';

  /** 拉取本 schema 全部序列名 + 逐个详情（序列数量通常很少，并行预取） */
  const loadAll = async () => {
    setLoading(true);
    setError(null);
    setMsg(null);
    try {
      const ns = await api.listObjects(connId, 'sequence', schema, pgDb);
      setNames(ns);
      const got: Record<string, DbSequenceInfo> = {};
      await Promise.all(
        ns.map(async (n) => {
          try {
            got[n] = await api.getSequenceInfo(connId, schema, n, pgDb);
          } catch {
            /* 单个序列读取失败不影响其余展示 */
          }
        }),
      );
      setInfos(got);
      if (!ns.includes(sel) && ns.length) setSel(ns[0]);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, schema, pgDb]);

  const k = kw.trim().toLowerCase();
  const filtered = names.filter((n) => !k || n.toLowerCase().includes(k));
  const info = infos[sel] ?? null;

  /** 预测的下一个值（当前值 + 步长；从未调用则用最小值兜底） */
  const predictNext = (): string => {
    if (!info) return '—';
    const base = info.currentValue ?? info.minValue ?? 0;
    const step = info.increment ?? 1;
    return String(base + step);
  };

  /** 取下一个值（PG：nextval；Oracle：.NEXTVAL），并刷新该序列详情 */
  const takeNext = async () => {
    if (!info || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const seq = schema ? `${schema}.${sel}` : sel;
      const sql = isPg ? `SELECT nextval('${seq.replace(/'/g, "''")}') AS v` : `SELECT ${seq}.NEXTVAL AS v FROM dual`;
      const r = await api.runSql(connId, sql, pgDb || undefined);
      const v = r.rows[0]?.v;
      const refreshed = await api.getSequenceInfo(connId, schema, sel, pgDb);
      setInfos((m) => ({ ...m, [sel]: refreshed }));
      setMsg({ text: `下一个值：${v}` });
    } catch (e) {
      setMsg({ text: `获取失败：${errMsg(e)}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  /** 设置当前值（PG：setval；Oracle：ALTER SEQUENCE ... RESTART START WITH） */
  const setCurrent = async () => {
    if (!info || busy) return;
    const input = await promptDialog({
      title: `设置 ${sel} 的当前值：`,
      value: String(info.currentValue ?? info.minValue ?? 0),
      placeholder: '整数',
    });
    if (input == null) return;
    const v = Number(input);
    if (!Number.isFinite(v)) {
      setMsg({ text: '请输入有效数字', err: true });
      return;
    }
    setBusy(true);
    try {
      const seq = schema ? `${schema}.${sel}` : sel;
      const sql = isPg
        ? `SELECT setval('${seq.replace(/'/g, "''")}', ${v})`
        : `ALTER SEQUENCE ${seq} RESTART START WITH ${v}`;
      await api.runSql(connId, sql, pgDb || undefined);
      const refreshed = await api.getSequenceInfo(connId, schema, sel, pgDb);
      setInfos((m) => ({ ...m, [sel]: refreshed }));
      setMsg({ text: `已将当前值设为 ${v}` });
    } catch (e) {
      setMsg({ text: `设置失败：${errMsg(e)}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!info || busy) return;
    const nn = await promptDialog({ title: '重命名序列为：', value: sel, placeholder: '新序列名' });
    if (nn == null || !nn || nn === sel) return;
    setBusy(true);
    try {
      await api.renameObject(connId, 'sequence', schema, sel, nn, pgDb);
      setNames((ns) => ns.map((x) => (x === sel ? nn : x)));
      setSel(nn);
      setMsg({ text: `已重命名为 ${nn}` });
    } catch (e) {
      setMsg({ text: `重命名失败：${errMsg(e)}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  const drop = async () => {
    if (!info || busy) return;
    if (!window.confirm(`确认删除序列 ${schema ? schema + '.' : ''}${sel}？此操作不可撤销。`)) return;
    setBusy(true);
    try {
      await api.dropObject(connId, 'sequence', schema, sel, pgDb);
      const ns = names.filter((x) => x !== sel);
      setNames(ns);
      setSel(ns[0] ?? '');
      setMsg({ text: `已删除 ${sel}` });
    } catch (e) {
      setMsg({ text: `删除失败：${errMsg(e)}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  /** 执行 CREATE SEQUENCE（SQL 由弹窗按方言拼好）；失败保留弹窗便于修正 */
  const submitCreate = async (nn: string, sql: string) => {
    setBusy(true);
    try {
      await api.runSql(connId, sql, pgDb || undefined);
      setMsg({ text: `已创建 ${nn}` });
      setCreateOpen(false);
      await loadAll();
      setSel(nn);
    } catch (e) {
      setMsg({ text: `创建失败：${errMsg(e)}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  if (isMysql) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-foreground">MySQL 不支持序列对象</div>
        <div className="text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">MySQL 使用 AUTO_INCREMENT 自增列替代序列，请在表结构中查看自增列。</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">
      {/* ══ 页头卡：与用户/函数浏览器统一 PageHeaderCard ══ */}
      <PageHeaderCard
        icon={
          <Icon name="list" className="h-[18px] w-[18px]" strokeWidth={1.8} />
        }
        title="序列"
        subtitle={
          <>
            <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-secondary px-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-medium leading-[18px] text-secondary-foreground">{dialectLabel}</span>
            <span className="truncate font-mono">{schema}</span>
            {!loading && !error && <span className="truncate">{filtered.length}{k ? ` / ${names.length}` : ''} 个序列</span>}
          </>
        }
        search={{ value: kw, onChange: setKw, placeholder: '筛选序列名…' }}
        actions={
          <>
            {msg && <span className={`shrink-0 text-[length:calc(var(--pref-fs)*0.786)] ${msg.err ? 'text-destructive' : 'text-success'}`}>{msg.text}</span>}
            <Button variant="outline" size="sm" onClick={() => void loadAll()} disabled={loading} title="重新读取序列列表">
              <Icon name="refresh-4" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}  />
              刷新
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)} disabled={busy} title="新建序列">
              <Icon name="plus-2" className="h-3.5 w-3.5" strokeWidth={2.5} />
              新建序列
            </Button>
          </>
        }
      />

      {/* 双栏：左序列清单 + 右选中详情 */}
      <div className="flex min-h-0 flex-1 gap-2.5 overflow-hidden">
        {/* 左：序列清单 */}
        <div className="flex min-w-0 flex-[1.6] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="min-h-0 flex-1 overflow-auto">
            {error ? (
              <ErrorBox message={error} onRetry={() => void loadAll()} />
            ) : loading ? (
              <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载序列列表…</div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
                {names.length === 0 ? '该 schema 下没有序列' : '无匹配序列'}
              </div>
            ) : (
              <table className="w-full table-fixed border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
                <colgroup>
                  <col className="w-[42%]" />
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead className="sticky top-0 z-10">
                  <tr className="bg-muted text-left text-[length:calc(var(--pref-fs)*0.714)] tracking-wide text-muted-foreground">
                    <th className="border-b border-border px-3 py-1.5 font-medium">序列名</th>
                    <th className="border-b border-border px-3 py-1.5 text-right font-medium">当前值</th>
                    <th className="border-b border-border px-3 py-1.5 text-right font-medium">步长</th>
                    <th className="border-b border-border px-3 py-1.5 text-center font-medium">循环</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((n) => {
                    const si = infos[n];
                    const on = n === sel;
                    return (
                      <tr
                        key={n}
                        onClick={() => setSel(n)}
                        className={`cursor-pointer border-b border-border transition-colors ${on ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-secondary'}`}
                      >
                        <td className="truncate px-3 py-1.5 font-mono text-foreground">{n}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-foreground">{si ? (si.currentValue == null ? '—' : si.currentValue) : ''}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{si ? (si.increment ?? '—') : ''}</td>
                        <td className="px-3 py-1.5 text-center text-muted-foreground">{si ? (si.cycle ? '是' : '否') : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* 右：选中序列详情 */}
        <div className="flex min-w-[320px] max-w-[460px] flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          {!info ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
              {sel ? '读取序列信息失败' : '请选择左侧序列'}
            </div>
          ) : (
            <>
              <div className="shrink-0 border-b border-border px-4 py-3">
                <div className="truncate font-mono text-[length:calc(var(--pref-fs)*0.929)] font-semibold text-foreground">{sel}</div>
                <div className="mt-0.5 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{schema}</div>
                <div className="mt-2.5 flex items-baseline gap-2 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">
                  下一个值
                  <b className="font-mono text-[20px] font-semibold leading-none tabular-nums text-foreground">{predictNext()}</b>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                <div className="mb-1.5 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">属性</div>
                <table className="w-full border-collapse text-[length:calc(var(--pref-fs)*0.786)]">
                  <tbody>
                    {[
                      ['当前值', info.currentValue == null ? '（尚未调用）' : String(info.currentValue)],
                      ['最小值', info.minValue == null ? '—' : String(info.minValue)],
                      ['最大值', info.maxValue == null ? '—' : String(info.maxValue)],
                      ['步长（增量）', info.increment == null ? '—' : String(info.increment)],
                      ['循环', info.cycle ? '是' : '否'],
                    ].map(([k2, v2]) => (
                      <tr key={k2} className="border-b border-border last:border-b-0">
                        <td className="w-[45%] py-1.5 text-muted-foreground">{k2}</td>
                        <td className="py-1.5 font-mono tabular-nums text-foreground">{v2}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex shrink-0 items-center gap-1 border-t border-border bg-muted px-3 py-2">
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[length:calc(var(--pref-fs)*0.714)]" onClick={() => void takeNext()} disabled={busy} title="推进序列并取回下一个值">
                  取下一个值
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[length:calc(var(--pref-fs)*0.714)]" onClick={() => void setCurrent()} disabled={busy}>
                  设置当前值…
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[length:calc(var(--pref-fs)*0.714)]" onClick={() => void rename()} disabled={busy}>
                  重命名
                </Button>
                <Button variant="ghost" size="sm" className="ml-auto h-6 px-1.5 text-[length:calc(var(--pref-fs)*0.714)] hover:text-destructive" onClick={() => void drop()} disabled={busy}>
                  删除
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 新建序列弹窗 */}
      {createOpen && (
        <CreateSeqDialog
          schema={schema}
          isPg={isPg}
          busy={busy}
          onClose={() => setCreateOpen(false)}
          onSubmit={(n, sql) => void submitCreate(n, sql)}
        />
      )}
    </div>
  );
}
