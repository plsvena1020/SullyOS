// worker/sullyos-home/src/speak.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { speakFallback, wrapPcmAsWav } from './speak';
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

describe('wrapPcmAsWav', () => {
  it('给 PCM 添加标准 WAV chunk 头', () => {
    const wav = wrapPcmAsWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

    expect(wav).toHaveLength(8 + 44);
    expect(Array.from(wav.subarray(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);
    expect(Array.from(wav.subarray(8, 12))).toEqual([0x57, 0x41, 0x56, 0x45]);
    expect(Array.from(wav.subarray(12, 16))).toEqual([0x66, 0x6d, 0x74, 0x20]);
    expect(Array.from(wav.subarray(36, 40))).toEqual([0x64, 0x61, 0x74, 0x61]);
  });

  it('写入 RIFF 和 data 的小端长度字段', () => {
    const wav = wrapPcmAsWav(new Uint8Array(8));
    const view = new DataView(wav.buffer);

    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint32(40, true)).toBe(8);
  });

  it('写入固定 PCM 格式字段', () => {
    const wav = wrapPcmAsWav(new Uint8Array(8));
    const view = new DataView(wav.buffer);

    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(32000);
    expect(view.getUint32(28, true)).toBe(64000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it('空 PCM 返回带合法头且 data 长度为 0', () => {
    const wav = wrapPcmAsWav(new Uint8Array(0));

    expect(wav).toHaveLength(44);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});
