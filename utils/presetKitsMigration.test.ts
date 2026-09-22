import { describe, expect, it } from 'vitest';
import type { PromptPreset } from '../types';
import { DB } from './db';
import { migrateToDefaultPack, DEFAULT_PACK_ID } from './presetKitsMigration';

const row = (over: Partial<PromptPreset> & { id: string }): PromptPreset => ({
    name: over.id, content: 'x', order: 0, enabled: true,
    createdAt: 1, updatedAt: 2, ...over,
});

describe('migrateToDefaultPack', () => {
    it('空表建空默认套组 + active 指针', async () => {
        const r = await migrateToDefaultPack();
        expect(r).toEqual({ created: true, entries: 0 });
        const packs = await DB.getPresetPacks();
        expect(packs.find((p) => p.id === DEFAULT_PACK_ID)).toMatchObject({
            name: '默认预设', entryIds: [],
        });
        expect(await DB.getActivePackId()).toBe(DEFAULT_PACK_ID);
    });

    it('旧自定义段落按 order 迁入，内置行不动，重跑幂等', async () => {
        await DB.deletePresetPack(DEFAULT_PACK_ID);
        await DB.savePromptPreset(row({ id: 'mig-b', content: '第二段', order: 20 }));
        await DB.savePromptPreset(row({ id: 'mig-a', content: '第一段', order: 5 }));
        await DB.savePromptPreset(row({ id: 'mig-off', content: '关掉的', order: 9, enabled: false }));
        await DB.savePromptPreset(row({ id: 'mig-empty', content: '   ', order: 1 }));
        await DB.savePromptPreset(row({
            id: 'mig-builtin', content: '钢印', order: 101,
            sourceKey: 'chat.steelExpression', category: 'chat',
        }));
        const r = await migrateToDefaultPack();
        expect(r.created).toBe(true);
        expect(r.entries).toBe(4);
        const pack = (await DB.getPresetPacks()).find((p) => p.id === DEFAULT_PACK_ID);
        // order 排序：empty(1) < a(5) < off(9) < b(20)，内置行不进套组
        expect(pack?.entryIds).toEqual(['mig-empty', 'mig-a', 'mig-off', 'mig-b']);
        const a = (await DB.getPromptPresets()).find((x) => x.id === 'mig-a');
        expect(a?.identifier).toBe('custom_mig-a');
        expect(a?.role).toBe('system');
        expect(a?.injectionPosition).toBe('relative');
        const builtin = (await DB.getPromptPresets()).find((x) => x.id === 'mig-builtin');
        expect(builtin?.identifier).toBeUndefined();
        // 重跑：幂等门
        expect(await migrateToDefaultPack()).toEqual({ created: false, entries: 0 });
    });
});
