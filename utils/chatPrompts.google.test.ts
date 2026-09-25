import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// harness 形状照抄 chatPrompts.scheduleClock.test.ts：构造 char + config，调
// ChatPrompts.buildSystemPromptParts 取 parts.volatileState 断言。
// Google 链路经 googleBridgeFetch 出网（ Task 5 ），这里 stub 全局 fetch 返回
// Task 3 形状 raw items；账号与勾选读 Task 6 落地的同一 localStorage 来源。

import { ChatPrompts } from './chatPrompts';
import { defaultRealtimeConfig } from './realtimeContext';

const userProfile = { name: '小明' } as any;

const EVENT_RAW = {
    summary: '项目评审',
    status: 'confirmed',
    start: { dateTime: '2026-09-24T15:00:00+08:00' },
};

// 「今天」是 2026-09-23，这条落在昨天——用来验证回看窗口内的事件也会注入
const PAST_EVENT_RAW = {
    summary: '上周的聚餐',
    status: 'confirmed',
    start: { date: '2026-09-20' },
};

const OVERDUE_TASK_RAW = {
    title: '交房租',
    status: 'needsAction',
    due: '2026-09-20',
};

const stubGoogleFetch = (opts: { events?: any[]; tasks?: any[] } = {}) => {
    const events = opts.events ?? [EVENT_RAW];
    const tasks = opts.tasks ?? [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes('/api/events')) {
            return new Response(JSON.stringify({ items: events }), { status: 200 });
        }
        if (url.includes('/api/tasks')) {
            return new Response(JSON.stringify({ items: tasks }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
    });
};

const buildVolatile = async (opts: { googleEnabled: boolean; timeAwarenessEnabled?: boolean }) => {
    const char = {
        id: 'char-google',
        name: '阿一',
        ...(opts.timeAwarenessEnabled === undefined ? {} : { timeAwarenessEnabled: opts.timeAwarenessEnabled }),
    } as any;
    // localStorage 为唯一开关（config.googleEnabled 生产无写入方，仅保留位）：
    // opts.googleEnabled 只驱动 localStorage，config 保持缺省。
    localStorage.setItem('aetheros.google.enabled', opts.googleEnabled ? '1' : '0');
    const config = { ...defaultRealtimeConfig };
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], [],
        config, undefined, undefined, undefined, undefined, undefined,
        undefined,
    );
    return parts.volatileState;
};

describe('Google 日程被动注入（volatile）', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 12, 0, 0));
        localStorage.setItem('aetheros.google.enabled', '1');
        localStorage.setItem('aetheros.google.selectedCalendars', JSON.stringify(['acc1::cal1']));
        stubGoogleFetch();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        localStorage.clear();
    });

    it('开关关闭时不注入 Google 段', async () => {
        const volatile = await buildVolatile({ googleEnabled: false });
        expect(volatile).not.toContain('Google 日程');
    });

    it('开启且有未来事件时注入标题与日期', async () => {
        const volatile = await buildVolatile({ googleEnabled: true });
        expect(volatile).toContain('### 【Google 日程】');
        expect(volatile).toContain('项目评审');
        expect(volatile).toContain('2026-09-24');
    });

    it('角色关闭时间感知时只留日期、不给精确钟点', async () => {
        const volatile = await buildVolatile({ googleEnabled: true, timeAwarenessEnabled: false });
        expect(volatile).toContain('2026-09-24');
        expect(volatile).not.toContain('15:00');
    });

    it('回看窗口内已发生的事件也注入（陪伴感靠连续记忆）', async () => {
        stubGoogleFetch({ events: [PAST_EVENT_RAW, EVENT_RAW] });
        const volatile = await buildVolatile({ googleEnabled: true });
        expect(volatile).toContain('上周的聚餐');
        expect(volatile).toContain('最近发生过');
        expect(volatile).toContain('接下来');
    });

    it('逾期待办单独成段，标出原定日期', async () => {
        stubGoogleFetch({ events: [EVENT_RAW], tasks: [OVERDUE_TASK_RAW] });
        const volatile = await buildVolatile({ googleEnabled: true });
        expect(volatile).toContain('交房租');
        expect(volatile).toContain('已过期还没做完的');
        expect(volatile).toContain('2026-09-20');
    });
});
