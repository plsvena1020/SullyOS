import { describe, expect, it } from 'vitest';
import type { PromptPreset } from '../types';
import { DB } from './db';
import { resolveActivePackEntries, tagsMatch } from './presetKits';

const row = (over: Partial<PromptPreset> & { id: string }): PromptPreset => ({
    name: over.id, content: 'x', order: 0, enabled: true,
    createdAt: 1, updatedAt: 2, ...over,
});

describe('tagsMatch', () => {
    it('空 tags 全场景通过', () => {
        expect(tagsMatch(undefined, ['chat'])).toBe(true);
        expect(tagsMatch([], ['date'])).toBe(true);
    });
    it('非空要求全包含', () => {
        expect(tagsMatch(['chat', 'date'], ['chat', 'date'])).toBe(true);
        expect(tagsMatch(['chat', 'date'], ['chat'])).toBe(false);
    });
});

describe('resolveActivePackEntries', () => {
    it('顺序/过滤/分组一次到位', async () => {
        await DB.savePromptPreset(row({ id: 'res-s1', content: '稳定一' }));
        await DB.savePromptPreset(row({ id: 'res-s2', content: '稳定二' }));
        await DB.savePromptPreset(row({ id: 'res-after', content: '历史后', afterChatHistory: true }));
        await DB.savePromptPreset(row({
            id: 'res-abs', content: '绝对深度', injectionPosition: 'absolute', injectionDepth: 2,
        }));
        await DB.savePromptPreset(row({ id: 'res-date', content: '约会限定', tags: ['date'] }));
        await DB.savePromptPreset(row({ id: 'res-off', content: '关', enabled: false }));
        await DB.savePromptPreset(row({ id: 'res-empty', content: '  ' }));
        await DB.savePromptPreset(row({ id: 'res-marker', content: '', marker: 'chatHistory' }));
        const now = Date.now();
        await DB.savePresetPack({
            id: 'res-pack', name: 'R', createdAt: now, updatedAt: now,
            entryIds: ['res-s2', 'res-missing', 'res-s1', 'res-after', 'res-abs',
                'res-date', 'res-off', 'res-empty', 'res-marker'],
        });
        await DB.setActivePackId('res-pack');

        const chat = await resolveActivePackEntries(['chat']);
        expect(chat.stable.map((e) => e.id)).toEqual(['res-s2', 'res-s1']);
        expect(chat.afterHistory.map((e) => e.id)).toEqual(['res-after']);
        expect(chat.absolute.map((e) => e.id)).toEqual(['res-abs']);
        expect(chat.absolute[0].injectionDepth).toBe(2);
        expect(chat.absolute[0].role).toBe('system');

        const date = await resolveActivePackEntries(['chat', 'date']);
        expect(date.stable.map((e) => e.id)).toEqual(['res-s2', 'res-s1', 'res-date']);

        await DB.setActivePackId('default');
    });

    it('active 指向不存在的套组返回空三组', async () => {
        await DB.setActivePackId('res-no-such-pack');
        expect(await resolveActivePackEntries()).toEqual({ stable: [], afterHistory: [], absolute: [] });
        await DB.setActivePackId('default');
    });
});
