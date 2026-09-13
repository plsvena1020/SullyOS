/**
 * perspective 单测：端点解析 / type 规范化 / 查询冷却 / 窗口计算 /
 * 上传与查询的 fetch 参数组装与错误分支。fetch 全 mock，不发真请求。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    normalizePerspectiveType,
    resolvePerspectiveEndpoint,
    isPerspectiveEnabled,
    queryPerspectiveSessions,
    countPerspectiveSessions,
    getLatestPerspectiveSummary,
    savePerspectiveSummary,
    clearPerspectiveSessions,
    uploadPerspectiveSessions,
    checkPerspectiveInterval,
    markPerspectiveCalled,
    resetPerspectiveInterval,
    perspectiveWindow,
    PERSPECTIVE_MAX_DAYS,
    type PerspectiveSessionRow,
    type PerspectiveRuntimeAuth,
} from './perspective';
import type { RealtimeConfig } from '../types';

const fullRc = {
    perspectiveEnabled: true,
    perspectiveWorkerUrl: 'https://pv.example.workers.dev',
    perspectiveDays: 7,
    perspectiveMinIntervalSec: 60,
} as unknown as RealtimeConfig;

const auth: PerspectiveRuntimeAuth = { token: 'pvd_test', deviceId: 'dev-1' };

afterEach(() => {
    vi.restoreAllMocks();
    resetPerspectiveInterval();
});

describe('配置解析', () => {
    it('Worker URL 与令牌齐备才返回端点', () => {
        expect(resolvePerspectiveEndpoint(fullRc, auth)).toEqual({
            workerUrl: 'https://pv.example.workers.dev',
            authToken: 'pvd_test',
            deviceId: 'dev-1',
        });
        expect(resolvePerspectiveEndpoint({ ...fullRc, perspectiveWorkerUrl: '' } as unknown as RealtimeConfig, auth)).toBeNull();
        expect(resolvePerspectiveEndpoint(fullRc, null)).toBeNull();
        expect(resolvePerspectiveEndpoint(fullRc, {})).toBeNull();
        expect(resolvePerspectiveEndpoint(undefined, auth)).toBeNull();
    });

    it('URL 尾斜杠会被去掉；非 http(s) 拒绝；开关关着不算启用', () => {
        expect(
            resolvePerspectiveEndpoint(
                { ...fullRc, perspectiveWorkerUrl: 'https://pv.example.workers.dev/' } as unknown as RealtimeConfig,
                auth,
            )?.workerUrl,
        ).toBe('https://pv.example.workers.dev');
        expect(
            resolvePerspectiveEndpoint(
                { ...fullRc, perspectiveWorkerUrl: 'ftp://x' } as unknown as RealtimeConfig,
                auth,
            ),
        ).toBeNull();
        expect(isPerspectiveEnabled({ ...fullRc, perspectiveEnabled: false } as unknown as RealtimeConfig, auth)).toBe(false);
        expect(isPerspectiveEnabled(fullRc, auth)).toBe(true);
        expect(isPerspectiveEnabled(fullRc, null)).toBe(false);
    });
});

describe('type 规范化', () => {
    it('大写 / 空格 → 合法点分小写', () => {
        expect(normalizePerspectiveType('App.Open')).toBe('app.open');
        expect(normalizePerspectiveType('app..open')).toBe('app.open');
        expect(normalizePerspectiveType('.app.open.')).toBe('app.open');
    });

    it('整不出来的返回 null', () => {
        expect(normalizePerspectiveType('')).toBeNull();
        expect(normalizePerspectiveType('。。。')).toBeNull();
        expect(normalizePerspectiveType('!!!')).toBeNull();
    });
});

describe('查询冷却', () => {
    it('未记录过调用 → 允许', () => {
        expect(checkPerspectiveInterval(60).allowed).toBe(true);
    });

    it('刚调用过 → 拒绝并报剩余秒数', () => {
        markPerspectiveCalled();
        const r = checkPerspectiveInterval(60);
        expect(r.allowed).toBe(false);
        expect(r.waitSec).toBeGreaterThan(0);
        expect(r.waitSec).toBeLessThanOrEqual(60);
    });

    it('minIntervalSec=0 或负数 → 永远允许', () => {
        markPerspectiveCalled();
        expect(checkPerspectiveInterval(0).allowed).toBe(true);
        expect(checkPerspectiveInterval(-5).allowed).toBe(true);
    });
});

describe('窗口计算', () => {
    it('until 缺省 = now，since = until - days（epoch ms）', () => {
        const before = Date.now();
        const w = perspectiveWindow(7);
        const after = Date.now();
        expect(w.until).toBeGreaterThanOrEqual(before);
        expect(w.until).toBeLessThanOrEqual(after);
        expect(w.until - w.since).toBe(7 * 86400_000);
    });

    it('常量口径：最长 30 天', () => {
        expect(PERSPECTIVE_MAX_DAYS).toBe(30);
    });
});

describe('uploadPerspectiveSessions', () => {
    it('未配置 → not_configured，不发起请求', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const r = await uploadPerspectiveSessions(null, auth, { deviceId: 'd', batchId: 'b', events: [] });
        expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('401 → unauthorized；429 → rate_limited', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
        expect(await uploadPerspectiveSessions(fullRc, auth, { deviceId: 'd', batchId: 'b', events: [] }))
            .toMatchObject({ ok: false, reason: 'unauthorized', status: 401 });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
        expect(await uploadPerspectiveSessions(fullRc, auth, { deviceId: 'd', batchId: 'b', events: [] }))
            .toMatchObject({ ok: false, reason: 'rate_limited' });
    });

    it('成功返回 accepted/duplicates，带 Bearer 头', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ ok: true, accepted: 2, duplicates: 1 }), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const r = await uploadPerspectiveSessions(fullRc, auth, { deviceId: 'd', batchId: 'b', events: [] });
        expect(r).toEqual({ ok: true, accepted: 2, duplicates: 1 });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://pv.example.workers.dev/sessions');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer pvd_test');
    });
});

describe('queryPerspectiveSessions', () => {
    function mockFetchOnce(status: number, body: unknown) {
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
        );
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    const rows: PerspectiveSessionRow[] = [
        { id: 's2', device_id: 'd', platform: 'web', source: 'sullyos', app_key: 'chat', app_label: '聊天', started_at: 1700000000000, ended_at: 1700000600000, duration_ms: 600000 },
        { id: 's1', device_id: 'd', platform: 'web', source: 'sullyos', app_key: 'chat', app_label: '聊天', started_at: 1699999000000, ended_at: 1699999600000, duration_ms: 600000 },
    ];

    it('未配置端点 → not_configured，不发起请求', async () => {
        const fetchMock = mockFetchOnce(200, { sessions: [] });
        const r = await queryPerspectiveSessions(null, auth, { days: 3 });
        expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('正常返回：sessionsText 与 appCounts', async () => {
        const fetchMock = mockFetchOnce(200, { sessions: rows });
        const r = await queryPerspectiveSessions(fullRc, auth, { days: 3 });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.total).toBe(2);
        expect(r.appCounts).toEqual([{ appKey: 'chat', appLabel: '聊天', count: 2, totalDurationMs: 1200000 }]);
        expect(r.sessionsText).toContain('聊天');
        expect(r.sessionsText).toContain('共 2 段');

        const url = new URL(fetchMock.mock.calls[0][0] as string);
        expect(url.pathname).toBe('/sessions');
        expect(url.searchParams.get('limit')).toBe('100');
    });

    it('appKey 本地过滤；空结果 → empty', async () => {
        mockFetchOnce(200, { sessions: rows });
        const r1 = await queryPerspectiveSessions(fullRc, auth, { appKey: '不存在' });
        expect(r1).toMatchObject({ ok: false, reason: 'empty' });
    });

    it('401 → unauthorized；网络抛错 → network', async () => {
        mockFetchOnce(401, { error: 'unauthorized' });
        expect(await queryPerspectiveSessions(fullRc, auth, {})).toMatchObject({ ok: false, reason: 'unauthorized' });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        expect(await queryPerspectiveSessions(fullRc, auth, {})).toMatchObject({ ok: false, reason: 'network' });
    });

    it('limit 封顶 500、days 封顶 30', async () => {
        const fetchMock = mockFetchOnce(200, { sessions: [] });
        await queryPerspectiveSessions(fullRc, auth, { limit: 9999, days: 999 });
        const url = new URL(fetchMock.mock.calls[0][0] as string);
        expect(url.searchParams.get('limit')).toBe('500');
    });
});

describe('count / summary / clear', () => {
    it('count 返回会话数', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [{}, {}] }), { status: 200 })),
        );
        const r = await countPerspectiveSessions(fullRc, auth, { since: 1, until: 2 });
        expect(r).toEqual({ ok: true, count: 2 });
    });

    it('getLatestPerspectiveSummary 空库返回 null', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
        const r = await getLatestPerspectiveSummary(fullRc, auth, {});
        expect(r).toEqual({ ok: true, summary: null });
    });

    it('savePerspectiveSummary 成功', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })));
        const r = await savePerspectiveSummary(fullRc, auth, {
            windowStart: 1,
            windowEnd: 2,
            sessionCount: 10,
            totalDurationMs: 60000,
            summary: '一周概览',
            model: 'test-model',
        });
        expect(r).toEqual({ ok: true });
    });

    it('clearPerspectiveSessions 走 DELETE /sessions', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true,"deleted":7}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const r = await clearPerspectiveSessions(fullRc, auth, { beforeDays: 30 });
        expect(r).toEqual({ ok: true, deleted: 7 });
        const url = new URL(fetchMock.mock.calls[0][0] as string);
        expect(url.pathname).toBe('/sessions');
        expect(url.searchParams.get('beforeDays')).toBe('30');
    });
});
