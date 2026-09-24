// components/home/HomeBadgeBridge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { probeHome } from './HomeBadgeBridge';
describe('probeHome', () => {
  it('VPS 宕机返回 err 而非抛', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')));
    const r = await probeHome({ agentUrl: 'https://x', agentToken: 't' } as any);
    expect(r.status).toBe('err');
  });
  it('两端点都 ok 返回 ok 且 detail 拼三数', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (String(url).endsWith('/home/health')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ messages: 3, memories: 5, events: 7 }),
      });
    });
    const r = await probeHome({ agentUrl: 'https://x', agentToken: 't' } as any);
    expect(r.status).toBe('ok');
    expect(r.detail ?? '').toContain('3');
    expect(r.detail ?? '').toContain('5');
    expect(r.detail ?? '').toContain('7');
  });
});
