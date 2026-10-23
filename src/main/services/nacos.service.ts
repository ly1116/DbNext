import type { ConnectionConfig, NacosConfigDetail, NacosConfigItem, NacosConfigPage, NacosConfigSpec, NacosInstanceInfo, NacosNamespace, NacosServiceDetail, NacosServiceItem, NacosServicePage } from '@shared/types';
import { getConnection } from './connection-store';

/**
 * Nacos 客户端（多连接方案 · fetch）。
 *
 * 连接方案（ConnectionConfig.apiVersion）：
 * - 'nacos2'：Nacos 1.x / 2.x，Open API v1（/v1/console/* + /v1/cs/*），默认；
 * - 'nacos3'：Nacos 3.x，新版控制台 API（/v3/console/*），统一响应体 { code, message, data }；
 * - 'rnacos'：r-nacos，兼容 v1 接口（与 nacos2 同路径，测试连通性策略更宽松）。
 *
 * 认证：配置了用户名/口令时登录取 accessToken（v1 → /v1/auth/users/login，
 * v3 → /v3/auth/user/login），按连接缓存（优先用服务端 tokenTtl），过期或 403 时自动重登一次；
 * 未配置则匿名访问。v1 鉴权携带方式（query / accessToken 头 / Bearer / Cookie）自动探测
 * 并按连接记忆；v3 固定 query + accessToken 头。
 *
 * 权限：命名空间列表按服务端返回为准；登录后对每个命名空间做一次配置列表探活
 * （pageSize=1），非 2xx 一律视为无读权限、不展示（对齐官方控制台「只显示有权限的
 * 命名空间」）。v1 方案下若 /v1/cs/* 被企业网关整体拦截，自动降级尝试 v2 REST API
 * （/v2/cs/config/*）并按连接记忆可用版本（404 = 不存在，不会误记）。
 *
 * @since 0.2.2
 */

type ApiVer = 'v1' | 'v3';

/** cs 配置 API 版本记忆（按连接）：v1 被网关拦截时降级 v2 */
const csFlavor = new Map<string, 'v1' | 'v2'>();

/** 登录令牌缓存（按连接 ID） */
const tokens = new Map<string, { token: string; expireAt: number }>();

/** 令牌兜底有效期（ms）：服务端未返回 tokenTtl 时取保守值 */
const TOKEN_TTL = 4 * 60 * 60 * 1000;

/** Nacos 服务地址（http://host:port/contextPath） */
function baseUrl(cfg: ConnectionConfig): string {
  const ctx = cfg.contextPath?.trim() || '/nacos';
  return `http://${cfg.host}:${cfg.port}${ctx.startsWith('/') ? ctx : `/${ctx}`}`;
}

/** 连接方案 → API 版本 */
function apiVerOf(cfg: ConnectionConfig): ApiVer {
  return cfg.apiVersion === 'nacos3' ? 'v3' : 'v1';
}

/** 按连接取解密后的配置（渲染端只传 connectionId） */
function cfgOf(connectionId: string): ConnectionConfig {
  const cfg = getConnection(connectionId);
  if (!cfg) throw new Error(`连接不存在: ${connectionId}`);
  return cfg;
}

/** 表单编码 POST body */
function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

/** 解码 JWT payload（仅诊断用；不含签名，无敏感信息） */
function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const seg = token.split('.');
    if (seg.length < 2) return null;
    const b64 = seg[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 登录并缓存令牌（兼容 v1 { accessToken } 与 v3 { code, data: { accessToken } } 两种响应） */
async function login(connectionId: string, cfg: ConnectionConfig): Promise<string> {
  const ver = apiVerOf(cfg);
  const path = ver === 'v3' ? '/v3/auth/user/login' : '/v1/auth/users/login';
  const res = await fetch(`${baseUrl(cfg)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ username: cfg.username ?? '', password: cfg.password ?? '' }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Nacos 登录失败（HTTP ${res.status}）`);
  const body = (await res.json()) as {
    accessToken?: string;
    tokenTtl?: number;
    code?: number;
    message?: string;
    data?: { accessToken?: string } | null;
  };
  const token = body.accessToken ?? body.data?.accessToken;
  if (!token) throw new Error(`Nacos 登录失败：${body.message ?? '用户名或口令错误'}`);
  // 服务端返回 tokenTtl（秒）时提前 5 分钟过期，避免边界失效
  const ttlMs = typeof body.tokenTtl === 'number' && body.tokenTtl > 0 ? body.tokenTtl * 1000 : TOKEN_TTL;
  tokens.set(connectionId, { token, expireAt: Date.now() + Math.max(ttlMs - 5 * 60 * 1000, 60 * 1000) });
  console.log(`[DataRoost][nacos] login ok user=${cfg.username} tokenLen=${token.length} ttl=${body.tokenTtl ?? '?'}s ver=${ver}`);
  const claims = jwtClaims(token);
  console.log(`[DataRoost][nacos] token claims: ${claims ? JSON.stringify(claims) : '（非 JWT 或解码失败）'}`);
  return token;
}

/** 取可用令牌（缓存优先；无凭据返回空串 = 匿名） */
async function tokenOf(connectionId: string, cfg: ConnectionConfig): Promise<string> {
  if (!cfg.username) return '';
  const hit = tokens.get(connectionId);
  if (hit && hit.expireAt > Date.now()) return hit.token;
  return login(connectionId, cfg);
}

/** 让令牌失效（403 时重登） */
function invalidateToken(connectionId: string): void {
  tokens.delete(connectionId);
}

/** 403 时的可读报错（区分未配置凭据 / 无命名空间权限两种场景） */
function forbiddenMsg(cfg: ConnectionConfig, what: string, detail: string): Error {
  if (!cfg.username) {
    return new Error(`${what}被拒绝（HTTP 403）：服务端已开启鉴权，请编辑连接填写用户名/密码后重试。${detail}`);
  }
  return new Error(`${what}被拒绝（HTTP 403）：当前账号可能没有该命名空间的读权限（对齐官方控制台：无权限的空间不展示）。${detail}`);
}

/** 带 token 查询串的 URL */
function withToken(url: string, token: string): string {
  return token ? `${url}${url.includes('?') ? '&' : '?'}accessToken=${encodeURIComponent(token)}` : url;
}

/**
 * v1 鉴权携带方式（按连接自动探测并记忆）：
 * 官方 v1 控制台只用 query 参数，但企业定制网关可能只认 accessToken 头 /
 * Authorization Bearer / Cookie 中的一种——403 时按顺序换方式重试，
 * 哪种能通就按连接记忆，后续请求直接用该方式。
 */
type AuthVariant = 'query' | 'header' | 'bearer' | 'cookie';
const AUTH_VARIANTS: AuthVariant[] = ['query', 'header', 'bearer', 'cookie'];
const v1Auth = new Map<string, AuthVariant>();
/** 鉴权方式已全部穷尽（按连接）：后续请求只发最后一次尝试的那种，避免 403 × 变体数的风暴 */
const v1AuthDead = new Set<string>();

function authVariantsOf(connectionId: string): AuthVariant[] {
  const hit = v1Auth.get(connectionId);
  if (v1AuthDead.has(connectionId)) return [hit ?? 'query'];
  return hit ? [hit, ...AUTH_VARIANTS.filter((v) => v !== hit)] : [...AUTH_VARIANTS];
}

/**
 * 统一请求（GET / POST / DELETE 表单）：
 * - 403 时先重登重试一次，仍 403 则换下一个鉴权携带方式（v1）再试；
 * - 任一方式拿到非 403 响应即定型（按连接记忆），全失败返回最后一次 403；
 * - v3 固定 query + accessToken 头（官方推荐方式）。
 */
async function rawRequest(
  connectionId: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  data?: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);
  const send = async (tk: string, variant: AuthVariant): Promise<Response> => {
    const headers: Record<string, string> = {};
    let url = `${baseUrl(cfg)}${path}`;
    if (tk) {
      if (ver === 'v3') {
        url = withToken(url, tk);
        headers.accessToken = tk;
      } else {
        switch (variant) {
          case 'query':
            url = withToken(url, tk);
            break;
          case 'header':
            headers.accessToken = tk;
            break;
          case 'bearer':
            headers.Authorization = `Bearer ${tk}`;
            break;
          case 'cookie':
            headers.Cookie = `accessToken=${tk}`;
            break;
        }
      }
    }
    if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : form(data ?? {}),
      signal: AbortSignal.timeout(15000),
    });
  };
  const variants: AuthVariant[] = ver === 'v3' ? ['query'] : authVariantsOf(connectionId);
  let last = { status: 0, text: '' };
  for (const variant of variants) {
    const token = await tokenOf(connectionId, cfg);
    let res = await send(token, variant);
    if (res.status === 403) {
      const body = await res.text();
      // authorization failed = token 有效、身份解析成功，但账号无该资源权限（NacosRoleServiceImpl.hasPermission=false）。
      // 这是真实结果，直接返回——绝不能换携带方式重试（换方式反而会产生误导性的 "user not found!"）。
      if (body.includes('authorization failed')) {
        if (ver === 'v1') {
          v1Auth.set(connectionId, variant);
          v1AuthDead.add(connectionId);
        }
        console.log(`[DataRoost][nacos] ${method} ${path} → 403 authorization failed（token 有效，账号无该资源权限）`);
        return { status: 403, text: body };
      }
      // user not found! / token invalid! = 身份未被解析（token 缺失或无效）：重登后重试，仍失败换下一种方式
      invalidateToken(connectionId);
      const fresh = await tokenOf(connectionId, cfg);
      res = await send(fresh, variant);
      if (res.status === 403) {
        last = { status: 403, text: await res.text() };
        console.log(`[DataRoost][nacos] ${method} ${path} → 403（auth=${variant}），换下一种携带方式…`);
        continue;
      }
    }
    if (ver === 'v1') v1Auth.set(connectionId, variant);
    return { status: res.status, text: await res.text() };
  }
  // 全部携带方式都被 403：标记穷尽，后续请求只试最后一次的方式（快速失败）
  if (ver === 'v1') {
    v1Auth.set(connectionId, variants[variants.length - 1] ?? 'query');
    v1AuthDead.add(connectionId);
  }
  return last;
}

/** 统一 GET 文本 */
async function getText(connectionId: string, path: string): Promise<{ status: number; text: string }> {
  return rawRequest(connectionId, path, 'GET');
}

/** 统一 POST/DELETE 表单请求（非 2xx 抛错） */
async function sendForm(connectionId: string, path: string, method: 'POST' | 'DELETE', data: Record<string, string>): Promise<string> {
  const cfg = cfgOf(connectionId);
  const { status, text } = await rawRequest(connectionId, path, method, data);
  if (status < 200 || status >= 300) {
    if (status === 403) throw forbiddenMsg(cfg, '请求', text.slice(0, 160));
    throw new Error(`Nacos 请求失败（HTTP ${status}）：${text.slice(0, 200)}`);
  }
  return text;
}

/** v3 统一响应体拆包：{ code, message, data }，code 非 0/200 视为失败 */
function unwrapV3<T>(raw: string, what: string): T {
  const body = JSON.parse(raw) as { code?: number; message?: string; data?: T; error?: string };
  if (body.code != null && body.code !== 0 && body.code !== 200) {
    throw new Error(`${what}失败：${body.message || body.error || `code=${body.code}`}`);
  }
  return body.data as T;
}

/** 测试连通性：有凭据先登录；再校验 Nacos 服务可用（按方案选择探测接口） */
export async function nacosTest(cfg: ConnectionConfig): Promise<void> {
  const ver = apiVerOf(cfg);
  if (cfg.username) await login(cfg.id ?? '', cfg);
  if (ver === 'v3') {
    // v3：/v3/admin/core/state 为公开接口，返回统一响应体（data.version）
    const res = await fetch(`${baseUrl(cfg)}/v3/admin/core/state`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = unwrapV3<{ version?: string }>(await res.text(), '连接测试');
    if (!data || typeof data !== 'object') throw new Error('响应不是 Nacos server state');
    return;
  }
  const res = await fetch(`${baseUrl(cfg)}/v1/console/server/state`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    // r-nacos 可能未实现 state 接口：退而用配置列表探活（200 即视为可用）
    if (cfg.apiVersion === 'rnacos') {
      const probe = await fetch(`${baseUrl(cfg)}/v1/cs/configs?pageNo=1&pageSize=1`, { signal: AbortSignal.timeout(10000) });
      if (probe.ok) return;
      throw new Error(`HTTP ${probe.status}`);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  const state = (await res.json()) as { version?: string };
  if (!state || typeof state !== 'object') throw new Error('响应不是 Nacos server state');
}

/** v2 统一响应体拆包：{ code, message, data }，code 0 = 成功（Nacos 2.x v2 Result 规范） */
function unwrapV2<T>(raw: string, what: string): T {
  const body = JSON.parse(raw) as { code?: number; message?: string; data?: T };
  if (body.code != null && body.code !== 0) {
    const msg = body.message || `code=${body.code}`;
    throw new Error(msg.includes('not exist') ? `${what}失败：配置不存在` : `${what}失败：${msg}`);
  }
  return body.data as T;
}

/**
 * 指定 cs API 版本的配置列表探活（判断当前账号对某命名空间是否有读权限）。
 * - 2xx → 'ok'（有读权限）；
 * - 403 → 'forbidden'（无读权限）；
 * - 其余（404 = 该版本 API 不存在、5xx、网络异常）→ 'unknown'（不能证明有权限）。
 */
async function csProbe(connectionId: string, tenant: string, flavor: 'v1' | 'v2'): Promise<'ok' | 'forbidden' | 'unknown'> {
  try {
    const path =
      flavor === 'v1'
        ? `/v1/cs/configs?${new URLSearchParams({ search: 'blur', dataId: '', group: '', app: '', pageNo: '1', pageSize: '1', tenant }).toString()}`
        : `/v2/cs/config/list?${new URLSearchParams({ search: 'blur', dataId: '', groupName: '', appName: '', pageNo: '1', pageSize: '1', namespaceId: tenant }).toString()}`;
    const { status, text } = await getText(connectionId, path);
    if (status !== 200) {
      console.log(`[DataRoost][nacos] probe ${flavor} tenant="${tenant}" → HTTP ${status} :: ${text.slice(0, 120)}`);
    }
    if (status >= 200 && status < 300) return 'ok';
    // authorization failed = token 有效但账号无该空间权限 → forbidden；其余 403（身份问题）→ unknown
    if (status === 403) return text.includes('authorization failed') ? 'forbidden' : 'unknown';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 已判定无读权限的命名空间（按连接缓存，避免每次刷新重复探活风暴） */
const forbiddenTenants = new Map<string, Set<string>>();

function rememberForbidden(connectionId: string, tenant: string): void {
  let set = forbiddenTenants.get(connectionId);
  if (!set) {
    set = new Set();
    forbiddenTenants.set(connectionId, set);
  }
  set.add(tenant);
}

/**
 * 配置列表探活（自动定型 cs API 版本 + 鉴权携带方式）：
 * v1 探活 403 时再用 v2 试一次——部分企业网关拦 /v1/cs/* 但放行 /v2/*；
 * 只有探活明确 2xx 的版本才按连接记忆（404/异常不算，防止把不存在的 API 当可用）。
 */
async function csCanRead(connectionId: string, tenant: string): Promise<'ok' | 'forbidden' | 'unknown'> {
  if (forbiddenTenants.get(connectionId)?.has(tenant)) return 'forbidden';
  const cached = csFlavor.get(connectionId);
  if (cached) {
    const r = await csProbe(connectionId, tenant, cached);
    if (r === 'forbidden') rememberForbidden(connectionId, tenant);
    return r;
  }
  const r1 = await csProbe(connectionId, tenant, 'v1');
  if (r1 === 'ok') {
    csFlavor.set(connectionId, 'v1');
    return 'ok';
  }
  if (r1 === 'unknown') return 'unknown';
  const r2 = await csProbe(connectionId, tenant, 'v2');
  if (r2 === 'ok') {
    csFlavor.set(connectionId, 'v2');
    return 'ok';
  }
  if (r2 === 'forbidden') rememberForbidden(connectionId, tenant);
  return r2;
}

/**
 * 当前连接应使用的 cs API 版本（未定型时先探活一次定型）
 */
async function csFlavorOf(connectionId: string, tenant: string): Promise<'v1' | 'v2'> {
  if (csFlavor.has(connectionId)) return csFlavor.get(connectionId)!;
  await csCanRead(connectionId, tenant);
  return csFlavor.get(connectionId) ?? 'v1';
}

/** 服务端版本诊断日志（每连接一次，便于排查企业定制版差异） */
const versionLogged = new Set<string>();

async function logServerVersion(connectionId: string): Promise<void> {
  if (versionLogged.has(connectionId)) return;
  versionLogged.add(connectionId);
  try {
    const { status, text } = await getText(connectionId, '/v1/console/server/state');
    console.log(`[DataRoost][nacos] server state (${status}): ${text.slice(0, 300)}`);
  } catch {
    // 诊断信息，失败忽略
  }
}

/** 列出命名空间（只保留有读权限的空间；对齐官方控制台行为） */
export async function nacosNamespaces(connectionId: string): Promise<NacosNamespace[]> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);
  let list: NacosNamespace[];
  if (ver === 'v3') {
    // v3 控制台：命名空间列表任意有效身份可访问，服务端按可见性/权限过滤
    const { status, text } = await getText(connectionId, '/v3/console/core/namespace/list');
    if (status === 403) throw forbiddenMsg(cfg, '获取命名空间', text.slice(0, 160));
    if (status !== 200) throw new Error(`获取命名空间失败（HTTP ${status}）：${text.slice(0, 200)}`);
    const arr = unwrapV3<Array<Record<string, unknown>>>(text, '获取命名空间');
    list = (arr ?? []).map((n) => ({
      namespaceId: String(n.namespace ?? n.namespaceId ?? ''),
      namespaceShowName: String(n.namespaceShowName ?? ''),
      configCount: typeof n.configCount === 'number' ? n.configCount : 0,
      type: typeof n.type === 'number' ? n.type : undefined,
    }));
  } else {
    await logServerVersion(connectionId);
    const { status, text } = await getText(connectionId, '/v1/console/namespaces');
    if (status === 403) throw forbiddenMsg(cfg, '获取命名空间', text.slice(0, 160));
    if (status !== 200) throw new Error(`获取命名空间失败（HTTP ${status}）：${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { code?: number; message?: string; data?: Array<Record<string, unknown>> };
    if (body.code != null && body.code !== 200) throw new Error(body.message || `code=${body.code}`);
    // v1 console 接口的字段名是 `namespace`（v3 才叫 namespaceId），必须映射，否则探活全打到 public
    list = (body.data ?? []).map((n) => ({
      namespaceId: String(n.namespace ?? n.namespaceId ?? ''),
      namespaceShowName: String(n.namespaceShowName ?? ''),
      configCount: typeof n.configCount === 'number' ? n.configCount : 0,
      type: typeof n.type === 'number' ? n.type : undefined,
    }));
    console.log(`[DataRoost][nacos] 命名空间列表：${list.length} 个（样例：${list.slice(0, 4).map((n) => `${n.namespaceId || 'public'}(${n.namespaceShowName})`).join(', ')}）`);
    if (cfg.username && list.length > 0) {
      // v1 console 接口对所有登录用户返回全量命名空间：逐个探活，只保留有读权限的空间
      // （对齐官方控制台「连上之后只显示有权限的命名空间」；鉴权方式与 cs 版本在首个空间定型，
      //  之后每个空间只发一次探活请求，避免请求数 × 变体数的风暴）。
      await csCanRead(connectionId, list[0].namespaceId ?? '');
      const probes = await Promise.all(list.map((ns) => csCanRead(connectionId, ns.namespaceId ?? '')));
      const okCount = probes.filter((r) => r === 'ok').length;
      console.log(`[DataRoost][nacos] 权限探活完成：${okCount}/${probes.length} 个命名空间有读权限（鉴权方式=${v1Auth.get(connectionId) ?? '?'}，cs版本=${csFlavor.get(connectionId) ?? '?'}）`);
      if (okCount === 0) {
        // 登录成功但全部空间权限拒绝：给出可行动的明确提示（而不是静默展示空树）
        throw new Error(
          `登录成功，但账号 ${cfg.username} 在该 Nacos 服务器上没有可读的命名空间（所有空间的配置读取均被服务端以 403 authorization failed 拒绝，即账号没有任何角色权限）。` +
          `请让 Nacos 管理员在控制台「权限控制」中为该账号的角色添加对应命名空间的读权限；` +
          `如果参考工具能看到配置，请核对其登录的账号/服务器是否与本连接完全一致。`,
        );
      }
      list = list.filter((_, i) => probes[i] === 'ok');
    }
  }
  return list;
}

/** v2 REST API 配置列表（Nacos 2.x 自带；企业网关拦截 /v1/cs/* 时的降级通道） */
async function v2ListConfigs(
  connectionId: string,
  tenant: string,
  opts: { dataId?: string; group?: string; appName?: string; pageNo?: number; pageSize?: number },
  pageNo: number,
  pageSize: number,
): Promise<NacosConfigPage> {
  const cfg = cfgOf(connectionId);
  const q = new URLSearchParams({
    search: 'blur',
    dataId: opts.dataId || '',
    groupName: opts.group || '',
    appName: opts.appName || '',
    pageNo: String(pageNo),
    pageSize: String(pageSize),
    namespaceId: tenant,
  });
  const { status, text } = await getText(connectionId, `/v2/cs/config/list?${q.toString()}`);
  if (status === 403) throw forbiddenMsg(cfg, '获取配置列表', text.slice(0, 160));
  if (status !== 200) throw new Error(`获取配置列表失败（HTTP ${status}）：${text.slice(0, 200)}`);
  const page = unwrapV2<{ totalCount?: number; pagesAvailable?: number; pageItems?: Array<Record<string, unknown>> }>(text, '获取配置列表');
  const items: NacosConfigItem[] = (page.pageItems ?? []).map((it) => ({
    dataId: String(it.dataId ?? ''),
    group: String(it.groupName ?? it.group ?? ''),
    type: it.type ? String(it.type) : undefined,
    appName: it.appName ? String(it.appName) : undefined,
    md5: it.md5 ? String(it.md5) : undefined,
    tenant,
  }));
  return { totalCount: page.totalCount ?? 0, pageNo, pageSize, items };
}

/**
 * 模糊搜索配置列表（dataId/group/appName 可为空 = 全部）。
 * @param tenant 命名空间 ID（public 传空串；v3 传 'public'）
 */
export async function nacosListConfigs(
  connectionId: string,
  tenant: string,
  opts: { dataId?: string; group?: string; appName?: string; pageNo?: number; pageSize?: number } = {},
): Promise<NacosConfigPage> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);
  const pageNo = opts.pageNo ?? 1;
  const pageSize = opts.pageSize ?? 100;

  if (ver === 'v3') {
    const ns = tenant === '' ? 'public' : tenant;
    const q = new URLSearchParams({
      search: 'blur',
      dataId: opts.dataId || '',
      groupName: opts.group || '',
      appName: opts.appName || '',
      pageNo: String(pageNo),
      pageSize: String(pageSize),
      namespaceId: ns,
    });
    const { status, text } = await getText(connectionId, `/v3/console/cs/config/list?${q.toString()}`);
    if (status === 403) throw forbiddenMsg(cfg, '获取配置列表', text.slice(0, 160));
    if (status !== 200) throw new Error(`获取配置列表失败（HTTP ${status}）：${text.slice(0, 200)}`);
    const page = unwrapV3<{ totalCount?: number; pagesAvailable?: number; pageItems?: Array<Record<string, unknown>> }>(text, '获取配置列表');
    const items: NacosConfigItem[] = (page.pageItems ?? []).map((it) => ({
      dataId: String(it.dataId ?? ''),
      group: String(it.groupName ?? it.group ?? ''),
      type: it.type ? String(it.type) : undefined,
      appName: it.appName ? String(it.appName) : undefined,
      md5: it.md5 ? String(it.md5) : undefined,
      tenant: ns,
    }));
    return { totalCount: page.totalCount ?? 0, pageNo, pageSize, items };
  }

  // v1 方案：按连接记忆的 cs 版本走（v1 被网关拦截时自动降级 v2）
  if (await csFlavorOf(connectionId, tenant) === 'v2') {
    return v2ListConfigs(connectionId, tenant, opts, pageNo, pageSize);
  }

  const q = new URLSearchParams({
    search: 'blur',
    dataId: opts.dataId || '',
    group: opts.group || '',
    app: opts.appName || '',
    pageNo: String(pageNo),
    pageSize: String(pageSize),
    tenant,
  });
  const { status, text } = await getText(connectionId, `/v1/cs/configs?${q.toString()}`);
  if (status === 403) throw forbiddenMsg(cfg, '获取配置列表', text.slice(0, 160));
  if (status !== 200) throw new Error(`获取配置列表失败（HTTP ${status}）：${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { totalCount?: number; pagesAvailable?: number; pageItems?: NacosConfigItem[] };
  return { totalCount: body.totalCount ?? 0, pageNo, pageSize, items: body.pageItems ?? [] };
}

/** 读取配置内容（原始 body；404 = 配置不存在） */
export async function nacosGetConfig(connectionId: string, tenant: string, dataId: string, group: string): Promise<NacosConfigDetail> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);

  if (ver === 'v3') {
    const ns = tenant === '' ? 'public' : tenant;
    const q = new URLSearchParams({ dataId, groupName: group, namespaceId: ns });
    const { status, text } = await getText(connectionId, `/v3/console/cs/config?${q.toString()}`);
    if (status === 404) throw new Error(`配置不存在：${group}::${dataId}`);
    if (status === 403) throw forbiddenMsg(cfg, '读取配置', text.slice(0, 160));
    if (status !== 200) throw new Error(`读取配置失败（HTTP ${status}）：${text.slice(0, 200)}`);
    const d = unwrapV3<Record<string, unknown>>(text, '读取配置');
    return { dataId, group, tenant: ns, type: d.type ? String(d.type) : '', content: String(d.content ?? '') };
  }

  // v2 降级：{ code:0, data: ConfigVo } 响应
  if (await csFlavorOf(connectionId, tenant) === 'v2') {
    const q = new URLSearchParams({ dataId, groupName: group, namespaceId: tenant });
    const { status, text } = await getText(connectionId, `/v2/cs/config?${q.toString()}`);
    if (status === 404) throw new Error(`配置不存在：${group}::${dataId}`);
    if (status === 403) throw forbiddenMsg(cfg, '读取配置', text.slice(0, 160));
    if (status !== 200) throw new Error(`读取配置失败（HTTP ${status}）：${text.slice(0, 200)}`);
    const d = unwrapV2<Record<string, unknown>>(text, '读取配置');
    return { dataId, group, tenant, type: d.type ? String(d.type) : '', content: String(d.content ?? '') };
  }

  const q = new URLSearchParams({ dataId, group, tenant });
  const { status, text } = await getText(connectionId, `/v1/cs/configs?${q.toString()}`);
  if (status === 404) throw new Error(`配置不存在：${group}::${dataId}`);
  if (status === 403) throw forbiddenMsg(cfg, '读取配置', text.slice(0, 160));
  if (status !== 200) throw new Error(`读取配置失败（HTTP ${status}）：${text.slice(0, 200)}`);
  // 列表行带上 type/appName 的信息在详情里拿不到，这里从列表接口元数据补齐由调用方传入即可；
  // type 推断交给前端按 dataId 后缀/内容判断
  return { dataId, group, tenant, type: '', content: text };
}

/** 发布配置（存在则更新；返回 'true'/code=0 视为成功） */
export async function nacosPublishConfig(connectionId: string, spec: NacosConfigSpec): Promise<void> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);

  if (ver === 'v3') {
    const ns = (spec.tenant ?? '') === '' ? 'public' : spec.tenant ?? '';
    const data: Record<string, string> = {
      dataId: spec.dataId,
      groupName: spec.group,
      namespaceId: ns,
      content: spec.content,
      type: spec.type || 'text',
    };
    const text = await sendForm(connectionId, '/v3/console/cs/config', 'POST', data);
    unwrapV3<unknown>(text, '发布配置');
    return;
  }

  const tenant = spec.tenant ?? '';
  if (await csFlavorOf(connectionId, tenant) === 'v2') {
    const data: Record<string, string> = {
      dataId: spec.dataId,
      groupName: spec.group,
      namespaceId: tenant,
      content: spec.content,
      type: spec.type || 'text',
    };
    const text = await sendForm(connectionId, '/v2/cs/config', 'POST', data);
    unwrapV2<unknown>(text, '发布配置');
    return;
  }

  const data: Record<string, string> = {
    dataId: spec.dataId,
    group: spec.group,
    tenant,
    content: spec.content,
    type: spec.type || 'text',
  };
  const text = await sendForm(connectionId, '/v1/cs/configs', 'POST', data);
  if (text.trim() !== 'true') throw new Error(`发布失败：${text.slice(0, 200)}`);
}

/** 删除配置 */
export async function nacosDeleteConfig(connectionId: string, tenant: string, dataId: string, group: string): Promise<void> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);

  if (ver === 'v3') {
    const ns = tenant === '' ? 'public' : tenant;
    const q = new URLSearchParams({ dataId, groupName: group, namespaceId: ns });
    const text = await sendForm(connectionId, `/v3/console/cs/config?${q.toString()}`, 'DELETE', {});
    unwrapV3<unknown>(text, '删除配置');
    return;
  }

  if (await csFlavorOf(connectionId, tenant) === 'v2') {
    const q2 = new URLSearchParams({ dataId, groupName: group, namespaceId: tenant });
    const text = await sendForm(connectionId, `/v2/cs/config?${q2.toString()}`, 'DELETE', {});
    unwrapV2<unknown>(text, '删除配置');
    return;
  }

  const q = new URLSearchParams({ dataId, group, tenant });
  const text = await sendForm(connectionId, `/v1/cs/configs?${q.toString()}`, 'DELETE', {});
  if (text.trim() !== 'true') throw new Error(`删除失败：${text.slice(0, 200)}`);
}

/* ————————————————— 服务发现（服务列表 / 服务详情 / 实例列表） ————————————————— */

/**
 * 服务列表（v1 控制台目录 API /v1/ns/catalog/services：自带集群数/实例数/健康数）。
 * catalog 被网关拦截或不存在（404/405）时降级 /v1/ns/service/list（仅服务名，统计置 0）。
 */
export async function nacosServiceList(
  connectionId: string,
  tenant: string,
  opts: { group?: string; serviceName?: string; pageNo?: number; pageSize?: number } = {},
): Promise<NacosServicePage> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);
  const pageNo = opts.pageNo ?? 1;
  const pageSize = opts.pageSize ?? 20;
  const group = opts.group || 'DEFAULT_GROUP';

  if (ver === 'v3') {
    const ns = tenant === '' ? 'public' : tenant;
    const q = new URLSearchParams({
      pageNo: String(pageNo),
      pageSize: String(pageSize),
      namespaceId: ns,
      groupName: group,
      serviceNameParam: opts.serviceName || '',
    });
    const { status, text } = await getText(connectionId, `/v3/console/ns/service/list?${q.toString()}`);
    if (status === 403) throw forbiddenMsg(cfg, '获取服务列表', text.slice(0, 160));
    if (status !== 200) throw new Error(`获取服务列表失败（HTTP ${status}）：${text.slice(0, 200)}`);
    const page = unwrapV3<{ count?: number; serviceList?: Array<Record<string, unknown>> }>(text, '获取服务列表');
    const items: NacosServiceItem[] = (page.serviceList ?? []).map((it) => ({
      name: String(it.name ?? it.serviceName ?? ''),
      group: String(it.groupName ?? group),
      clusterCount: typeof it.clusterCount === 'number' ? it.clusterCount : 0,
      ipCount: typeof it.ipCount === 'number' ? it.ipCount : 0,
      healthyCount: typeof it.healthyInstanceCount === 'number' ? it.healthyInstanceCount : 0,
    }));
    return { totalCount: page.count ?? items.length, pageNo, pageSize, items };
  }

  // v1：优先 catalog 目录接口（含统计）；404/405/400 降级 service/list
  const catalogQ = new URLSearchParams({
    pageNo: String(pageNo),
    pageSize: String(pageSize),
    groupName: group,
    namespaceId: tenant,
    serviceNameParam: opts.serviceName || '',
  });
  const cat = await getText(connectionId, `/v1/ns/catalog/services?${catalogQ.toString()}`);
  if (cat.status >= 200 && cat.status < 300) {
    try {
      const body = JSON.parse(cat.text) as { count?: number; serviceList?: Array<Record<string, unknown>> };
      const items: NacosServiceItem[] = (body.serviceList ?? []).map((it) => ({
        name: String(it.name ?? ''),
        group: String(it.groupName ?? group),
        clusterCount: typeof it.clusterCount === 'number' ? it.clusterCount : 0,
        ipCount: typeof it.ipCount === 'number' ? it.ipCount : 0,
        healthyCount: typeof it.healthyInstanceCount === 'number' ? it.healthyInstanceCount : 0,
      }));
      return { totalCount: body.count ?? items.length, pageNo, pageSize, items };
    } catch {
      // 落入下方降级
    }
  } else {
    console.log(`[DataRoost][nacos] catalog/services → HTTP ${cat.status}，降级 /v1/ns/service/list`);
  }

  const q = new URLSearchParams({
    pageNo: String(pageNo),
    pageSize: String(pageSize),
    groupName: group,
    namespaceId: tenant,
  });
  if (opts.serviceName) q.set('serviceNameParam', opts.serviceName);
  const { status, text } = await getText(connectionId, `/v1/ns/service/list?${q.toString()}`);
  if (status === 403) throw forbiddenMsg(cfg, '获取服务列表', text.slice(0, 160));
  if (status !== 200) throw new Error(`获取服务列表失败（HTTP ${status}）：${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { count?: number; doms?: string[] };
  const items: NacosServiceItem[] = (body.doms ?? []).map((name) => ({
    name,
    group,
    clusterCount: 0,
    ipCount: 0,
    healthyCount: 0,
  }));
  return { totalCount: body.count ?? items.length, pageNo, pageSize, items };
}

/** 服务详情（保护阈值 + 集群名列表；catalog 失败降级 /v1/ns/service 的 clusterMap） */
export async function nacosServiceDetail(connectionId: string, tenant: string, serviceName: string, group: string): Promise<NacosServiceDetail> {
  const cfg = cfgOf(connectionId);
  const ver = apiVerOf(cfg);
  const ns = tenant === '' && ver === 'v3' ? 'public' : tenant;

  const q = new URLSearchParams({ serviceName, groupName: group, namespaceId: ns });
  const cat = await getText(connectionId, `/v1/ns/catalog/service?${q.toString()}`);
  if (cat.status >= 200 && cat.status < 300) {
    try {
      const body = JSON.parse(cat.text) as {
        service?: { name?: string; groupName?: string; protectThreshold?: number };
        clusters?: Array<{ name?: string }>;
      };
      if (body.service || body.clusters) {
        return {
          name: body.service?.name ?? serviceName,
          group: body.service?.groupName ?? group,
          protectThreshold: typeof body.service?.protectThreshold === 'number' ? body.service.protectThreshold : 0,
          clusters: (body.clusters ?? []).map((c) => String(c.name ?? '')).filter(Boolean),
        };
      }
    } catch {
      // 落入降级
    }
  }

  const { status, text } = await getText(connectionId, `/v1/ns/service?${q.toString()}`);
  if (status === 403) throw forbiddenMsg(cfg, '获取服务详情', text.slice(0, 160));
  if (status !== 200) throw new Error(`获取服务详情失败（HTTP ${status}）：${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { name?: string; groupName?: string; protectThreshold?: number; clusterMap?: Record<string, unknown> };
  return {
    name: body.name ?? serviceName,
    group: body.groupName ?? group,
    protectThreshold: typeof body.protectThreshold === 'number' ? body.protectThreshold : 0,
    clusters: Object.keys(body.clusterMap ?? {}),
  };
}

/** 实例列表（v1 /v1/ns/instance/list 的 hosts 数组；hosts 为 null = 无实例） */
export async function nacosInstanceList(connectionId: string, tenant: string, serviceName: string, group: string): Promise<NacosInstanceInfo[]> {
  const cfg = cfgOf(connectionId);
  const q = new URLSearchParams({ serviceName, groupName: group, namespaceId: tenant });
  const { status, text } = await getText(connectionId, `/v1/ns/instance/list?${q.toString()}`);
  if (status === 403) throw forbiddenMsg(cfg, '获取实例列表', text.slice(0, 160));
  if (status !== 200) throw new Error(`获取实例列表失败（HTTP ${status}）：${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { hosts?: Array<Record<string, unknown>> | null };
  return (body.hosts ?? []).map((h) => ({
    instanceId: String(h.instanceId ?? `${h.ip}:${h.port}`),
    ip: String(h.ip ?? ''),
    port: typeof h.port === 'number' ? h.port : Number(h.port ?? 0),
    weight: typeof h.weight === 'number' ? h.weight : 1,
    healthy: h.healthy === true,
    enabled: h.enabled !== false,
    ephemeral: h.ephemeral !== false,
    clusterName: String(h.clusterName ?? 'DEFAULT'),
    metadata: (h.metadata as Record<string, string>) ?? {},
  }));
}
