import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

const char = { id: 'char-kit', name: '阿套' } as any;
const userProfile = { name: '小明' } as any;

const row = (over: any) => ({
    name: over.id, content: 'x', order: 0, enabled: true,
    createdAt: 1, updatedAt: 2, ...over,
});

const seedKit = async () => {
    await DB.savePromptPreset(row({ id: 'kp-stable', name: '写作风格', content: '短句，多分段。' }));
    await DB.savePromptPreset(row({ id: 'kp-after', name: '临场提醒', content: '开口前先深呼吸。', afterChatHistory: true }));
    await DB.savePromptPreset(row({
        id: 'kp-abs', name: '耳语', content: '记住：她怕黑。',
        injectionPosition: 'absolute', injectionDepth: 1,
    }));
    await DB.savePromptPreset(row({ id: 'kp-date', name: '约会限定', content: '约会时才说。', tags: ['date'] }));
    const now = Date.now();
    await DB.savePresetPack({
        id: 'kp-pack', name: 'K', createdAt: now, updatedAt: now,
        entryIds: ['kp-stable', 'kp-after', 'kp-abs', 'kp-date'],
    });
    await DB.setActivePackId('kp-pack');
};

const build = (promptOptions?: any) => ChatPrompts.buildSystemPromptParts(
    char, userProfile, [], [], [], [],
    undefined, undefined, undefined, undefined, undefined, undefined,
    promptOptions,
);

describe('预设套组注入（Preset Kit）', () => {
    it('stable 组按旧格式拼进 stable；after/absolute 带出；date 条目被滤掉', async () => {
        await seedKit();
        const parts = await build();
        // 旧格式逐字一致：【名】\n正文
        expect(parts.stable).toContain('【写作风格】\n短句，多分段。');
        expect(parts.stable).not.toContain('临场提醒');
        expect(parts.stable).not.toContain('约会时才说');
        expect(parts.presetAfterHistory).toContain('【临场提醒】\n开口前先深呼吸。');
        expect(parts.presetAbsolute).toEqual([
            { role: 'system', content: '记住：她怕黑。', depth: 1 },
        ]);
    });

    it('activeTags=[chat,date] 时约会条目进入 stable', async () => {
        await seedKit();
        const parts = await build({ activeTags: ['chat', 'date'] });
        expect(parts.stable).toContain('【约会限定】\n约会时才说。');
    });

    it('forFirePack 时三处全空，stable 不带套组', async () => {
        await seedKit();
        const parts = await build({ forFirePack: true });
        expect(parts.stable).not.toContain('写作风格');
        expect(parts.presetAfterHistory).toBe('');
        expect(parts.presetAbsolute).toEqual([]);
    });

    it('条目里的宏按本轮上下文展开', async () => {
        await DB.savePromptPreset(row({
            id: 'kp-macro', name: '宏', content: '{{char}}记得{{user}}说过{{lastUser}}',
        }));
        const now = Date.now();
        await DB.savePresetPack({
            id: 'kp-macro-pack', name: 'M', createdAt: now, updatedAt: now,
            entryIds: ['kp-macro'],
        });
        await DB.setActivePackId('kp-macro-pack');
        const parts = await ChatPrompts.buildSystemPromptParts(
            char, userProfile, [], [], [],
            [{ role: 'user', content: '明天见' } as any],
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined,
        );
        expect(parts.stable).toContain('【宏】\n阿套记得小明说过明天见');
    });
});
