// vps-backend/src/xhs/sessionBridge.test.ts
import { describe, it, expect } from 'vitest';
import { startSessionBridge } from './sessionBridge.js';

const TOKEN = 'test-token';

const mkStore = (cookieStr = 'a1=' + 'a'.repeat(52) + '; web_session=s1') => ({
    async get() { return { cookieStr, version: 'v1', updatedAt: 1 }; },
    status: () => ({ configured: true, version: 'v1', updatedAt: 1, cookieNames: ['a1', 'web_session'], hasRequired: true }),
    async wipe() {},
});

const start = async (store: any, upstreamMock?: any) => {
    if (upstreamMock) {
        // 注入 upstream fetch 替身:通过 global fetch 拦截 https://upstream.test
        const realFetch = globalThis.fetch;
        (globalThis as any).__realFetchForBridgeTest = realFetch;
        vi_fetch_intercept = upstreamMock;
    }
    const br = startSessionBridge({
        port: 0, host: '127.0.0.1', token: TOKEN, store,
        upstream: 'https://upstream.test',
    });
    await br.ready;
    return br;
};

// 拦截器:bridge 内部 fetch(upstream.test)走 mock,其余(测试自身的 127.0.0.1 请求)走真 fetch。
let vi_fetch_intercept: any = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('upstream.test') && vi_fetch_intercept) {
        const json = await vi_fetch_intercept(url, init);
        return new Response(JSON.stringify(json.body), {
            status: json.status || 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    return realFetch(input, init);
}) as any;

const port = (br: any) => br.server.address().port;

describe('xhs sessionBridge', () => {
    it('health is open without token', async () => {
        const br = await start(mkStore());
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/health`);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toMatchObject({ status: 'ok' });
        await br.close();
    });

    it('rejects missing/incorrect token with 401', async () => {
        const br = await start(mkStore());
        const miss = await fetch(`http://127.0.0.1:${port(br)}/api/session/status`);
        expect(miss.status).toBe(401);
        const wrong = await fetch(`http://127.0.0.1:${port(br)}/api/session/status`, { headers: { 'x-bridge-token': 'nope' } });
        expect(wrong.status).toBe(401);
        await br.close();
    });

    it('status never includes the cookie string', async () => {
        const br = await start(mkStore());
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/session/status`, { headers: { 'x-bridge-token': TOKEN } });
        const body = await resp.text();
        expect(body).not.toContain('web_session=');
        expect(body).not.toContain('a1=');
        await br.close();
    });

    it('forwards commands with decrypted cookie + session tag; no-store', async () => {
        const br = await start(mkStore(), async (url: string, init: any) => {
            expect(url).toBe('https://upstream.test/api/search');
            expect(init.headers['x-xhs-cookie']).toContain('web_session=');
            return { body: { success: true, feeds: [], platform: 'xhs' } };
        });
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
            body: JSON.stringify({ keyword: 'cat' }),
        });
        const data = await resp.json();
        expect(data.success).toBe(true);
        expect(data.xhs_session_tag).toBeTruthy();
        expect(resp.headers.get('cache-control')).toBe('no-store');
        await br.close();
    });

    it('OPTIONS preflight returns 204 with echoed headers (CORS contract)', async () => {
        const br = await start(mkStore());
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Headers': 'content-type,x-bridge-token' },
        });
        expect(resp.status).toBe(204);
        expect(resp.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
        expect(resp.headers.get('access-control-allow-headers')).toContain('x-bridge-token');
        await br.close();
    });

    it('redacts leaked cookie fragments from upstream errors', async () => {
        const br = await start(mkStore(), async () => ({ body: { error: 'bad header a1=SECRET; web_session=LEAK' } }));
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
            body: '{}',
        });
        const text = JSON.stringify(await resp.json());
        expect(text).not.toContain('SECRET');
        expect(text).not.toContain('LEAK');
        expect(text).toContain('[REDACTED]');
        await br.close();
    });

    it('503 when the store is empty', async () => {
        const emptyStore = { async get() { throw new Error('STORE_EMPTY'); }, status: () => ({ configured: false }), async wipe() {} };
        const br = await start(emptyStore as any);
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
            body: '{}',
        });
        expect(resp.status).toBe(503);
        await br.close();
    });
});
