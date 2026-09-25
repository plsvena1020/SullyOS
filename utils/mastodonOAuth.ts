// utils/mastodonOAuth.ts
// Mastodon OAuth 一键绑定纯函数：归一化实例、拼授权地址、换 token、调 VPS bind。
// token 只在内存停留，bind 成功即丢弃，永不写 localStorage。
export const MASTODON_SCOPE = 'profile read:statuses write:statuses write:media write:favourites';

export function normInstance(input: string): string {
  return input.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

export function buildAuthorizeUrl({ instance, clientId, redirectUri, scope = MASTODON_SCOPE }: { instance: string; clientId: string; redirectUri: string; scope?: string }): string {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope });
  return `https://${normInstance(instance)}/oauth/authorize?${q}`;
}

export function useCodeGuard(): { take(code: string): boolean } {
  const seen = new Set<string>();
  return { take: (c) => { if (seen.has(c)) return false; seen.add(c); return true; } };
}

export async function registerApp(instance: string, redirectUri: string): Promise<{ client_id: string; client_secret: string }> {
  const r = await fetch(`https://${normInstance(instance)}/api/v1/apps`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'SullyOS Moments', redirect_uris: redirectUri, scopes: MASTODON_SCOPE }),
  });
  if (!r.ok) throw new Error(`注册应用失败 HTTP ${r.status}`);
  return r.json();
}

export async function exchangeCode(instance: string, p: { client_id: string; client_secret: string; redirect_uri: string; code: string }): Promise<{ access_token: string }> {
  const r = await fetch(`https://${normInstance(instance)}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...p, grant_type: 'authorization_code' }),
  });
  if (!r.ok) throw new Error('换 token 失败（code 可能已被用过或过期）');
  return r.json();
}

export async function bindAccount(mcpBase: string, mcpToken: string, p: { ownerId: string; instance: string; accessToken: string }): Promise<{ username: string; acct: string }> {
  const r = await fetch(`${mcpBase}/api/accounts/bind`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken}` },
    body: JSON.stringify(p),
  });
  if (!r.ok) throw new Error(`绑定失败 HTTP ${r.status}`);
  return r.json();
}

export interface BindPending {
  instance: string; ownerId: string; mcpBase: string; mcpToken: string;
  redirectUri: string; client_id: string; client_secret: string; state: string;
}

// 一键绑定发起：注册应用 → 组授权地址 + 待存 pending（含随机 state 防 CSRF）。
// 调用方把 pending 存 sessionStorage，浏览器跳 authorizeUrl；回调带回 code+state。
export async function createBindSession(p: { instance: string; ownerId: string; mcpBase: string; mcpToken: string; redirectUri: string }): Promise<{ authorizeUrl: string; pending: BindPending }> {
  const instance = normInstance(p.instance);
  const app = await registerApp(instance, p.redirectUri);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const state = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const pending: BindPending = { ...p, instance, client_id: app.client_id, client_secret: app.client_secret, state };
  return {
    authorizeUrl: buildAuthorizeUrl({ instance, clientId: app.client_id, redirectUri: p.redirectUri }) + `&state=${state}`,
    pending,
  };
}

export function verifyBindState(pending: BindPending, returnedState: string | null): boolean {
  return !!returnedState && returnedState === pending.state;
}

// 从 MCP server 条目推导 bind 基址：?target= 代理取解码目标；直连去掉尾部 /mcp 端点段（Caddy 子路径保留，bind 与 MCP 同前缀）。
// bind 走 HTTP 直调（非 MCP 协议），与 callMcpTool 路径无关。
export function mcpBaseUrl(server: { url: string }): string {
  const raw = (server.url || '').trim();
  try {
    const u = new URL(raw);
    const target = u.searchParams.get('target');
    const base = target ? decodeURIComponent(target) : raw.split('?')[0];
    return base.replace(/\/+$/, '').replace(/\/mcp$/i, '');
  } catch { return raw; }
}

export interface BoundIdentity { ownerId: string; acct: string; instance: string }

const IDENTITIES_KEY = 'mastodon-identities';

// 身份列表只存元数据（ownerId/acct/instance），不存 token。按 ownerId upsert：刷新非追加。
export async function loadIdentities(storage: Pick<Storage, 'getItem'>): Promise<BoundIdentity[]> {
  try {
    const raw = storage.getItem(IDENTITIES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e?.ownerId) : [];
  } catch { return []; }
}

export async function saveIdentity(storage: Pick<Storage, 'getItem' | 'setItem'>, entry: BoundIdentity): Promise<BoundIdentity[]> {
  const list = await loadIdentities(storage);
  const i = list.findIndex((e) => e.ownerId === entry.ownerId);
  if (i >= 0) list[i] = entry; else list.push(entry);
  storage.setItem(IDENTITIES_KEY, JSON.stringify(list));
  return list;
}
