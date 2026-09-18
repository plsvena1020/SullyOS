/**
 * 中心 worker 的 /kugou 中转（worker/index.js）。
 * 钉住：action 白名单、song/url→auth/merge 重写、cookie 头→query 参数、
 * 未配上游时的 500 提示、边缘缓存 HIT/MISS。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error 中心 worker 是纯 JS 单文件，仓库没开 allowJs
import worker, { __kugouProxyTest } from './index.js';

const { buildKugouUpstream } = __kugouProxyTest;
const KUGOU_TEST_UPSTREAM = 'https://kugou-test.vercel.app';

/** 假上游 fetch，记录收到的调用 */
const stubUpstream = (status = 200, body = '{"status":1}') => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
};

/** 内存版 Cache API（vitest 的 node 环境没有 caches.default） */
const stubCaches = () => {
  const store = new Map<string, Response>();
  vi.stubGlobal('caches', {
    default: {
      match: vi.fn(async (req: Request) => store.get(req.url)),
      put: vi.fn(async (req: Request, res: Response) => { store.set(req.url, res); }),
    },
  });
  return store;
};

const callKugou = (path: string, body: any, cookie = '', env: any = { KUGOU_UPSTREAMS: KUGOU_TEST_UPSTREAM }) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['X-Kugou-Cookie'] = cookie;
  return worker.fetch(
    new Request(`https://proxy.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    env,
    { waitUntil: () => {} },
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('buildKugouUpstream', () => {
  it('白名单外的 action 返回 null', () => {
    expect(buildKugouUpstream('evil/proxy', { a: 1 }, '')).toBeNull();
  });

  it('search 透传业务参数并带 cookie/timestamp', () => {
    const url = buildKugouUpstream('search', { keywords: '晴天', page: 1, pagesize: 30 }, 'token=abc;userid=1');
    const u = new URL(`https://x${url}`);
    expect(u.pathname).toBe('/search');
    expect(u.searchParams.get('keywords')).toBe('晴天');
    expect(u.searchParams.get('cookie')).toBe('token=abc;userid=1');
    expect(u.searchParams.get('timestamp')).toBeTruthy();
  });

  it('song/url 重写为 /song/url/auth/merge', () => {
    const u = new URL(`https://x${buildKugouUpstream('song/url', { hash: 'h1', album_id: 'a1', quality: '320' }, '')}`);
    expect(u.pathname).toBe('/song/url/auth/merge');
    expect(u.searchParams.get('hash')).toBe('h1');
    expect(u.searchParams.get('quality')).toBe('320');
  });
});

describe('/kugou route', () => {
  it('未配上游时返回 500 + 提示', async () => {
    const res = await callKugou('/kugou/search', { keywords: 'x' }, '', {});
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error).toContain('KUGOU_UPSTREAMS');
  });

  it('白名单外 action 返回 404，一次上游都不打', async () => {
    const calls = stubUpstream();
    const res = await callKugou('/kugou/not-allowed', {});
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  it('转发到上游：GET + cookie/timestamp query，回传 JSON + X-Sully-Cache: MISS + CORS 头', async () => {
    stubCaches();
    const calls = stubUpstream(200, JSON.stringify({ status: 1, data: { lists: [] } }));
    const res = await callKugou('/kugou/search', { keywords: '晴天' }, 'token=abc;userid=1');
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const upstreamUrl = new URL(calls[0].url);
    expect(upstreamUrl.host).toBe('kugou-test.vercel.app');
    expect(upstreamUrl.pathname).toBe('/search');
    expect(upstreamUrl.searchParams.get('keywords')).toBe('晴天');
    expect(upstreamUrl.searchParams.get('cookie')).toBe('token=abc;userid=1');
    expect(calls[0].init.method).toBe('GET');
    expect(res.headers.get('X-Sully-Cache')).toBe('MISS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });

  it('缓存 TTL 内的 action 第二次不打上游（X-Sully-Cache: HIT）', async () => {
    stubCaches();
    stubUpstream(200, JSON.stringify({ status: 1, data: {} }));
    await callKugou('/kugou/lyric', { id: '1', accesskey: 'k' });
    const res2 = await callKugou('/kugou/lyric', { id: '1', accesskey: 'k' });
    expect(res2.headers.get('X-Sully-Cache')).toBe('HIT');
  });
});

describe('/kugou 上游错误透传（不吞酷狗真实 errcode）', () => {
  it('上游 502 带业务错误正文时，原样回 status+正文而非 fetch-failed 兜底', async () => {
    stubCaches();
    stubUpstream(502, JSON.stringify({ status: 0, errcode: 20031, error: 'need vip' }));
    const res = await callKugou('/kugou/song/url', { hash: 'h' });
    expect(res.status).toBe(502);
    const j = (await res.json()) as any;
    expect(j.errcode).toBe(20031);
    expect(res.headers.get('X-Sully-Cache')).toBe('MISS');
  });

  it('上游无响应正文（空 502）仍走 fetch-failed 兜底', async () => {
    stubCaches();
    stubUpstream(502, '');
    const res = await callKugou('/kugou/user/detail', {});
    expect(res.status).toBe(502);
    const j = (await res.json()) as any;
    expect(j.error).toContain('kugou upstream fetch failed');
  });
});
