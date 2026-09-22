import { describe, expect, it } from 'vitest';
import type { PresetPack, PromptPreset } from '../types';
import { exportPresetKit, parsePresetKitShare, PRESET_KIT_SCHEMA } from './presetKitShare';

const pack: PresetPack = {
    id: 'p1', name: '分享包', entryIds: ['e1', 'e2', 'missing'],
    generation: { temperature: 0.7, maxTokens: 4000 },
    createdAt: 1, updatedAt: 2,
};
const entries: PromptPreset[] = [
    {
        id: 'e1', name: '风格', content: '短句。', order: 1, enabled: true,
        createdAt: 1, updatedAt: 2, identifier: 'style',
        role: 'system', injectionPosition: 'relative', afterChatHistory: false,
        tags: ['chat'],
    },
    {
        id: 'e2', name: '耳语', content: '悄悄话', order: 2, enabled: false,
        createdAt: 1, updatedAt: 2,
        role: 'assistant', injectionPosition: 'absolute', injectionDepth: 1,
    },
];

describe('presetKitShare', () => {
    it('导出→解析 round-trip，顺序与字段保留，失配引用丢弃', () => {
        const json = exportPresetKit(pack, entries, null);
        const parsed = parsePresetKitShare(json);
        expect(parsed.packName).toBe('分享包');
        expect(parsed.generation).toEqual({ temperature: 0.7, maxTokens: 4000 });
        // entryIds 里的 missing 引用被丢弃
        expect(parsed.entryKeys).toEqual(['style', 'entry_1']);
        expect(parsed.entries).toHaveLength(2);
        expect(parsed.entries[1]).toMatchObject({
            key: 'entry_1', name: '耳语', role: 'assistant',
            injectionPosition: 'absolute', injectionDepth: 1,
        });
        expect(parsed.entries[0].tags).toEqual(['chat']);
        expect(parsed.regexKit).toBeNull();
    });

    it('坏输入抛中文错', () => {
        expect(() => parsePresetKitShare('not json')).toThrow('不是有效的 JSON 文件');
        expect(() => parsePresetKitShare('{"schema":"x","version":1}')).toThrow('schema 不匹配');
        expect(() => parsePresetKitShare(JSON.stringify({ schema: PRESET_KIT_SCHEMA, version: 999 })))
            .toThrow('不支持的分享版本');
    });

    it('导出 key 去重（identifier 冲突时后缀）', () => {
        const dup: PromptPreset[] = [
            { id: 'a', name: 'A', content: 'x', order: 0, enabled: true, createdAt: 0, updatedAt: 0, identifier: 'same' },
            { id: 'b', name: 'B', content: 'y', order: 1, enabled: true, createdAt: 0, updatedAt: 0, identifier: 'same' },
        ];
        const parsed = parsePresetKitShare(exportPresetKit(
            { id: 'p', name: 'D', entryIds: ['a', 'b'], createdAt: 0, updatedAt: 0 }, dup,
        ));
        expect(parsed.entryKeys).toEqual(['same', 'same_2']);
    });
});
