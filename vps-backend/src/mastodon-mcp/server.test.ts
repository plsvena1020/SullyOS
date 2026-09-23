import { describe, it, expect } from 'vitest';
import { startMastodonMcpServer } from './server.js';
import { createGuard } from './guard.js';
import { createMastodonClient } from './mastodonApi.js';

const cfg = { port: 18937, mcpToken: 'tok', accounts: [], api: createMastodonClient({ fetchImpl: (async () => { throw new Error('no net'); }) as never }), guard: createGuard({ readOnly: true, auditLogPath: '/tmp/none.jsonl' }) };

describe('server', () => {
  it('health 免鉴 + /mcp 无 token 先 401', async () => {
    const s = await startMastodonMcpServer(cfg).ready.then((r) => r);
    const h = await fetch('http://127.0.0.1:18937/api/health').then((r) => r.json());
    expect(h.tools).toBe(8);
    const unauth = await fetch('http://127.0.0.1:18937/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    await s.close();
  });
  it('OPTIONS 预检 204', async () => {
    const s = await startMastodonMcpServer({ ...cfg, port: 18938 }).ready.then((r) => r);
    const pre = await fetch('http://127.0.0.1:18938/mcp', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    await s.close();
  });
  it('bind 无 token 401；带 token 验身份落后盘且不回显 token', async () => {
    const saved: Record<string, string> = {};
    const api = { verifyCredentials: async () => ({ id: '42', username: 'me', acct: 'me@a.social', display_name: '' }) };
    const mk = (port: number) => startMastodonMcpServer({
      ...cfg, port, api: api as never,
      accountStore: { filePath: '/run/acc.json', readFile: (async () => '[]') as never, writeFile: (async (p: string, s: string) => { saved[p] = s; }) as never, mkdir: (async () => {}) as never },
    }).ready.then((r) => r);
    const s = await mk(18939);
    const noAuth = await fetch('http://127.0.0.1:18939/api/accounts/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noAuth.status).toBe(401);
    const ok = await fetch('http://127.0.0.1:18939/api/accounts/bind', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify({ ownerId: 'user', instance: 'a.social', accessToken: 'SECRET' }) });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.acct).toBe('me@a.social');
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(JSON.parse(saved['/run/acc.json'])[0].ownerId).toBe('user');
    await s.close();
  });
});
