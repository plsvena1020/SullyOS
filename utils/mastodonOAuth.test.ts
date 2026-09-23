import { describe, it, expect, vi } from 'vitest';
import { normInstance, buildAuthorizeUrl, useCodeGuard } from './mastodonOAuth.js';
describe('mastodonOAuth', () => {
  it('实例归一化', () => { expect(normInstance('HTTPS://Mstdn.Social/')).toBe('mstdn.social'); });
  it('授权地址带 scope 与回调', () => {
    const u = buildAuthorizeUrl({ instance: 'mstdn.social', clientId: 'cid', redirectUri: 'https://app/x/cb', scope: 'profile read:statuses' });
    expect(u).toContain('/oauth/authorize');
    expect(u).toContain('scope=profile');
  });
  it('同一 code 只消费一次', () => {
    const g = useCodeGuard();
    expect(g.take('c1')).toBe(true);
    expect(g.take('c1')).toBe(false);
  });
  it('绑定会话带随机 state 并能校验', async () => {
    const { createBindSession, verifyBindState } = await import('./mastodonOAuth.js');
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ client_id: 'cid', client_secret: 'sec' }) }));
    try {
      const s = await createBindSession({ instance: 'mstdn.social', ownerId: 'user', mcpBase: 'https://mcp/x', mcpToken: 't', redirectUri: 'https://app/cb' });
      expect(s.pending.state.length).toBeGreaterThan(8);
      expect(s.authorizeUrl).toContain(`state=${s.pending.state}`);
      expect(verifyBindState(s.pending, s.pending.state)).toBe(true);
      expect(verifyBindState(s.pending, 'forged')).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
  it('身份库按 ownerId upsert（刷新非追加）', async () => {
    const { loadIdentities, saveIdentity } = await import('./mastodonOAuth.js');
    const store: Record<string, string> = {};
    const storage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
    await saveIdentity(storage as never, { ownerId: 'user', acct: 'me@a.social', instance: 'a.social' });
    await saveIdentity(storage as never, { ownerId: 'user', acct: 'me2@a.social', instance: 'a.social' });
    const list = await loadIdentities(storage as never);
    expect(list).toHaveLength(1);
    expect(list[0].acct).toBe('me2@a.social');
  });
  it('从 server 条目推导 bind 基址（直连留子路径，?target= 取目标，剥 /mcp 段）', async () => {
    const { mcpBaseUrl } = await import('./mastodonOAuth.js');
    expect(mcpBaseUrl({ url: 'https://mcp.example.com/mastodon-mcp' })).toBe('https://mcp.example.com/mastodon-mcp');
    expect(mcpBaseUrl({ url: 'https://proxy.example.com/?target=https%3A%2F%2Fmcp.example.com%2Fmastodon-mcp' })).toBe('https://mcp.example.com/mastodon-mcp');
    expect(mcpBaseUrl({ url: 'https://mcp.example.com/mastodon-mcp/' })).toBe('https://mcp.example.com/mastodon-mcp');
    expect(mcpBaseUrl({ url: 'https://mcp.example.com/mcp' })).toBe('https://mcp.example.com');
  });
});
