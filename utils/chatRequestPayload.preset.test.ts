import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildChatRequestPayload } from './chatRequestPayload';
import type { BuildChatPayloadInput } from './chatRequestPayload';
import { RealtimeContextManager } from './realtimeContext';
import { DB } from './db';

const userProfile = { name: '小明' } as any;

const baseInput = (): BuildChatPayloadInput => ({
    char: { id: 'char-kitpay', name: '阿落' } as any,
    userProfile,
    groups: [],
    emojis: [],
    categories: [],
    historyMsgs: [
        { id: 1, charId: 'char-kitpay', role: 'user', type: 'text', content: '第一句', timestamp: 100 },
        { id: 2, charId: 'char-kitpay', role: 'assistant', type: 'text', content: '第一答', timestamp: 200 },
        { id: 3, charId: 'char-kitpay', role: 'user', type: 'text', content: '第二句', timestamp: 300 },
    ] as any[],
    contextLimit: 20,
    realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
});

beforeEach(() => {
    vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue(null as any);
    vi.spyOn(RealtimeContextManager, 'fetchNews').mockResolvedValue([] as any);
});

afterEach(() => {
    vi.restoreAllMocks();
});

const seedKit = async () => {
    const row = (over: any) => ({
        name: over.id, content: 'x', order: 0, enabled: true,
        createdAt: 1, updatedAt: 2, ...over,
    });
    await DB.savePromptPreset(row({ id: 'pay-after', name: '临场', content: 'AFTER_MARK', afterChatHistory: true }));
    await DB.savePromptPreset(row({
        id: 'pay-abs', name: '耳语', content: 'ABS_MARK',
        injectionPosition: 'absolute', injectionDepth: 1,
    }));
    const now = Date.now();
    await DB.savePresetPack({
        id: 'pay-pack', name: 'P', createdAt: now, updatedAt: now,
        entryIds: ['pay-after', 'pay-abs'],
    });
    await DB.setActivePackId('pay-pack');
};

describe('预设套组落位（payload 层）', () => {
    it('absolute 条目按 depth=1 插进历史（第二句之前），after 条目进 volatileTail 且在钢印前', async () => {
        await seedKit();
        const payload = await buildChatRequestPayload(baseInput());
        const msgs = payload.fullMessages;
        // 结构：[stable system, ...history(+absolute), volatileTail system]
        const absIdx = msgs.findIndex(m => String(m.content || '').includes('ABS_MARK'));
        const secondUserIdx = msgs.findIndex(m => String(m.content || '').includes('第二句'));
        expect(secondUserIdx).toBeGreaterThan(0);
        expect(absIdx).toBeGreaterThan(0);
        // depth=1 → 落在最后一条历史（第二句）之前
        expect(absIdx).toBe(secondUserIdx - 1);
        expect(msgs[absIdx].role).toBe('system');

        const tail = String(msgs[msgs.length - 1]?.content || '');
        expect(tail).toContain('AFTER_MARK');
        // 钢印「回到你自己」仍是最后（after 组排它前面）
        const afterPos = tail.indexOf('AFTER_MARK');
        const steelPos = tail.indexOf('回到你自己');
        expect(steelPos).toBeGreaterThan(-1);
        expect(afterPos).toBeLessThan(steelPos);
    });

    it('无 absolute/after 条目时消息结构与旧版一致', async () => {
        const now = Date.now();
        await DB.savePresetPack({
            id: 'pay-empty', name: 'E', createdAt: now, updatedAt: now, entryIds: [],
        });
        await DB.setActivePackId('pay-empty');
        const payload = await buildChatRequestPayload(baseInput());
        // [stable, 3 history, volatileTail]
        expect(payload.fullMessages).toHaveLength(5);
        expect(payload.fullMessages[0].role).toBe('system');
    });
});
