import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, IconBox, StatusIcon } from "@renderer/components/common/icons";
import { api } from "@renderer/api";
import { Button } from "@renderer/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell } from "@renderer/components/ui/table";
import { cn } from "@renderer/lib/utils";
import { useConnections } from "@renderer/store/connectionStore";
import { ErrorBox } from "@renderer/components/common/States";
import { errMsg } from "@renderer/utils/errMsg";
import type { DbUser, DbUserPrivEdit, DbUserPrivilege, DbUserSpec } from "@shared/types";

/** 朴素首字母头像（shadcn 风格：纯色底 + 首字母；内置账号用虚线描边区分） */
function UserAvatar({ name, builtin, size = 26 }: { name: string; builtin?: boolean; size?: number }) {
  const style: React.CSSProperties = builtin
    ? { background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))', border: '1px dashed hsl(var(--border))' }
    : { background: 'hsl(var(--secondary))', color: 'hsl(var(--secondary-foreground))' };
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      style={{ width: size, height: size, ...style }}
      title={builtin ? '数据库内置保留账号' : name}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** 列表布尔格：褒义 ✓（绿圆底）/ 灰破折号 */
function UFlag({ v }: { v?: boolean }) {
  if (v === undefined) return <span className="text-muted-foreground">?</span>;
  if (!v) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-success/15 text-success">
      <Icon name="check-2" className="h-2.5 w-2.5" strokeWidth={3} />
    </span>
  );
}

/** 状态胶囊（锁定=warn 锁图标 / 过期=prod 警叹号，文字明示坏状态） */
function StatePill({ tone, children }: { tone: 'warn' | 'prod'; children: React.ReactNode }) {
  return (
    <span className={`inline-flex h-[19px] items-center gap-1 rounded-full px-2 text-[length:calc(var(--pref-fs)*0.643)] font-medium ${tone === 'warn' ? 'bg-warn/15 text-warning' : 'bg-destructive/15 text-destructive'}`}>
      <StatusIcon className="h-2.5 w-2.5 shrink-0" tone={tone} />
      {children}
    </span>
  );
}

/** 拨杆开关（账户属性编辑；tone 决定打开态颜色：正常=ok / 锁定=warn / 过期=prod） */
function Switch({ on, onChange, tone = 'ok', disabled }: { on: boolean; onChange: (v: boolean) => void; tone?: 'ok' | 'warn' | 'prod'; disabled?: boolean }) {
  const onBg = tone === 'ok' ? 'hsl(var(--success))' : tone === 'warn' ? 'hsl(var(--warning))' : 'hsl(var(--destructive))';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={on ? '点击关闭' : '点击打开'}
      className="relative h-[17px] w-[30px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: on ? onBg : 'hsl(var(--input))' }}
    >
      <span
        className="absolute left-[2px] top-[2px] h-[13px] w-[13px] rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: on ? 'translateX(13px)' : 'translateX(0)' }}
      />
    </button>
  );
}

/** 权限芯片（产品级权限矩阵控件）：未选=细边框静默 / 已选=主色实底+对勾，一眼扫出差异 */
function PrivChip({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[12px] font-medium transition-colors ${
        on
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <span
        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${
          on ? 'border-white/50 bg-white/20' : 'border-current opacity-60'
        }`}
      >
        {on && <Icon name="check-2" className="h-2.5 w-2.5" strokeWidth={3} />}
      </span>
      {label}
    </button>
  );
}

/** 用户与权限管理标签页（PG 角色 / MySQL 用户 / Oracle 用户：列表 + 权限查看 + 新建/删除） */
export function UsersTab({ connId }: { connId: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connId));
  const dialect = conn?.kind ?? 'postgres';
  const isMysql = dialect === 'mysql';
  const isOra = dialect === 'oracle';
  const isPg = dialect === 'postgres';
  const [users, setUsers] = useState<DbUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<DbUser | null>(null);
  const [privs, setPrivs] = useState<DbUserPrivilege[]>([]);
  const [privLoading, setPrivLoading] = useState(false);
  const [privError, setPrivError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [kw, setKw] = useState('');

  /** 账户搜索（用户名 / 主机，均不区分大小写） */
  const shown = useMemo(() => {
    const k = kw.trim().toLowerCase();
    if (!k) return users;
    return users.filter((u) => u.name.toLowerCase().includes(k) || (u.host ?? '').toLowerCase().includes(k));
  }, [users, kw]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await api.listUsers(connId));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const viewPrivs = async (u: DbUser) => {
    setSelected(u);
    setPrivLoading(true);
    setPrivError(null);
    try {
      setPrivs(await api.getUserPrivileges(connId, u.name, u.host));
    } catch (e) {
      setPrivError(errMsg(e));
      setPrivs([]);
    } finally {
      setPrivLoading(false);
    }
  };

  const del = async (u: DbUser) => {
    if (u.builtin) {
      window.alert(`「${u.name}」是数据库内置保留账号，由服务器管理，不能删除。`);
      return;
    }
    const label = u.host ? `'${u.name}'@'${u.host}'` : u.name;
    if (!window.confirm(`确认删除用户 ${label}？该操作不可撤销${isOra ? '（DROP USER ... CASCADE 会一并清理其对象）' : ''}。`)) return;
    try {
      await api.dropUser(connId, u.name, u.host);
      await load();
      if (selected?.name === u.name) setSelected(null);
    } catch (e) {
      window.alert(`删除失败：${errMsg(e)}`);
    }
  };

  const builtinCount = users.filter((u) => u.builtin).length;
  const superCount = users.filter((u) => u.superuser).length;
  const dialectLabel = isOra ? 'Oracle' : isMysql ? 'MySQL' : 'PostgreSQL';

  /** 行唯一键（MySQL 同名不同主机是不同账号） */
  const ukey = (u: DbUser) => `${u.name}@${u.host ?? ''}`;
  /** 复选框多选（批量删除；内置保留账号自动跳过） */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  /** 排序：默认用户名升序，点击表头切换升降序 */
  const [sort, setSort] = useState<{ key: 'name' | 'host'; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const toggleSort = (key: 'name' | 'host') =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  /** 排序后的可见行（搜索过滤 shown + 名称/主机字典序） */
  const filtered = useMemo(
    () =>
      [...shown].sort((a, b) => {
        const mul = sort.dir === 'asc' ? 1 : -1;
        return (sort.key === 'host' ? (a.host ?? '').localeCompare(b.host ?? '') : a.name.localeCompare(b.name)) * mul;
      }),
    [shown, sort],
  );

  /** 当前可见行的勾选状态：全选 / 部分选（不确定态） */
  const checkedVisible = filtered.filter((u) => checked.has(ukey(u))).length;
  const allChecked = filtered.length > 0 && checkedVisible === filtered.length;
  const someChecked = checkedVisible > 0 && !allChecked;
  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) filtered.forEach((u) => next.delete(ukey(u)));
      else filtered.forEach((u) => next.add(ukey(u)));
      return next;
    });
  const toggleOne = (u: DbUser) =>
    setChecked((prev) => {
      const next = new Set(prev);
      const k = ukey(u);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /** 批量删除勾选账户（内置保留账号跳过；逐个删，失败继续并汇报） */
  const batchDelete = async () => {
    const targets = users.filter((u) => checked.has(ukey(u)) && !u.builtin);
    if (!targets.length) return;
    if (!window.confirm(`确认删除选中的 ${targets.length} 个账户？该操作不可撤销。`)) return;
    const failed: string[] = [];
    for (const u of targets) {
      try {
        await api.dropUser(connId, u.name, u.host);
      } catch {
        failed.push(u.name);
      }
    }
    setChecked(new Set());
    if (selected && targets.some((u) => ukey(u) === ukey(selected))) setSelected(null);
    await load();
    if (failed.length) window.alert(`${failed.length} 个账户删除失败：${failed.join('、')}`);
  };

  /** 可排序表头（用户名/主机）：与对象清单同款 ↑/↓/↕ 指示，无列宽拖拽（列宽按百分比） */
  const sortTh = (key: 'name' | 'host', label: string, width?: string) => (
    <TableHead
      className="h-9 cursor-pointer border-b border-border bg-muted py-0 text-left"
      style={width ? { width } : undefined}
      onClick={() => toggleSort(key)}
      title="点击排序"
    >
      <span className="flex items-center gap-1 truncate">
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-normal text-muted-foreground">{sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
      </span>
    </TableHead>
  );

  /** 单元格基础样式：36px 行高 + 行间细横线，无列间竖线（与对象清单一致） */
  const cell = 'h-9 border-b border-border/60 py-0';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden p-2.5">
      <div className="flex min-h-0 flex-1 gap-2.5">
        {/* ══ 左：账户清单（单卡片三段式：页头 / 表格 / 状态栏，与对象清单页一致） ══ */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
          {/* ① 页头：32px 图标片 + 标题/元信息 + 搜索 + 操作 */}
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
              <Icon name="user" className="h-[18px] w-[18px]" strokeWidth={1.9} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[length:calc(var(--pref-fs)*0.875)] font-semibold leading-tight text-foreground">用户与权限管理</div>
              <div className="truncate font-mono text-[length:calc(var(--pref-fs)*0.75)] text-muted-foreground">
                {dialectLabel}
                {error ? '' : ` · ${users.length} 个账户 · ${superCount} 个超级用户 · ${builtinCount} 个内置保留账号`}
              </div>
            </div>
            <div className="relative flex h-[30px] w-60 shrink-0 items-center">
              <Icon name="search" className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                value={kw}
                onChange={(e) => setKw(e.target.value)}
                placeholder="搜索用户名 / 主机…"
                spellCheck={false}
                className="h-full w-full rounded-md border border-input bg-background pl-8 pr-3 text-[length:calc(var(--pref-fs)*0.786)] text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
              {kw && (
                <button onClick={() => setKw('')} className="absolute right-2 text-muted-foreground transition-colors hover:text-foreground" title="清空搜索">
                  <Icon name="close" className="h-3 w-3" />
                </button>
              )}
            </div>
            {checked.size > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-[30px] shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10"
                title={`删除选中的 ${checked.size} 个账户（内置保留账号自动跳过）`}
                onClick={() => void batchDelete()}
              >
                <Icon name="trash" className="h-3.5 w-3.5" />
                删除
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-[30px] shrink-0" onClick={() => void load()} disabled={loading} title="重新读取账户列表">
              <Icon name="refresh-4" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.8} />
              刷新
            </Button>
            <Button size="sm" className="h-[30px] shrink-0" onClick={() => setShowCreate(true)}>
              <Icon name="plus-2" className="h-3.5 w-3.5" strokeWidth={2.5} />
              新建用户
            </Button>
          </div>

          {/* ② 表格：shadcn Table 自带滚动容器承载 sticky 表头（外层禁止再套 overflow-auto） */}
          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]">
            {error ? (
              <ErrorBox message={error} onRetry={() => void load()} />
            ) : loading ? (
              <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">加载用户…</div>
            ) : users.length === 0 ? (
              <div className="p-3 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground">（无用户）</div>
            ) : (
              <Table className="table-fixed text-[length:calc(var(--pref-fs)*0.786)]">
                <colgroup>
                  <col style={{ width: '4%' }} />
                  <col style={{ width: isMysql ? '22%' : '30%' }} />
                  {isMysql && <col style={{ width: '12%' }} />}
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '11%' }} />
                  <col />
                </colgroup>
                <TableHeader className="sticky top-0 z-10">
                  <TableRow className="bg-muted text-[length:calc(var(--pref-fs)*0.75)] font-semibold text-muted-foreground hover:bg-muted">
                    <TableHead className={cn(cell, 'w-10 bg-muted p-0 text-center')}>
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => { if (el) el.indeterminate = someChecked; }}
                        onChange={toggleAll}
                        disabled={!filtered.length}
                        className="h-3.5 w-3.5 align-middle accent-primary"
                        title="全选 / 取消全选（当前筛选结果）"
                        aria-label="全选"
                      />
                    </TableHead>
                    {sortTh('name', '用户名')}
                    {isMysql && sortTh('host', '主机')}
                    <TableHead className={cn(cell, 'bg-muted px-2 text-center')}>可登录</TableHead>
                    <TableHead className={cn(cell, 'bg-muted px-2 text-center')}>超级用户</TableHead>
                    <TableHead className={cn(cell, 'bg-muted px-2 text-center')}>锁定</TableHead>
                    <TableHead className={cn(cell, 'bg-muted px-2 text-center')}>口令过期</TableHead>
                    <TableHead className={cn(cell, 'bg-muted px-3.5 text-right')}>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((u) => {
                    const on = selected?.name === u.name && selected?.host === u.host;
                    return (
                      <TableRow
                        key={ukey(u)}
                        data-state={on ? 'selected' : undefined}
                        className={cn('cursor-pointer hover:bg-muted', on && 'bg-primary/10 hover:bg-primary/15')}
                        title="点击行查看并编辑权限"
                        onClick={() => void viewPrivs(u)}
                      >
                        <TableCell className={cn(cell, 'p-0 text-center')} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={checked.has(ukey(u))}
                            onChange={() => toggleOne(u)}
                            className="h-3.5 w-3.5 align-middle accent-primary"
                            aria-label={`选择 ${u.name}`}
                          />
                        </TableCell>
                        <TableCell className={cn(cell, 'font-medium text-foreground')}>
                          <span className="flex min-w-0 items-center gap-2">
                            <UserAvatar name={u.name} builtin={u.builtin} size={22} />
                            <span className="truncate font-mono" title={u.name}>{u.name}</span>
                            {u.builtin && (
                              <span className="shrink-0 rounded border border-border/70 bg-muted px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-muted-foreground" title="数据库内置保留账号，由服务器管理，不可编辑或删除">内置</span>
                            )}
                            {u.superuser && (
                              <span className="shrink-0 rounded border border-border/70 bg-muted px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-muted-foreground">超管</span>
                            )}
                          </span>
                        </TableCell>
                        {isMysql && <TableCell className={cn(cell, 'truncate font-mono text-muted-foreground')}>{u.host}</TableCell>}
                        <TableCell className={cn(cell, 'px-2 text-center')}><UFlag v={u.canLogin} /></TableCell>
                        <TableCell className={cn(cell, 'px-2 text-center')}>
                          {u.superuser
                            ? <span className="rounded bg-secondary px-1.5 text-[length:calc(var(--pref-fs)*0.643)] font-medium leading-4 text-foreground">特权</span>
                            : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className={cn(cell, 'px-2 text-center')}>{u.locked ? <StatePill tone="warn">已锁定</StatePill> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className={cn(cell, 'px-2 text-center')}>{u.expired ? <StatePill tone="prod">已过期</StatePill> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className={cn(cell, 'px-3.5 text-right')}>
                          <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                            <button
                              tabIndex={-1}
                              onClick={(e) => { e.stopPropagation(); void viewPrivs(u); }}
                              title={`查看 ${u.name} 的权限`}
                              className="flex h-[22px] items-center gap-1 rounded-md border border-border px-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                              <Icon name="shield" className="h-2.5 w-2.5"  />
                              权限
                            </button>
                            <button
                              tabIndex={-1}
                              onClick={(e) => { e.stopPropagation(); void del(u); }}
                              disabled={u.builtin}
                              title={u.builtin ? '内置保留账号不可删除' : `删除 ${u.name}`}
                              className="flex h-[22px] items-center gap-1 rounded-md border border-border px-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground transition-colors hover:border-prod/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <Icon name="lock" className="h-2.5 w-2.5"  />
                              删除
                            </button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!loading && filtered.length === 0 && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={isMysql ? 8 : 7} className="h-24 text-center text-muted-foreground">
                        无匹配「{kw.trim()}」的账户
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </div>

          {/* ③ 底部状态栏：汇总统计（左）+ 就绪/筛选/已选（右） */}
          <div className="flex h-7 shrink-0 items-center justify-between border-t border-border bg-muted px-4 font-mono text-[length:calc(var(--pref-fs)*0.6875)] text-muted-foreground">
            <span className="truncate">
              {error ? '' : `共 ${users.length} 个账户 · ${superCount} 个超级用户 · ${builtinCount} 个内置保留账号`}
            </span>
            <span className="shrink-0">
              {checked.size ? `已选 ${checked.size} 个` : kw.trim() ? `筛选 ${filtered.length} / ${users.length}` : '点击行查看并编辑权限'}
            </span>
          </div>
        </div>

        {/* 右：权限面板卡 */}
        {selected && (
          <aside className="flex w-[38%] min-w-[340px] max-w-[500px] shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3">
              <UserAvatar name={selected.name} builtin={selected.builtin} size={34} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">{selected.name}</span>
                  {selected.builtin && (
                    <span className="shrink-0 rounded border border-border/70 bg-muted px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-muted-foreground">内置</span>
                  )}
                  {selected.superuser && (
                    <span className="shrink-0 rounded bg-secondary px-1 text-[length:calc(var(--pref-fs)*0.643)] font-medium leading-4 text-foreground">超级用户</span>
                  )}
                </div>
                <div className="mt-0.5 truncate font-mono text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
                  {selected.host ? `${selected.name}@${selected.host}` : selected.name} · {dialectLabel}{isPg ? ' 角色' : ' 用户'}{selected.canLogin ? ' · 可登录' : ''}
                </div>
              </div>
              <button
                onClick={() => void viewPrivs(selected)}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="刷新权限"
              >
                <Icon name="refresh-4" className="h-3 w-3"  />
              </button>
              <button
                onClick={() => setSelected(null)}
                className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="关闭权限面板"
              >
                <Icon name="close-3" className="h-3 w-3"  />
              </button>
            </div>
            {privError ? (
              <div className="p-3.5 text-[length:calc(var(--pref-fs)*0.714)] text-destructive">
                {privError}
                <button onClick={() => void viewPrivs(selected)} className="ml-2 text-primary hover:underline">重试</button>
              </div>
            ) : privLoading ? (
              <div className="p-3.5 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">加载权限…</div>
            ) : (
              <PrivEditor
                connId={connId}
                kind={dialect}
                user={selected}
                privs={privs}
                users={users}
                onApplied={() => { void viewPrivs(selected); void load(); }}
              />
            )}
          </aside>
        )}
      </div>
      {showCreate && conn && (
        <CreateUserDialog connId={connId} kind={dialect} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); void load(); }} />
      )}
    </div>
  );
}

/** MySQL 常用全局权限清单（权限编辑勾选） */
const MYSQL_GLOBAL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT', 'TRIGGER'];
/** Oracle 常用系统权限（权限编辑勾选） */
const ORA_SYS_PRIVS = ['CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE', 'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE USER', 'ALTER USER', 'DROP USER', 'UNLIMITED TABLESPACE'];
/** Oracle 常用预定义角色 */
const ORA_ROLES = ['CONNECT', 'RESOURCE', 'DBA'];

/**
 * 权限编辑器（右栏卡内容 + 底部执行条，对齐设计稿）：
 * - PG：角色属性拨杆（ALTER ROLE）+ 成员角色增删（GRANT/REVOKE role）；
 * - MySQL：账户锁定/口令过期拨杆（ALTER USER ACCOUNT LOCK / PASSWORD EXPIRE）
 *   + 全局权限（ON *.*）勾选差量 + WITH GRANT OPTION；
 * - Oracle：系统权限/预定义角色勾选差量（GRANT/REVOKE ... TO/FROM user）。
 * 未提交改动数展示在底部执行条；「回滚」还原快照，「提交改动」差量执行。
 */
function PrivEditor({ connId, kind, user, privs, users, onApplied }: {
  connId: string;
  kind: string;
  user: DbUser;
  privs: DbUserPrivilege[];
  users: DbUser[];
  onApplied: () => void;
}) {
  const isPg = kind === 'postgres';
  const isMysql = kind === 'mysql';
  const isOra = kind === 'oracle';

  // —— PG 编辑状态（pgAttrs0 为进入时快照，用于差量） ——
  const [pgAttrs, setPgAttrs] = useState<Record<string, boolean>>({});
  const pgAttrs0 = useRef<Record<string, boolean>>({});
  const [pgMembers, setPgMembers] = useState<string[]>([]);
  const [pgGrant, setPgGrant] = useState<string[]>([]);
  const [pgRevoke, setPgRevoke] = useState<string[]>([]);
  const [pgRoleSel, setPgRoleSel] = useState('');
  // —— MySQL 账户属性（锁定/过期拨杆，快照取自账户列表） ——
  const [myAttrs, setMyAttrs] = useState<Record<string, boolean>>({});
  const myAttrs0 = useRef<Record<string, boolean>>({});
  // —— MySQL / Oracle 勾选状态 ——
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const checks0 = useRef<Record<string, boolean>>({});
  const [grantOption, setGrantOption] = useState(false);
  const grantOption0 = useRef(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 选中用户 / 权限刷新后，从当前授权初始化编辑状态
  useEffect(() => {
    setMsg(null);
    setPgGrant([]);
    setPgRevoke([]);
    setPgRoleSel('');
    if (isPg) {
      const a: Record<string, boolean> = { login: false, superuser: false, createDb: false, createRole: false, replication: false, inherit: true };
      const members: string[] = [];
      for (const p of privs) {
        if (p.target === 'ROLE') {
          members.push(p.privilege);
          continue;
        }
        switch (p.privilege) {
          case 'LOGIN': a.login = true; break;
          case 'SUPERUSER': a.superuser = true; break;
          case 'CREATEDB': a.createDb = true; break;
          case 'CREATEROLE': a.createRole = true; break;
          case 'REPLICATION': a.replication = true; break;
          case 'NOINHERIT': a.inherit = false; break;
        }
      }
      setPgAttrs(a);
      pgAttrs0.current = { ...a };
      setPgMembers(members);
      return;
    }
    const ma: Record<string, boolean> = { locked: !!user.locked, expired: !!user.expired };
    setMyAttrs(ma);
    myAttrs0.current = { ...ma };
    const list = isMysql ? MYSQL_GLOBAL_PRIVS : [...ORA_SYS_PRIVS, ...ORA_ROLES];
    const s: Record<string, boolean> = {};
    for (const p of list) s[p] = false;
    let go = false;
    for (const p of privs) {
      if (isMysql) {
        if (/WITH GRANT OPTION/i.test(p.raw ?? '')) go = true;
        // 仅解析全局授权（ON *.*）：GRANT priv[, priv] ON *.* TO ...
        if (/ON\s+\*\.\*/i.test(p.raw ?? '')) {
          const m = (p.raw ?? '').match(/^GRANT\s+(.+?)\s+ON\s/i);
          if (m) {
            for (const part of m[1].split(',')) {
              const name = part.trim().toUpperCase();
              if (!name || name === 'USAGE') continue;
              if (name === 'ALL PRIVILEGES' || name === 'ALL') for (const k of list) s[k] = true;
              else if (name in s) s[name] = true;
            }
          }
        }
      } else if (p.privilege in s) {
        s[p.privilege] = true;
      }
    }
    setChecks(s);
    checks0.current = { ...s };
    setGrantOption(go);
    grantOption0.current = go;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.name, user.host, user.locked, user.expired, privs]);

  const apply = async () => {
    const edit: DbUserPrivEdit = {};
    if (isPg) {
      const attrs: NonNullable<DbUserPrivEdit['attrs']> = {};
      for (const k of Object.keys(pgAttrs)) {
        if (pgAttrs[k] !== pgAttrs0.current[k]) (attrs as Record<string, boolean>)[k] = pgAttrs[k];
      }
      if (Object.keys(attrs).length) edit.attrs = attrs;
      if (pgGrant.length) edit.grantRoles = pgGrant;
      if (pgRevoke.length) edit.revokeRoles = pgRevoke;
      if (!edit.attrs && !edit.grantRoles && !edit.revokeRoles) {
        setMsg({ ok: false, text: '没有修改' });
        return;
      }
    } else {
      const grant: string[] = [];
      const revoke: string[] = [];
      // MySQL：账户属性差量（锁定/过期 → ALTER USER）
      if (isMysql) {
        const attrs: NonNullable<DbUserPrivEdit['attrs']> = {};
        for (const k of ['locked', 'expired'] as const) {
          if (myAttrs[k] !== myAttrs0.current[k]) (attrs as Record<string, boolean>)[k] = myAttrs[k];
        }
        if (Object.keys(attrs).length) edit.attrs = attrs;
      }
      for (const k of Object.keys(checks)) {
        if (checks[k] && !checks0.current[k]) grant.push(k);
        if (!checks[k] && checks0.current[k]) revoke.push(k);
      }
      if (isMysql) {
        if (grantOption0.current && !grantOption) revoke.push('GRANT OPTION');
        if (grant.length) edit.grantPrivs = grant;
        if (revoke.length) edit.revokePrivs = revoke;
        if (grant.length && grantOption && !grantOption0.current) edit.grantOption = true;
      } else {
        if (grant.length) edit.grantPrivs = grant;
        if (revoke.length) edit.revokePrivs = revoke;
      }
      if (!edit.attrs && !edit.grantPrivs && !edit.revokePrivs) {
        setMsg({ ok: false, text: '没有修改' });
        return;
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      await api.updateUserPrivileges(connId, user.name, user.host, edit);
      setMsg({ ok: true, text: '权限已更新' });
      onApplied();
    } catch (e) {
      setMsg({ ok: false, text: `保存失败：${errMsg(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const removeMember = (r: string) => {
    setPgMembers((s) => s.filter((x) => x !== r));
    if (pgGrant.includes(r)) setPgGrant((s) => s.filter((x) => x !== r));
    else setPgRevoke((s) => (s.includes(r) ? s : [...s, r]));
  };

  // 未提交改动数（底部执行条徽标）
  const dirty = isPg
    ? Object.keys(pgAttrs).filter((k) => pgAttrs[k] !== pgAttrs0.current[k]).length + pgGrant.length + pgRevoke.length
    : (isMysql ? (['locked', 'expired'] as const).filter((k) => myAttrs[k] !== myAttrs0.current[k]).length : 0)
      + Object.keys(checks).filter((k) => checks[k] !== checks0.current[k]).length
      + (isMysql && grantOption !== grantOption0.current ? 1 : 0);

  const reset = () => {
    if (isPg) {
      setPgAttrs({ ...pgAttrs0.current });
      setPgGrant([]);
      setPgRevoke([]);
    } else {
      setChecks({ ...checks0.current });
      setGrantOption(grantOption0.current);
      setMyAttrs({ ...myAttrs0.current });
    }
    setMsg(null);
  };

  const pgSwitches: [string, string, string][] = [
    ['login', '可登录（LOGIN）', '允许此角色连接数据库'],
    ['superuser', '超级用户（SUPERUSER）', '绕过所有权限检查，慎用'],
    ['createDb', '建库（CREATEDB）', '允许创建数据库'],
    ['createRole', '建角色（CREATEROLE）', '允许创建与管理其他角色'],
    ['replication', '流复制（REPLICATION）', '允许流复制连接'],
    ['inherit', '继承（INHERIT）', '自动继承所属角色的权限'],
  ];

  const secTitle = 'mb-2 flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.714)] font-semibold text-muted-foreground';
  const swRow = 'flex items-center gap-2.5 rounded-lg border border-border bg-muted px-3 py-2';
  const swLbl = 'text-[length:calc(var(--pref-fs)*0.786)] text-foreground';
  const swDesc = 'mt-0.5 text-[length:calc(var(--pref-fs)*0.643)] text-muted-foreground';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3.5">
        {/* —— 账户属性（拨杆） —— */}
        <div className={secTitle}>
          <Icon name="shield" className="h-3 w-3 shrink-0"  />
          账户属性
        </div>
        {isPg && (
          <div className="mb-4 flex flex-col gap-1.5">
            {pgSwitches.map(([k, lbl, desc]) => (
              <div key={k} className={swRow}>
                <div className="min-w-0 flex-1">
                  <div className={swLbl}>{lbl}</div>
                  <div className={swDesc}>{desc}</div>
                </div>
                <Switch on={!!pgAttrs[k]} onChange={(v) => setPgAttrs((s) => ({ ...s, [k]: v }))} />
              </div>
            ))}
          </div>
        )}
        {isMysql && (
          <div className="mb-4 flex flex-col gap-1.5">
            <div className={swRow}>
              <div className="min-w-0 flex-1">
                <div className={swLbl}>锁定账号（ACCOUNT LOCK）</div>
                <div className={swDesc}>禁止登录但保留角色与授权</div>
              </div>
              <Switch tone="warn" on={!!myAttrs.locked} onChange={(v) => setMyAttrs((s) => ({ ...s, locked: v }))} />
            </div>
            <div className={swRow}>
              <div className="min-w-0 flex-1">
                <div className={swLbl}>口令过期（PASSWORD EXPIRE）</div>
                <div className={swDesc}>下次登录强制修改口令</div>
              </div>
              <Switch tone="prod" on={!!myAttrs.expired} onChange={(v) => setMyAttrs((s) => ({ ...s, expired: v }))} />
            </div>
            <div className={swRow}>
              <div className="min-w-0 flex-1">
                <div className={swLbl}>WITH GRANT OPTION（可转授）</div>
                <div className={swDesc}>允许此账号把权限转授他人</div>
              </div>
              <Switch on={grantOption} onChange={setGrantOption} />
            </div>
          </div>
        )}
        {isOra && (
          <div className="mb-4 rounded-lg border border-border bg-muted px-3 py-2 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">
            Oracle 用户属性（表空间 / 配额）暂不支持在此编辑，可到 SQL 编辑器执行 ALTER USER。
          </div>
        )}

        {/* —— 权限勾选（MySQL 全局权限 / Oracle 系统权限与角色） —— */}
        {(isMysql || isOra) && (
          <>
            <div className={secTitle}>
              <Icon name="shield-2" className="h-3 w-3 shrink-0"  />
              {isMysql ? '全局权限（ON *.*）' : '系统权限与角色'}
              {(() => {
                const list = isMysql ? MYSQL_GLOBAL_PRIVS : ORA_SYS_PRIVS;
                const n = list.filter((p) => checks[p]).length;
                return (
                  <span className="ml-1 rounded-full border border-border bg-muted px-1.5 text-[length:calc(var(--pref-fs)*0.643)] font-normal leading-4 tabular-nums text-muted-foreground">
                    已选 {n} / {list.length}
                  </span>
                );
              })()}
            </div>
            {/* 权限芯片矩阵：换行布局，已选权限主色高亮 */}
            <div className="flex flex-wrap gap-1.5">
              {isMysql && MYSQL_GLOBAL_PRIVS.map((p) => (
                <PrivChip key={p} label={p} on={!!checks[p]} onToggle={() => setChecks((s) => ({ ...s, [p]: !s[p] }))} />
              ))}
              {isOra && ORA_SYS_PRIVS.map((p) => (
                <PrivChip key={p} label={p} on={!!checks[p]} onToggle={() => setChecks((s) => ({ ...s, [p]: !s[p] }))} />
              ))}
            </div>
            {isOra && (
              <>
                <div className="mt-3 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">预定义角色</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {ORA_ROLES.map((p) => (
                    <PrivChip key={p} label={p} on={!!checks[p]} onToggle={() => setChecks((s) => ({ ...s, [p]: !s[p] }))} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {/* —— PG 角色成员 —— */}
        {isPg && (
          <>
            <div className="mt-4 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">角色成员（× 移除）</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {pgMembers.length === 0 && <span className="text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">（无）</span>}
              {pgMembers.map((r) => (
                <span key={r} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 text-[12px] font-medium text-foreground">
                  {r}
                  <button title="移除该角色" className="text-muted-foreground transition-colors hover:text-destructive" onClick={() => removeMember(r)}>
                    <Icon name="close" className="h-3 w-3"  />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <select value={pgRoleSel} onChange={(e) => setPgRoleSel(e.target.value)} className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring">
                <option value="">选择要授予的角色…</option>
                {users.filter((u) => u.name !== user.name && !pgMembers.includes(u.name)).map((u) => (
                  <option key={u.name} value={u.name}>{u.name}</option>
                ))}
              </select>
              <button
                disabled={!pgRoleSel}
                onClick={() => {
                  if (!pgRoleSel) return;
                  setPgMembers((s) => (s.includes(pgRoleSel) ? s : [...s, pgRoleSel]));
                  setPgGrant((s) => (s.includes(pgRoleSel) ? s : [...s, pgRoleSel]));
                  setPgRevoke((s) => s.filter((x) => x !== pgRoleSel));
                  setPgRoleSel('');
                }}
                className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-[13px] font-medium shadow-sm transition-colors hover:bg-muted disabled:opacity-40"
              >授予</button>
            </div>
          </>
        )}

        {/* —— 当前授权明细 —— */}
        <div className={secTitle + ' mt-4'}>
          <Icon name="shield-2" className="h-3 w-3 shrink-0"  />
          当前授权明细
          <span className="ml-auto rounded-full border border-border/70 bg-muted px-2 font-normal leading-4 text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{privs.length} 项</span>
        </div>
        {privs.length === 0 ? (
          <div className="text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">（无显式授权）</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {privs.map((p, i) => (
              <div key={i} className="rounded-lg border border-border bg-muted px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 break-all font-mono text-[length:calc(var(--pref-fs)*0.786)] font-medium text-foreground">{p.privilege}</span>
                  {p.grantable && (
                    <span className="shrink-0 rounded bg-success/15 px-1 text-[length:calc(var(--pref-fs)*0.643)] leading-4 text-success">可转授</span>
                  )}
                  {p.target && <span className="ml-auto shrink-0 truncate font-mono text-[length:calc(var(--pref-fs)*0.714)] text-muted-foreground">{p.target}</span>}
                </div>
                {p.raw && p.raw !== p.privilege && (
                  <div className="mt-1.5 overflow-x-auto whitespace-nowrap rounded border border-border bg-background px-2 py-1 font-mono text-[length:calc(var(--pref-fs)*0.643)] text-muted-foreground">{p.raw}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {msg && <div className={`mt-2 text-[length:calc(var(--pref-fs)*0.714)] ${msg.ok ? 'text-success' : 'text-destructive'}`}>{msg.text}</div>}
      </div>

      {/* —— 底部执行条 —— */}
      <div className="flex shrink-0 items-center gap-2.5 border-t border-border bg-muted/70 px-4 py-2.5">
        <span className={`flex min-w-0 flex-1 items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.714)] ${dirty > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
          {dirty > 0 ? (
            <>
              <Icon name="warning-3" className="h-3 w-3 shrink-0"  />
              {dirty} 处改动未提交
            </>
          ) : '无未提交改动'}
        </span>
        <button onClick={reset} disabled={busy || dirty === 0} className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-[13px] font-medium shadow-sm transition-colors hover:bg-secondary">回滚</button>
        <button onClick={() => void apply()} disabled={busy || dirty === 0} className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90">{busy ? '提交中…' : '提交改动'}</button>
      </div>
    </div>
  );
}

/** 新建用户对话框（按方言差异化字段：MySQL 主机 / PG LOGIN+CREATEDB / Oracle 表空间） */
function CreateUserDialog({ connId, kind, onClose, onCreated }: { connId: string; kind: string; onClose: () => void; onCreated: () => void }) {
  const isMysql = kind === 'mysql';
  const isOra = kind === 'oracle';
  const isPg = kind === 'postgres';
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [host, setHost] = useState('%');
  const [superuser, setSuperuser] = useState(false);
  const [canLogin, setCanLogin] = useState(true);
  const [createDb, setCreateDb] = useState(false);
  const [tablespace, setTablespace] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name.trim())) {
      setErr('请填写合法的用户名（字母/数字/下划线，以字母或下划线开头）');
      return;
    }
    if (!password) {
      setErr('口令不能为空');
      return;
    }
    setSubmitting(true);
    setErr(null);
    const spec: DbUserSpec = { name: name.trim(), password, host, superuser, canLogin, createDb, tablespace: tablespace.trim() || undefined };
    try {
      await api.createUser(connId, spec);
      onCreated();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSubmitting(false);
    }
  };

  const fieldCls = 'w-full rounded-sm border border-border bg-background px-1.5 py-1 text-[length:calc(var(--pref-fs)*0.786)] text-foreground outline-none focus:border-primary';
  const labelCls = 'text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div className="w-[360px] rounded-lg border border-border bg-muted p-4 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 text-[length:calc(var(--pref-fs)*0.857)] font-semibold text-foreground">
          新建用户
          <span className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-[length:calc(var(--pref-fs)*0.714)] font-normal text-muted-foreground">{isOra ? 'Oracle' : isMysql ? 'MySQL' : 'PostgreSQL'}</span>
        </div>
        <div className="grid grid-cols-[72px_1fr] items-center gap-x-2 gap-y-2.5">
          <span className={labelCls}>用户名</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="user_name" className={fieldCls} />
          <span className={labelCls}>口令</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={fieldCls} />
          {isMysql && (
            <>
              <span className={labelCls}>主机</span>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="%（任意主机）" className={fieldCls} />
            </>
          )}
          {isOra && (
            <>
              <span className={labelCls}>默认表空间</span>
              <input value={tablespace} onChange={(e) => setTablespace(e.target.value)} placeholder="USERS" className={fieldCls} />
            </>
          )}
          <span className={labelCls}>超级用户</span>
          <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-foreground">
            <input type="checkbox" checked={superuser} onChange={(e) => setSuperuser(e.target.checked)} />
            {isPg ? 'SUPERUSER' : isOra ? '授予 DBA' : 'GRANT ALL PRIVILEGES'}
          </label>
          {isPg && (
            <>
              <span className={labelCls}>可登录</span>
              <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-foreground">
                <input type="checkbox" checked={canLogin} onChange={(e) => setCanLogin(e.target.checked)} /> LOGIN
              </label>
              <span className={labelCls}>建库权限</span>
              <label className="flex items-center gap-1.5 text-[length:calc(var(--pref-fs)*0.786)] text-foreground">
                <input type="checkbox" checked={createDb} onChange={(e) => setCreateDb(e.target.checked)} /> CREATEDB
              </label>
            </>
          )}
        </div>
        {err && <div className="mt-2 text-[length:calc(var(--pref-fs)*0.714)] text-destructive">{err}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border border-border px-3 py-1 text-[length:calc(var(--pref-fs)*0.786)] text-muted-foreground hover:bg-secondary">取消</button>
          <button onClick={() => void submit()} disabled={submitting} className="rounded bg-primary px-3 py-1 text-[length:calc(var(--pref-fs)*0.786)] text-white hover:opacity-90 disabled:opacity-40">
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 顶部工具条文字按钮（图标 + 文字；danger=删除行，accent=提交等主动作）。icon 传 svg path 片段 */
export function TBtn({ label, onClick, disabled, danger, accent, icon }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; accent?: boolean; icon: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors ${
        danger
          ? 'text-foreground hover:bg-destructive/10 hover:text-destructive'
          : accent
            ? 'text-primary hover:bg-primary/10'
            : 'text-foreground hover:bg-secondary hover:text-foreground'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <IconBox className="h-3.5 w-3.5" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{icon}</IconBox>
      {label}
    </button>
  );
}
