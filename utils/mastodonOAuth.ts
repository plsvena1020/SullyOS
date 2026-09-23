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
