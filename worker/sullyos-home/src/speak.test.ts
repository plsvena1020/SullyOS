// worker/sullyos-home/src/speak.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { speakFallback } from './speak';
import homeWorker from './index';
describe('speak', () => {
  it('超时回退', async () => {
    const r = await speakFallback(async () => { throw new Error('timeout'); });
    expect(r.fallback).toBe(true);
  });
});

describe('POST /home/speak', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const env = { AMSG_CLIENT_TOKEN: 'secret' };
  const post = (body: unknown, token: string | null = 'secret') =>
    new Request('https://home.test/home/speak', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-client-token': token } : {}),
      },
      body: JSON.stringify(body),
    });

  it('没带 token → 401', async () => {
    const res = await homeWorker.fetch(post({ text: '你好' }, null), env as any);
    expect(res.status).toBe(401);
  });

  it('空 text → 400', async () => {
    const res = await homeWorker.fetch(post({ text: '  ' }), env as any);
    expect(res.status).toBe(400);
  });

  it('TTS 500 → 200 fallback:true（正文不丢，调用方照发纯文本）', async () => {
    vi.stubGlobal('fetch', async () => new Response('boom', { status: 500 }));
    const res = await homeWorker.fetch(post({ text: '你好' }), env as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audioUrl: null, fallback: true });
  });
});
