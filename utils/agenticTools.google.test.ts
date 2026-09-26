// utils/agenticTools.google.test.ts
// Task 9: char 主动查（agenticTools 只读工具）。
// ctx 构造模仿 utils/agenticTools.test.ts（char + userProfile 最小字段），
// 网络经 ctx.googleFetch 替身注入，不碰真实 Google 账号、不 stub 全局 fetch。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    runGoogleCalendarEvents,
    runGoogleTasks,
    proposeGoogleCreate,
    executeGoogleCreate,
    dispatchAgenticTool,
    type AgenticToolCtx,
} from './agenticTools';
import { buildEventBody } from './googleCalendar';
import type { UserProfile } from '../types';

const EVENT_RAW = [
    { summary: 'Project Review', status: 'confirmed', location: 'Meeting Room A', start: { dateTime: '2026-09-24T15:00:00+08:00' } },
    { summary: '团队午餐', status: 'confirmed', location: '楼下餐厅', start: { date: '2026-09-25' } },
    { summary: '已取消的会', status: 'cancelled', start: { dateTime: '2026-09-24T10:00:00+08:00' } },
];

const TASK_RAW = [
    { title: '买机票', status: 'needsAction', due: '2026-09-22T00:00:00Z' },
    { title: '写周报', status: 'completed', due: '2026-09-20T00:00:00Z' },
];

type GoogleFetchStub = (path: string, init?: RequestInit) => Promise<Response>;

const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 });

const unauthz = (): Response =>
    new Response(JSON.stringify({ error: 'REAUTH_REQUIRED' }), { status: 401 });

const ctxWith = (googleFetch: GoogleFetchStub): AgenticToolCtx => ({
    char: { name: '测试角色' },
    userProfile: { name: '用户' } as UserProfile,
    googleFetch,
});

const RANGE = { timeMin: '2026-09-23T00:00:00+08:00', timeMax: '2026-09-30T00:00:00+08:00' };

describe('runGoogleCalendarEvents', () => {
    beforeEach(() => {
        localStorage.setItem('aetheros.google.enabled', '1');
        localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(['acc1::cal1']));
    });
    afterEach(() => { localStorage.clear(); });

    it('正常返回归一化数组（已取消丢弃，只留 dateKey/title/startText）', async () => {
        const seen: Array<{ path: string; headers: any }> = [];
        const ctx = ctxWith(async (path, init) => {
            seen.push({ path, headers: (init as any)?.headers });
            return okJson({ items: EVENT_RAW });
        });
        const out = await runGoogleCalendarEvents(ctx, RANGE);
        expect(out).toEqual([
            { dateKey: '2026-09-24', title: 'Project Review', startText: '2026-09-24T15:00:00+08:00' },
            { dateKey: '2026-09-25', title: '团队午餐', startText: '2026-09-25' },
        ]);
        // Task 3/5 锁定形状：/api/events?calendarId&timeMin&timeMax + X-Google-Account 头
        expect(seen).toHaveLength(1);
        expect(seen[0].path).toContain('/api/events?');
        expect(seen[0].path).toContain('calendarId=cal1');
        expect(seen[0].path).toContain('timeMin=');
        expect(seen[0].path).toContain('timeMax=');
        expect(seen[0].headers['X-Google-Account']).toBe('acc1');
    });

    it('上游 401 时抛可识别错误（含 REAUTH_REQUIRED）', async () => {
        const ctx = ctxWith(async () => unauthz());
        await expect(runGoogleCalendarEvents(ctx, RANGE)).rejects.toThrow(/REAUTH_REQUIRED/);
    });

    it('keyword 过滤大小写不敏感（标题与地点子串）', async () => {
        const ctx = ctxWith(async () => okJson({ items: EVENT_RAW }));
        expect(await runGoogleCalendarEvents(ctx, { ...RANGE, keyword: 'project' }))
            .toEqual([{ dateKey: '2026-09-24', title: 'Project Review', startText: '2026-09-24T15:00:00+08:00' }]);
        expect(await runGoogleCalendarEvents(ctx, { ...RANGE, keyword: 'MEETING room' }))
            .toEqual([{ dateKey: '2026-09-24', title: 'Project Review', startText: '2026-09-24T15:00:00+08:00' }]);
        expect(await runGoogleCalendarEvents(ctx, { ...RANGE, keyword: '午餐' }))
            .toEqual([{ dateKey: '2026-09-25', title: '团队午餐', startText: '2026-09-25' }]);
        expect(await runGoogleCalendarEvents(ctx, { ...RANGE, keyword: '不存在的关键字' })).toEqual([]);
    });
});

describe('runGoogleTasks', () => {
    beforeEach(() => {
        localStorage.setItem('aetheros.google.enabled', '1');
        localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(['acc1::cal1']));
    });
    afterEach(() => { localStorage.clear(); });

    it('只返回未完成（completed 丢弃，只留 title/dueKey）', async () => {
        const seen: Array<{ path: string; headers: any }> = [];
        const ctx = ctxWith(async (path, init) => {
            seen.push({ path, headers: (init as any)?.headers });
            return okJson({ items: TASK_RAW });
        });
        const out = await runGoogleTasks(ctx, {});
        expect(out).toEqual([{ title: '买机票', dueKey: '2026-09-22' }]);
        // Task 3/5 锁定形状：/api/tasks?tasklist + X-Google-Account 头
        expect(seen).toHaveLength(1);
        expect(seen[0].path).toContain('/api/tasks?');
        expect(seen[0].path).toContain('tasklist=');
        expect(seen[0].headers['X-Google-Account']).toBe('acc1');
    });

    it('上游 401 时抛可识别错误（含 REAUTH_REQUIRED）', async () => {
        const ctx = ctxWith(async () => unauthz());
        await expect(runGoogleTasks(ctx, {})).rejects.toThrow(/REAUTH_REQUIRED/);
    });
});

describe('dispatchAgenticTool google cases', () => {
    beforeEach(() => {
        localStorage.setItem('aetheros.google.enabled', '1');
        localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(['acc1::cal1']));
    });
    afterEach(() => { localStorage.clear(); });

    it('google_calendar_events 走 dispatch 可达', async () => {
        const ctx = ctxWith(async (path) =>
            okJson({ items: String(path).includes('/api/events') ? EVENT_RAW : [] }));
        const out = await dispatchAgenticTool('google_calendar_events', RANGE, ctx);
        expect(out).toEqual([
            { dateKey: '2026-09-24', title: 'Project Review', startText: '2026-09-24T15:00:00+08:00' },
            { dateKey: '2026-09-25', title: '团队午餐', startText: '2026-09-25' },
        ]);
    });

    it('google_tasks 走 dispatch 可达', async () => {
        const ctx = ctxWith(async () => okJson({ items: TASK_RAW }));
        const out = await dispatchAgenticTool('google_tasks', {}, ctx);
        expect(out).toEqual([{ title: '买机票', dueKey: '2026-09-22' }]);
    });
});

describe('W4 propose/execute 确认环', () => {
    beforeEach(() => {
        localStorage.setItem('aetheros.google.enabled', '1');
        localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(['acc1::cal1']));
    });
    afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

    it('propose 返回 summary 含三要素（目标日历、标题、时间）且 payload 为 canonical', async () => {
        const ctx = ctxWith(async () => { throw new Error('propose 不得联网'); });
        const out = await proposeGoogleCreate(ctx, { kind: 'event', title: '开会', dateKey: '2026-09-25', timeText: '09:00' });
        expect(out.kind).toBe('event');
        expect(out.summary).toContain('cal1');
        expect(out.summary).toContain('开会');
        expect(out.summary).toContain('2026-09-25');
        expect(out.payload).toEqual(buildEventBody({ title: '开会', dateKey: '2026-09-25', timeText: '09:00' }));
    });

    it('execute 无确认抛 GOOGLE_NOT_CONFIRMED 且零 fetch', async () => {
        let ctxCalls = 0;
        let globalCalls = 0;
        const ctx = ctxWith(async () => { ctxCalls += 1; return okJson({}); });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { globalCalls += 1; return okJson({}); });
        const { payload } = await proposeGoogleCreate(ctx, { kind: 'event', title: '开会', dateKey: '2026-09-25' });
        await expect(executeGoogleCreate(ctx, { kind: 'event', payload, confirmed: false })).rejects.toThrow(/GOOGLE_NOT_CONFIRMED/);
        await expect(executeGoogleCreate(ctx, { kind: 'event', payload })).rejects.toThrow(/GOOGLE_NOT_CONFIRMED/);
        expect(ctxCalls).toBe(0);
        expect(globalCalls).toBe(0);
    });

    it('execute 有确认写透传（stub W3 底层 fetch 返回 id）', async () => {
        const seen: any[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
            seen.push([String(input), init]); return okJson({ id: 'e1' });
        });
        const ctx = ctxWith(async () => okJson({}));
        const out: any = await executeGoogleCreate(ctx, {
            kind: 'event',
            payload: buildEventBody({ title: '开会', dateKey: '2026-09-25' }),
            confirmed: true,
        });
        expect(out.id).toBe('e1');
        expect(seen).toHaveLength(1);
        expect(seen[0][0].endsWith('/api/events')).toBe(true);
        expect(seen[0][1].headers['X-Google-Account']).toBe('acc1');
        expect(JSON.parse(seen[0][1].body).calendarId).toBe('cal1');
    });

    it('execute 上游 REAUTH 体转抛 REAUTH_REQUIRED', async () => {
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => okJson({ error: 'REAUTH_REQUIRED' }));
        const ctx = ctxWith(async () => okJson({}));
        await expect(executeGoogleCreate(ctx, {
            kind: 'event',
            payload: buildEventBody({ title: '开会', dateKey: '2026-09-25' }),
            confirmed: true,
        })).rejects.toThrow(/REAUTH_REQUIRED/);
    });
});

// W2 · ctx.googleSelection 回落：worker 把 tool_pack.google 经 ctx 递进来时优先用它，
// localStorage 只留浏览器本地回落（worker 内根本没有 localStorage，直读会 fail-closed）。
describe('W2 ctx.googleSelection 回落', () => {
    beforeEach(() => { localStorage.clear(); });
    afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

    const ctxWithSelection = (
        googleFetch: GoogleFetchStub,
        googleSelection: Array<{ accountId: string; calendarId: string }>,
    ): AgenticToolCtx => ({ ...ctxWith(googleFetch), googleSelection });

    it('runGoogleCalendarEvents：ctx 非空时优先用 ctx（localStorage 为空也不抛）', async () => {
        const seen: Array<{ path: string; headers: any }> = [];
        const ctx = ctxWithSelection(async (path, init) => {
            seen.push({ path, headers: (init as any)?.headers });
            return okJson({ items: EVENT_RAW });
        }, [{ accountId: 'acc9', calendarId: 'cal9' }]);
        const out = await runGoogleCalendarEvents(ctx, RANGE);
        expect(out).toHaveLength(2);
        expect(seen).toHaveLength(1);
        expect(seen[0].path).toContain('calendarId=cal9');
        expect(seen[0].headers['X-Google-Account']).toBe('acc9');
    });

    it('runGoogleTasks：ctx 为空数组时回落 localStorage（原逻辑不变）', async () => {
        localStorage.setItem('aetheros.google.enabled', '1');
        localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(['acc1::cal1']));
        const ctx = ctxWithSelection(async () => okJson({ items: TASK_RAW }), []);
        const out = await runGoogleTasks(ctx, {});
        expect(out).toEqual([{ title: '买机票', dueKey: '2026-09-22' }]);
    });

    it('runGoogleTasks：ctx 缺席时回落 localStorage（原逻辑不变）', async () => {
        localStorage.setItem('aetheros.google.enabled', '1');
        localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(['acc1::cal1']));
        const seen: Array<{ path: string; headers: any }> = [];
        const ctx = ctxWith(async (path, init) => {
            seen.push({ path, headers: (init as any)?.headers });
            return okJson({ items: TASK_RAW });
        });
        const out = await runGoogleTasks(ctx, {});
        expect(out).toEqual([{ title: '买机票', dueKey: '2026-09-22' }]);
        expect(seen[0].headers['X-Google-Account']).toBe('acc1');
    });

    it('proposeGoogleCreate：ctx 非空时取 ctx 首个日历（localStorage 为空也不抛）', async () => {
        const ctx = ctxWithSelection(async () => { throw new Error('propose 不得联网'); },
            [{ accountId: 'acc9', calendarId: 'cal9' }]);
        const out = await proposeGoogleCreate(ctx, { kind: 'event', title: '开会', dateKey: '2026-09-25' });
        expect(out.summary).toContain('cal9');
    });

    it('executeGoogleCreate：ctx 非空时取 ctx 首个账号（localStorage 为空也不抛）', async () => {
        const seen: any[] = [];
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
            seen.push([String(input), init]); return okJson({ id: 'e9' });
        });
        const ctx = ctxWithSelection(async () => okJson({}),
            [{ accountId: 'acc9', calendarId: 'cal9' }]);
        const out: any = await executeGoogleCreate(ctx, {
            kind: 'event',
            payload: buildEventBody({ title: '开会', dateKey: '2026-09-25' }),
            confirmed: true,
        });
        expect(out.id).toBe('e9');
        expect(seen).toHaveLength(1);
        expect(seen[0][1].headers['X-Google-Account']).toBe('acc9');
        expect(JSON.parse(seen[0][1].body).calendarId).toBe('cal9');
    });
});
