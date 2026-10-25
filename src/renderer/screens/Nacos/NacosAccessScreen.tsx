import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@renderer/api';
import { Icon } from '@renderer/components/common/icons';
import { useConnections } from '@renderer/store/connectionStore';
import { errMsg } from '@renderer/utils/errMsg';
import type { NacosPermissionItem, NacosRoleItem } from '@shared/types';

/**
 * Nacos 访问控制（用户和角色，对齐官方控制台「权限控制」）。
 *
 * - 顶部：用户 / 角色页签 + 说明文案 + 刷新；
 * - 用户页签：左列用户列表（搜索 + 新建），右侧用户详情 =
 *   用户名 + 重置密码 / 删除 + 关联角色（chips，可编辑增删）+ 有效权限（合并展示 + 来源角色）；
 * - 角色页签：左列角色列表（去重 + 用户数），右侧角色详情 =
 *   角色名 + 删除角色（解绑全部用户）+ 权限表（资源 / 动作，可增删）。
 *
 * 权限资源格式：`namespaceId:*:*`（如 `dev:*:*`），全部资源为 `*:*:*`；动作 rw=读写 / r=只读 / w=写。
 */
export function NacosAccessScreen({ connectionId }: { connectionId: string }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === connectionId));

  const [tab, setTab] = useState<'user' | 'role'>('user');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 用户名列表 */
  const [users, setUsers] = useState<string[] | null>(null);
  /** 角色绑定行（role ↔ username） */
  const [roles, setRoles] = useState<NacosRoleItem[] | null>(null);
  /** 角色权限缓存（按角色名） */
  const [permCache, setPermCache] = useState<Record<string, NacosPermissionItem[]>>({});

  const [userKw, setUserKw] = useState('');
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);

  /** 关联角色编辑态：true = 显示每个角色的 × 和新增输入 */
  const [editingRoles, setEditingRoles] = useState(false);
  const [newRole, setNewRole] = useState('');

  /** 角色页签：新增权限行内表单 */
  const [permResource, setPermResource] = useState('');
  const [permAction, setPermAction] = useState('rw');
  const [busy, setBusy] = useState(false);

  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const showToast = useCallback((text: string, ok = true) => {
    setToast({ text, ok });
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  /** 角色 → 用户名列表（按 username 分组） */
  const rolesOfUser = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const r of roles ?? []) (m[r.username] ??= []).push(r.role);
    return m;
  }, [roles]);

  /** 角色名去重列表（角色页签左列） */
  const uniqueRoles = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of roles ?? []) m.set(r.role, (m.get(r.role) ?? 0) + 1);
    return [...m.entries()].map(([role, count]) => ({ role, count }));
  }, [roles]);

  /** 有效权限：选中用户所有角色的权限合并（保留来源角色） */
  const userPerms = useMemo(() => {
    if (!selectedUser) return [];
    const out: NacosPermissionItem[] = [];
    for (const role of rolesOfUser[selectedUser] ?? []) out.push(...(permCache[role] ?? []));
    return out;
  }, [selectedUser, rolesOfUser, permCache]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, r] = await Promise.all([
        api.nacosUserList(connectionId, { pageSize: 200 }),
        api.nacosRoleList(connectionId, { pageSize: 500 }),
      ]);
      const names = u.items.map((x) => x.username).filter(Boolean);
      setUsers(names);
      setRoles(r.items);
      // 默认选中：优先当前连接登录名，否则第一个用户
      setSelectedUser((prev) => prev ?? (names.includes(conn?.username ?? '') ? conn!.username : names[0] ?? null));
      setSelectedRole((prev) => prev ?? r.items[0]?.role ?? null);
    } catch (e) {
      setError(errMsg(e));
      setUsers([]);
      setRoles([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId, conn?.username]);

  /** 拉取角色权限（缓存） */
  const loadPerms = useCallback(async (role: string) => {
    if (permCache[role]) return;
    try {
      const pg = await api.nacosPermissionList(connectionId, { role, pageSize: 500 });
      setPermCache((m) => ({ ...m, [role]: pg.items }));
    } catch (e) {
      setPermCache((m) => ({ ...m, [role]: [] }));
      showToast(`获取角色 ${role} 权限失败：${errMsg(e)}`, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 选中用户 / 角色变化 → 预取对应角色权限
  useEffect(() => {
    for (const role of rolesOfUser[selectedUser ?? ''] ?? []) void loadPerms(role);
  }, [selectedUser, rolesOfUser, loadPerms]);
  useEffect(() => {
    if (tab === 'role' && selectedRole) void loadPerms(selectedRole);
  }, [tab, selectedRole, loadPerms]);

  const shownUsers = (users ?? []).filter((u) => !userKw.trim() || u.toLowerCase().includes(userKw.trim().toLowerCase()));

  /* —— 动作 —— */
  const guard = async (fn: () => Promise<void>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      showToast(okMsg);
      await loadAll();
      setPermCache({});
    } catch (e) {
      showToast(errMsg(e), false);
    } finally {
      setBusy(false);
    }
  };

  const createUser = () => {
    const username = window.prompt('新用户名：')?.trim();
    if (!username) return;
    const password = window.prompt(`为 ${username} 设置密码：`);
    if (password == null || !password.trim()) return;
    void guard(() => api.nacosUserCreate(connectionId, username, password.trim()), `已创建用户 ${username}`);
  };

  const deleteUser = (username: string) => {
    if (!window.confirm(`确认删除用户「${username}」？其角色绑定将一并移除。`)) return;
    void guard(async () => {
      await api.nacosUserDelete(connectionId, username);
      if (selectedUser === username) setSelectedUser(null);
    }, `已删除用户 ${username}`);
  };

  const resetPassword = (username: string) => {
    const pwd = window.prompt(`为「${username}」设置新密码：`);
    if (!pwd?.trim()) return;
    void guard(() => api.nacosUserResetPassword(connectionId, username, pwd.trim()), `已重置 ${username} 的密码`);
  };

  const bindRole = (username: string, role: string) => {
    const r = role.trim();
    if (!r) return;
    void guard(async () => {
      await api.nacosRoleCreate(connectionId, r, username);
      setNewRole('');
    }, `已为 ${username} 绑定角色 ${r}`);
  };

  const unbindRole = (role: string, username?: string) => {
    const label = username ? `确认解除用户「${username}」与角色「${role}」的绑定？` : `确认删除角色「${role}」？其所有用户绑定将一并移除。`;
    if (!window.confirm(label)) return;
    void guard(() => api.nacosRoleDelete(connectionId, role, username), '已解绑');
  };

  const addPermission = (role: string) => {
    const resource = permResource.trim();
    if (!resource) {
      showToast('请填写权限资源，如 dev:*:* 或 *:*:*', false);
      return;
    }
    void guard(async () => {
      await api.nacosPermissionCreate(connectionId, role, resource, permAction);
      setPermResource('');
    }, `已为角色 ${role} 添加权限`);
  };

  const deletePermission = (p: NacosPermissionItem) => {
    if (!window.confirm(`确认删除角色「${p.role}」对「${p.resource}」的${actionLabel(p.action)}权限？`)) return;
    void guard(() => api.nacosPermissionDelete(connectionId, p.role, p.resource, p.action), '已删除权限');
  };

  /* —— 展示辅助 —— */
  const actionLabel = (a: string): string => (a === 'rw' ? '读写' : a === 'r' ? '只读' : a === 'w' ? '写' : a || '—');
  const actionCls = (a: string): string =>
    a === 'rw' ? 'border-primary/40 text-primary' : a === 'r' ? 'border-border text-muted-foreground' : 'border-warning/40 text-warning';
  const resourceLabel = (r: string): string => (r === '*:*:*' ? '全部资源' : r);

  const tabBtn = (active: boolean) =>
    `flex h-7 items-center gap-1.5 rounded-md border px-3 text-[12px] transition-colors ${
      active ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
    }`;
  const chipBtn = 'flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11.5px] text-foreground';
  const opBtn = 'flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-40';
  /** 危险操作按钮：静止即红（destructive 语义色），仅用于删除 / 解绑 / 移除等破坏性动作 */
  const dangerBtn = 'flex h-7 items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 text-[11.5px] text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-40';
  const dangerIconBtn = 'grid h-7 w-7 shrink-0 place-items-center rounded-md text-destructive hover:bg-destructive/10 disabled:opacity-40';
  const dangerChipX = 'grid h-4 w-4 place-items-center rounded text-destructive hover:bg-destructive/10';
  const dangerLinkBtn = 'inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-destructive hover:bg-destructive/10';

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* —— 顶栏：页签 + 说明 + 刷新 —— */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <button className={tabBtn(tab === 'user')} onClick={() => setTab('user')}>
          <Icon name="user" className="h-3.5 w-3.5" />
          用户
        </button>
        <button className={tabBtn(tab === 'role')} onClick={() => setTab('role')}>
          <Icon name="shield" className="h-3.5 w-3.5" />
          角色
        </button>
        <div className="h-4 w-px shrink-0 bg-border" />
        <span className="text-[12px] text-muted-foreground">
          访问控制 <span className="text-muted-foreground/60">管理 Nacos 用户和角色权限</span>
        </span>
        <button className={`${opBtn} ml-auto`} disabled={loading} onClick={() => void loadAll()} title="重新加载用户 / 角色 / 权限">
          <Icon name="refresh-4" className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {error ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-destructive">
          {error}
          <button className="text-primary hover:underline" onClick={() => void loadAll()}>
            重试
          </button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* —— 左列：用户 / 角色列表 —— */}
          <div className="flex w-64 shrink-0 flex-col border-r border-border">
            {tab === 'user' ? (
              <>
                <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
                  <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-background px-2">
                    <Icon name="search-2" className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <input
                      value={userKw}
                      onChange={(e) => setUserKw(e.target.value)}
                      placeholder="搜索用户"
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                  <button
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                    onClick={createUser}
                    title="新建用户"
                  >
                    <Icon name="plus" className="h-3.5 w-3.5" strokeWidth={2.2} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto py-1">
                  {loading && (!users || users.length === 0) && <div className="px-3 py-2 text-[11.5px] text-muted-foreground">加载用户…</div>}
                  {shownUsers.length === 0 && users != null && users.length > 0 && (
                    <div className="px-3 py-2 text-[11.5px] text-muted-foreground">无匹配「{userKw}」的用户</div>
                  )}
                  {shownUsers.map((u) => {
                    const on = selectedUser === u;
                    const isAdmin = (rolesOfUser[u] ?? []).some((r) => r.toUpperCase() === 'ROLE_ADMIN');
                    return (
                      <div
                        key={u}
                        className={`flex h-8 cursor-default items-center gap-2 rounded px-3 ${on ? 'bg-primary/10' : 'hover:bg-secondary'}`}
                        onClick={() => {
                          setSelectedUser(u);
                          setEditingRoles(false);
                        }}
                      >
                        <Icon name="user" className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-primary' : 'text-muted-foreground'}`} />
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{u}</span>
                        {isAdmin && <span className="shrink-0 rounded bg-secondary px-1.5 text-[10px] leading-4 text-muted-foreground">Admin</span>}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto py-1">
                {loading && (!roles || roles.length === 0) && <div className="px-3 py-2 text-[11.5px] text-muted-foreground">加载角色…</div>}
                {uniqueRoles.length === 0 && roles != null && (
                  <div className="px-3 py-2 text-[11.5px] text-muted-foreground">
                    （暂无角色。在「用户」页签为用户绑定角色时会自动创建）
                  </div>
                )}
                {uniqueRoles.map(({ role, count }) => {
                  const on = selectedRole === role;
                  return (
                    <div
                      key={role}
                      className={`flex h-8 cursor-default items-center gap-2 rounded px-3 ${on ? 'bg-primary/10' : 'hover:bg-secondary'}`}
                      onClick={() => setSelectedRole(role)}
                    >
                      <Icon name="shield" className={`h-3.5 w-3.5 shrink-0 ${on ? 'text-primary' : 'text-muted-foreground'}`} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{role}</span>
                      <span className="shrink-0 rounded bg-secondary px-1 text-[10px] text-muted-foreground">{count}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex h-8 shrink-0 items-center border-t border-border px-3 text-[11px] text-muted-foreground">
              {tab === 'user' ? `共 ${users?.length ?? 0} 个用户` : `共 ${uniqueRoles.length} 个角色`}
            </div>
          </div>

          {/* —— 右侧：详情 —— */}
          <div className="flex min-w-0 flex-1 flex-col overflow-auto">
            {tab === 'user' && selectedUser && (
              <>
                {/* 用户头 */}
                <div className="flex shrink-0 items-start gap-2.5 px-5 pb-3 pt-4">
                  <Icon name="user" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold">{selectedUser}</div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">无数据角色与终端生效的命名空间权限</div>
                  </div>
                  <button className={opBtn} disabled={busy} onClick={() => resetPassword(selectedUser)} title="为该用户设置新密码">
                    <Icon name="key-2" className="h-3.5 w-3.5" />
                    重置密码
                  </button>
                  <button
                    className={dangerIconBtn}
                    disabled={busy}
                    onClick={() => deleteUser(selectedUser)}
                    title={`删除用户 ${selectedUser}`}
                  >
                    <Icon name="trash" className="h-3.5 w-3.5" />
                  </button>
                </div>

                {/* 关联角色 */}
                <div className="shrink-0 border-t border-border px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">关联角色</span>
                    <span className="rounded-full border border-border px-1.5 text-[10.5px] leading-4 tabular-nums text-muted-foreground">
                      {(rolesOfUser[selectedUser] ?? []).length}
                    </span>
                    <button
                      className="ml-auto flex h-6 items-center gap-1 rounded px-1.5 text-[11.5px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                      onClick={() => {
                        setEditingRoles((v) => !v);
                        setNewRole('');
                      }}
                    >
                      <Icon name={editingRoles ? 'check' : 'edit'} className="h-3 w-3" />
                      {editingRoles ? '完成' : '编辑'}
                    </button>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">用户角色定义所关联角色的权限。</div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {(rolesOfUser[selectedUser] ?? []).map((role) => (
                      <span key={role} className={chipBtn}>
                        <Icon name="shield" className="h-3 w-3 text-muted-foreground" />
                        <span className="font-mono">{role}</span>
                        {editingRoles && (
                          <button
                            className={dangerChipX}
                            title={`解除绑定 ${role}`}
                            disabled={busy}
                            onClick={() => unbindRole(role, selectedUser)}
                          >
                            <Icon name="close" className="h-2.5 w-2.5" strokeWidth={2.2} />
                          </button>
                        )}
                      </span>
                    ))}
                    {(rolesOfUser[selectedUser] ?? []).length === 0 && !editingRoles && (
                      <span className="text-[11.5px] text-muted-foreground">（未关联任何角色）</span>
                    )}
                    {editingRoles && (
                      <input
                        value={newRole}
                        onChange={(e) => setNewRole(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && bindRole(selectedUser, newRole)}
                        placeholder="输入角色名，Enter 绑定（不存在则创建）"
                        disabled={busy}
                        className="h-6 w-56 rounded-md border border-border bg-background px-2 text-[11.5px] text-foreground outline-none focus:border-primary"
                      />
                    )}
                  </div>
                </div>

                {/* 有效权限 */}
                <div className="shrink-0 border-t border-border px-5 py-3">
                  <div className="text-[13px] font-semibold">有效权限</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">合并显示所有权限，并标明每项权限的来源角色。</div>
                  <table className="mt-2 w-full border-collapse text-[12px]" style={{ tableLayout: 'fixed' }}>
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                        <th className="w-1/2 px-3 py-1.5 font-normal">命名空间</th>
                        <th className="w-[22%] px-3 py-1.5 font-normal">动作</th>
                        <th className="px-3 py-1.5 font-normal">来源角色</th>
                      </tr>
                    </thead>
                    <tbody>
                      {userPerms.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="px-3 py-2 text-muted-foreground">
                            （无有效权限。为用户关联角色并授予命名空间权限后在此展示）
                          </td>
                        </tr>
                      ) : (
                        userPerms.map((p, i) => (
                          <tr key={`${p.role}:${p.resource}:${p.action}:${i}`} className="border-b border-border/60">
                            <td className="px-3 py-1.5">
                              <span className="block truncate">{resourceLabel(p.resource)}</span>
                              <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{p.resource}</span>
                            </td>
                            <td className="px-3 py-1.5">
                              <span className={`inline-flex rounded border px-1.5 text-[11px] leading-4 ${actionCls(p.action)}`}>{actionLabel(p.action)}</span>
                            </td>
                            <td className="px-3 py-1.5">
                              <span className="inline-flex rounded border border-border px-1.5 font-mono text-[11px] leading-4 text-muted-foreground">{p.role}</span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {tab === 'user' && !selectedUser && (
              <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">在左侧选择一个用户</div>
            )}

            {tab === 'role' && selectedRole && (
              <>
                {/* 角色头 */}
                <div className="flex shrink-0 items-start gap-2.5 px-5 pb-3 pt-4">
                  <Icon name="shield" className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[14px] font-semibold" title={selectedRole}>
                      {selectedRole}
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                      绑定用户 {(roles ?? []).filter((r) => r.role === selectedRole).length} 个 · 权限 {(permCache[selectedRole] ?? []).length} 条
                    </div>
                  </div>
                  <button className={dangerBtn} disabled={busy} onClick={() => unbindRole(selectedRole)} title="删除角色（解除其所有用户绑定）">
                    <Icon name="trash" className="h-3.5 w-3.5" />
                    删除角色
                  </button>
                </div>

                {/* 绑定的用户 */}
                <div className="shrink-0 border-t border-border px-5 py-3">
                  <div className="text-[13px] font-semibold">绑定用户</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {(roles ?? []).filter((r) => r.role === selectedRole).map((r) => (
                      <span key={`${r.role}:${r.username}`} className={chipBtn}>
                        <Icon name="user" className="h-3 w-3 text-muted-foreground" />
                        {r.username}
                        <button
                          className={dangerChipX}
                          title={`解除 ${r.username} 的绑定`}
                          disabled={busy}
                          onClick={() => unbindRole(r.role, r.username)}
                        >
                          <Icon name="close" className="h-2.5 w-2.5" strokeWidth={2.2} />
                        </button>
                      </span>
                    ))}
                    {(roles ?? []).filter((r) => r.role === selectedRole).length === 0 && (
                      <span className="text-[11.5px] text-muted-foreground">（未绑定用户，可在「用户」页签编辑关联角色）</span>
                    )}
                  </div>
                </div>

                {/* 权限表 */}
                <div className="shrink-0 border-t border-border px-5 py-3">
                  <div className="text-[13px] font-semibold">命名空间权限</div>
                  <table className="mt-2 w-full border-collapse text-[12px]" style={{ tableLayout: 'fixed' }}>
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left text-muted-foreground">
                        <th className="w-1/2 px-3 py-1.5 font-normal">命名空间（资源）</th>
                        <th className="w-[22%] px-3 py-1.5 font-normal">动作</th>
                        <th className="px-3 py-1.5 text-right font-normal">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(permCache[selectedRole] ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={3} className="px-3 py-2 text-muted-foreground">（该角色暂无权限）</td>
                        </tr>
                      ) : (
                        (permCache[selectedRole] ?? []).map((p, i) => (
                          <tr key={`${p.resource}:${p.action}:${i}`} className="border-b border-border/60">
                            <td className="px-3 py-1.5">
                              <span className="block truncate">{resourceLabel(p.resource)}</span>
                              <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{p.resource}</span>
                            </td>
                            <td className="px-3 py-1.5">
                              <span className={`inline-flex rounded border px-1.5 text-[11px] leading-4 ${actionCls(p.action)}`}>{actionLabel(p.action)}</span>
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <button
                                className={dangerLinkBtn}
                                disabled={busy}
                                onClick={() => deletePermission(p)}
                              >
                                <Icon name="trash" className="h-3 w-3" />
                                删除
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>

                  {/* 新增权限行内表单 */}
                  <div className="mt-2.5 flex items-center gap-1.5">
                    <input
                      value={permResource}
                      onChange={(e) => setPermResource(e.target.value)}
                      placeholder="资源，如 dev:*:*（全部资源 *:*:*）"
                      disabled={busy}
                      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[12px] text-foreground outline-none focus:border-primary"
                    />
                    <select
                      value={permAction}
                      onChange={(e) => setPermAction(e.target.value)}
                      disabled={busy}
                      className="h-7 shrink-0 rounded-md border border-border bg-background px-1.5 text-[12px] text-foreground outline-none focus:border-primary"
                      title="动作"
                    >
                      <option value="rw">读写</option>
                      <option value="r">只读</option>
                      <option value="w">写</option>
                    </select>
                    <button className={`${opBtn} shrink-0`} disabled={busy} onClick={() => addPermission(selectedRole)}>
                      <Icon name="plus" className="h-3.5 w-3.5" />
                      添加权限
                    </button>
                  </div>
                </div>
              </>
            )}

            {tab === 'role' && !selectedRole && (
              <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">在左侧选择一个角色</div>
            )}
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div
          className={`absolute right-4 top-12 z-50 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] shadow-lg ${
            toast.ok ? 'border-success/40 bg-card text-foreground' : 'border-warning/40 bg-card text-warning'
          }`}
        >
          <Icon name={toast.ok ? 'checkCircle' : 'warning-2'} className={`h-3.5 w-3.5 ${toast.ok ? 'text-success' : 'text-warning'}`} />
          {toast.text}
        </div>
      )}
    </div>
  );
}
