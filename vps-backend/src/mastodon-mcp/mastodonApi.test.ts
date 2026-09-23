// vps-backend/src/mastodon-mcp/mastodonApi.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createMastodonClient } from './mastodonApi.js';

const jsonResp = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);

describe('mastodonApi', () => {
  it('postStatus 缺 scope 时翻成中文', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(403, { error: 'This action is outside the authorized scopes' }));
    const api = createMastodonClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.postStatus({ instance: 'mstdn.social', accessToken: 'x', status: 'hi' }))
      .rejects.toThrow('缺 scope');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://mstdn.social/api/v1/statuses');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer x');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });
  it('verifyCredentials 返回精简身份', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(200, { id: '42', username: 'me', acct: 'me@mstdn.social', display_name: 'Me' }));
    const api = createMastodonClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const who = await api.verifyCredentials({ instance: 'mstdn.social', accessToken: 'x' });
    expect(who).toEqual({ id: '42', username: 'me', acct: 'me@mstdn.social', display_name: 'Me' });
  });
  it('uploadMedia 202 后轮询到 200 有 url 才返回', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/v2/media')) return jsonResp(202, { id: 'm1', url: null });
      return jsonResp(200, { id: 'm1', url: 'https://mstdn.social/media/m1.png' });
    });
    const api = createMastodonClient({ fetchImpl: fetchImpl as unknown as typeof fetch, pollIntervalMs: 1 });
    const id = await api.uploadMedia({ instance: 'mstdn.social', accessToken: 'x', fileBase64: 'aGk=', mimeType: 'image/png', description: 'alt' });
    expect(id).toBe('m1');
    expect(calls.filter((u) => u.includes('/api/v1/media/m1')).length).toBeGreaterThanOrEqual(1);
  });
});
