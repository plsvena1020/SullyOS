import { describe, expect, it } from 'vitest';
import type { PromptPreset } from '../types';
import { DB } from './db';
import { resolveActivePackEntries, tagsMatch } from './presetKits';
import { ChatPrompts } from './chatPrompts';
import { invalidatePromptPresetCache } from './promptPresetRuntime';

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

    it('skips sourceKey rows unless adopted', async () => {
        await DB.savePromptPreset(row({ id: 'sk-builtin', content: 'B', sourceKey: 'chat.steelExpression' }));
        await DB.savePromptPreset(row({ id: 'sk-c1', content: 'C1', afterChatHistory: true }));
        await DB.savePromptPreset(row({
            id: 'sk-adopt', name: '接管', content: 'A',
            sourceKey: 'chat.steelYourself', adoptPosition: 'afterHistory',
        }));
        const now = Date.now();
        await DB.savePresetPack({
            id: 'sk-pack', name: 'S', createdAt: now, updatedAt: now,
            // 接管行在 entryIds 里排第一也必须沉底：同组自定义在前，接管按 order 在后
            entryIds: ['sk-adopt', 'sk-builtin', 'sk-c1'],
        });
        await DB.setActivePackId('sk-pack');

        const got = await resolveActivePackEntries(['chat']);
        const allIds = [...got.stable, ...got.afterHistory, ...got.absolute].map((e) => e.id);
        expect(allIds).not.toContain('sk-builtin');
        expect(got.afterHistory.map((e) => e.id)).toEqual(['sk-c1', 'sk-adopt']);
        expect(got.afterHistory.map((e) => e.adopted)).toEqual([false, true]);

        await DB.setActivePackId('default');
    });

    it('never double-injects adopted steel (pipeline once, recencyTail absent)', async () => {
        const CONTENT = 'ADOPTED_STEEL_ONCE_7f3a';
        await DB.savePromptPreset(row({
            id: 'sk-steel-adopt', name: '钢印接管', content: CONTENT,
            sourceKey: 'chat.steelYourself', adoptPosition: 'afterHistory',
        }));
        const now = Date.now();
        await DB.savePresetPack({
            id: 'sk-steel-pack', name: 'S', createdAt: now, updatedAt: now,
            entryIds: ['sk-steel-adopt'],
        });
        await DB.setActivePackId('sk-steel-pack');
        invalidatePromptPresetCache();
        const parts = await ChatPrompts.buildSystemPromptParts(
            { id: 'c', name: '阿套' } as any, { name: '小明' } as any,
            [], [], [], [],
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined,
        );
        const countIn = (s: string) => s.split(CONTENT).length - 1;
        // 管道里恰好一次，且原生 recencyTail 里没有（否则就是双重注入）
        expect(parts.presetAfterHistory).toContain('【钢印接管】');
        expect(countIn(parts.presetAfterHistory)).toBe(1);
        expect(countIn(parts.recencyTail)).toBe(0);
        expect(countIn(parts.stable)).toBe(0);

        await DB.setActivePackId('default');
        invalidatePromptPresetCache();
    });
});
