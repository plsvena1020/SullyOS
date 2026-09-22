import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from './db';
import { seedBuiltinPromptPresets, repairCorruptedBuiltinNames } from './promptPresetSeeding';
import { BUILTIN_PROMPT_ENTRIES, getBuiltinEntry } from './promptPresetCatalog';
import type { PromptPreset } from '../types';

const STEEL_KEY = 'chat.steelExpression';
const TYPO_NAME = '记忆消化 · 认知风风风风判定';

const makeRow = (
    overrides: Partial<PromptPreset> & Pick<PromptPreset, 'id' | 'name' | 'content' | 'order'>,
): PromptPreset => ({
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
});

describe('提示词播种对账（并发去重 / 历史合并 / 错名修复）', () => {
    beforeEach(async () => {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('prompt_presets', 'readwrite');
            tx.objectStore('prompt_presets').clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    });

    it('并发播种不会产生重复行：每个 sourceKey 恰好一行', async () => {
        await Promise.all([seedBuiltinPromptPresets(), seedBuiltinPromptPresets(), seedBuiltinPromptPresets()]);
        const rows = await DB.getPromptPresets();
        expect(rows).toHaveLength(BUILTIN_PROMPT_ENTRIES.length);
        const keys = rows.map((r) => r.sourceKey);
        expect(new Set(keys).size).toBe(BUILTIN_PROMPT_ENTRIES.length);
    });

    it('历史重复行在播种时合并：保留用户改过的那行', async () => {
        const builtin = getBuiltinEntry(STEEL_KEY)!;
        await DB.savePromptPreset(makeRow({
            id: 'dup-a', sourceKey: STEEL_KEY, category: 'chat',
            name: builtin.name, content: builtin.content, order: builtin.order,
            createdAt: 100, updatedAt: 100,
        }));
        await DB.savePromptPreset(makeRow({
            id: 'dup-b', sourceKey: STEEL_KEY, category: 'chat',
            name: builtin.name, content: '我的自定义表达规则', order: builtin.order,
            createdAt: 200, updatedAt: 500,
        }));
        await seedBuiltinPromptPresets();
        const rows = (await DB.getPromptPresets()).filter((r) => r.sourceKey === STEEL_KEY);
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toBe('我的自定义表达规则');
    });

    it('历史重复行都没动过时保留最早创建的那行；组内停用会保持停用', async () => {
        const builtin = getBuiltinEntry(STEEL_KEY)!;
        await DB.savePromptPreset(makeRow({
            id: 'dup-late', sourceKey: STEEL_KEY,
            name: builtin.name, content: builtin.content, order: builtin.order,
            createdAt: 900, updatedAt: 900,
        }));
        await DB.savePromptPreset(makeRow({
            id: 'dup-early', sourceKey: STEEL_KEY,
            name: builtin.name, content: builtin.content, order: builtin.order,
            createdAt: 100, updatedAt: 100, enabled: false,
        }));
        await seedBuiltinPromptPresets();
        const rows = (await DB.getPromptPresets()).filter((r) => r.sourceKey === STEEL_KEY);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('dup-early');
        expect(rows[0].enabled).toBe(false);
    });

    it('重复播种不覆盖用户的编辑、启停与排序', async () => {
        await seedBuiltinPromptPresets();
        const target = (await DB.getPromptPresets()).find((r) => r.sourceKey === STEEL_KEY)!;
        await DB.savePromptPreset({ ...target, name: '我的钢印', content: '只属于我的规则', enabled: false, order: 999 });
        await seedBuiltinPromptPresets();
        const rows = await DB.getPromptPresets();
        expect(rows).toHaveLength(BUILTIN_PROMPT_ENTRIES.length);
        const after = rows.find((r) => r.sourceKey === STEEL_KEY)!;
        expect(after).toMatchObject({ name: '我的钢印', content: '只属于我的规则', enabled: false, order: 999 });
    });

    it('无 sourceKey 的自定义行不受影响、不参与合并', async () => {
        await DB.savePromptPreset(makeRow({ id: 'custom-1', name: '我的段落', content: '自定义', order: 50 }));
        await DB.savePromptPreset(makeRow({ id: 'custom-2', name: '我的段落', content: '自定义', order: 51 }));
        await Promise.all([seedBuiltinPromptPresets(), seedBuiltinPromptPresets()]);
        const rows = await DB.getPromptPresets();
        expect(rows).toHaveLength(BUILTIN_PROMPT_ENTRIES.length + 2);
        expect(rows.filter((r) => r.id.startsWith('custom-'))).toHaveLength(2);
    });

    it('错名修复幂等，且不碰用户自改的名字', async () => {
        const builtin = getBuiltinEntry('memory.personalityDetect')!;
        await DB.savePromptPreset(makeRow({
            id: 'bad-name', sourceKey: 'memory.personalityDetect', category: 'memory',
            name: TYPO_NAME, content: builtin.content, order: builtin.order,
        }));
        await DB.savePromptPreset(makeRow({
            id: 'user-named', sourceKey: 'song.craftRules', category: 'song',
            name: '我自己起的名字', content: '我改过的内容', order: 301,
        }));
        await repairCorruptedBuiltinNames();
        await repairCorruptedBuiltinNames();
        const rows = await DB.getPromptPresets();
        expect(rows.find((r) => r.id === 'bad-name')!.name).toBe(builtin.name);
        expect(rows.find((r) => r.id === 'user-named')!.name).toBe('我自己起的名字');
    });
});
