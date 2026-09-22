import { describe, expect, it } from 'vitest';
import type { PresetPack } from '../types';
import { DB } from './db';
import { getActivePackGeneration } from './presetKits';

describe('preset_packs / active / regexes 存取', () => {
    it('pack 存取 round-trip', async () => {
        const pack: PresetPack = {
            id: 'kit-crud-pack', name: 'CRUD', entryIds: ['a', 'b'],
            generation: { temperature: 0.8, maxTokens: 2000 },
            createdAt: 10, updatedAt: 20,
        };
        await DB.savePresetPack(pack);
        const packs = await DB.getPresetPacks();
        expect(packs.find((p) => p.id === 'kit-crud-pack')).toMatchObject({
            name: 'CRUD', entryIds: ['a', 'b'],
        });
        await DB.deletePresetPack('kit-crud-pack');
        expect((await DB.getPresetPacks()).some((p) => p.id === 'kit-crud-pack')).toBe(false);
    });

    it('active 缺省回 default，设置后读回', async () => {
        // 本文件 DB 起空：先删可能残留的 active（同文件内用例共享库）
        expect(await DB.getActivePackId()).toBe('default');
        await DB.setActivePackId('kit-crud-other');
        expect(await DB.getActivePackId()).toBe('kit-crud-other');
        await DB.setActivePackId('default');
        expect(await DB.getActivePackId()).toBe('default');
    });

    it('regex kit 存取 round-trip', async () => {
        await DB.savePresetRegex({
            id: 'kit-crud-regex', name: 'R', enabled: true,
            rules: [{
                id: 'r1', scriptName: '去标签', findRegex: '<[^>]+>', replaceString: '',
                placement: [2], disabled: false,
            }],
            createdAt: 1, updatedAt: 2,
        });
        const kits = await DB.getPresetRegexes();
        expect(kits.find((k) => k.id === 'kit-crud-regex')?.rules).toHaveLength(1);
        await DB.deletePresetRegex('kit-crud-regex');
        expect((await DB.getPresetRegexes()).some((k) => k.id === 'kit-crud-regex')).toBe(false);
    });

    it('getActivePackGeneration 读当前套组参数，无配置回 undefined', async () => {
        await DB.savePresetPack({
            id: 'kit-gen-pack', name: 'G', entryIds: [],
            generation: { temperature: 0.6 },
            createdAt: 1, updatedAt: 2,
        });
        await DB.setActivePackId('kit-gen-pack');
        expect(await getActivePackGeneration()).toEqual({ temperature: 0.6 });
        await DB.setActivePackId('default');
        expect(await getActivePackGeneration()).toBeUndefined();
        await DB.deletePresetPack('kit-gen-pack');
    });
});
