import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyAssistantPostProcessing, type PostProcessCtx, type XhsCaches } from './applyAssistantPostProcessing';
import { buildChatRequestPayload, type BuildChatPayloadInput } from './chatRequestPayload';
import { ChatPrompts } from './chatPrompts';
import { RealtimeContextManager } from './realtimeContext';
import { DB } from './db';
import { invalidatePresetRegexCache } from './presetRegex';

// 正则三处接线（输出 / 输入 / 发给模型）一次验完。

const seedKit = async (rules: any[]) => {
    const now = Date.now();
    await DB.savePresetRegex({
        id: 'wire-kit', name: 'W', enabled: true, rules,
        createdAt: now, updatedAt: now,
    });
    invalidatePresetRegexCache();
};

const makeCtx = (charId: string): PostProcessCtx => {
    const xhsCaches: XhsCaches = {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
    };
    return {
        char: { id: charId, name: '正则酱' } as any,
        userProfile: { name: '我' } as any,
        emojis: [],
        contextMsgs: [],
        fullMessages: [],
        initialData: {},
        historyMsgCount: 0,
        xhsCaches,
        api: {
            baseUrl: 'http://localhost:0',
            headers: {},
            effectiveApi: { baseUrl: 'http://localhost:0', apiKey: '', model: 'test' },
        },
        hooks: { setMessages: vi.fn(), addToast: vi.fn() },
    };
};

describe('presetRegex 接线', () => {
    it('输出侧 placement=2：气泡落库已被替换', async () => {
        await seedKit([{
            id: 'w1', scriptName: '猫狗', findRegex: '猫', replaceString: '狗',
            placement: [2], disabled: false,
        }]);
        const charId = `c-regex-out-${Date.now()}`;
        await applyAssistantPostProcessing('今天看到一只猫', makeCtx(charId));
        const msgs = await DB.getRecentMessagesByCharId(charId, 10);
        const texts = msgs.filter(m => m.role === 'assistant' && m.type === 'text');
        expect(texts.length).toBe(1);
        expect(texts[0].content).toBe('今天看到一只狗');
    }, 20000);

    it('输入侧 placement=1：只改发给模型的最后 user 消息，不写回 DB', async () => {
        await seedKit([{
            id: 'w2', scriptName: '口癖', findRegex: '在吗', replaceString: '在的呢',
            placement: [1], disabled: false,
        }]);
        vi.spyOn(RealtimeContextManager, 'fetchWeather').mockResolvedValue(null as any);
        vi.spyOn(RealtimeContextManager, 'fetchNews').mockResolvedValue([] as any);
        try {
            const input: BuildChatPayloadInput = {
                char: { id: 'char-regex-in', name: '正则酱' } as any,
                userProfile: { name: '我' } as any,
                groups: [], emojis: [], categories: [],
                historyMsgs: [
                    { id: 1, charId: 'char-regex-in', role: 'user', type: 'text', content: '在吗', timestamp: 100 },
                ] as any[],
                contextLimit: 20,
                realtimeConfig: { weatherEnabled: false, newsEnabled: false } as any,
            };
            const payload = await buildChatRequestPayload(input);
            const lastUser = [...payload.fullMessages].reverse()
                .find(m => m.role === 'user' && typeof m.content === 'string');
            expect(String(lastUser?.content || '')).toContain('在的呢');
        } finally {
            vi.restoreAllMocks();
        }
    });

    it('prompt 侧 placement=5：套组条目发给模型前被替换', async () => {
        await seedKit([{
            id: 'w3', scriptName: '语气', findRegex: '必须', replaceString: '请尽量',
            placement: [5], disabled: false,
        }]);
        const now = Date.now();
        await DB.savePromptPreset({
            id: 'wire-entry', name: '规则', content: '你必须简短。', order: 0,
            enabled: true, createdAt: now, updatedAt: now,
        } as any);
        await DB.savePresetPack({
            id: 'wire-pack', name: 'W', entryIds: ['wire-entry'],
            createdAt: now, updatedAt: now,
        });
        await DB.setActivePackId('wire-pack');
        try {
            const parts = await ChatPrompts.buildSystemPromptParts(
                { id: 'c', name: '酱' } as any, { name: '我' } as any,
                [], [], [], [],
                undefined, undefined, undefined, undefined, undefined, undefined,
                undefined,
            );
            expect(parts.stable).toContain('【规则】\n你请尽量简短。');
        } finally {
            await DB.setActivePackId('default');
        }
    });
});

beforeEach(() => {
    invalidatePresetRegexCache();
});

afterEach(() => {
    vi.restoreAllMocks();
});
