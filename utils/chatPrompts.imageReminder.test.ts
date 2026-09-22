import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';

// 生图规则有两层：
//   1. 常驻硬规则（明确要图必须真的发，只嘴上答应算没做到）；
//   2. 「本轮提醒」——只在发送时刻最后一条用户消息像是在要图时追加，fire_pack 烘焙
//      模板不吃（它到点不是回复用户，拿错上下文只会误导）。
// 提醒判据见 utils/imageRequestIntent.ts。

const char = { id: 'char-img', name: '小画' } as any;
const userProfile = { name: '小明' } as any;

const userMsg = (content: string) => ({
    id: 1, charId: char.id, role: 'user', type: 'text', content, timestamp: Date.now(),
}) as any;

const buildStable = async (
    currentMsgs: any[],
    promptOptions?: { forFirePack?: boolean; timelyByWorker?: boolean },
) => {
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], currentMsgs,
        undefined, undefined, undefined, undefined, undefined, undefined,
        promptOptions,
    );
    return parts.stable;
};

describe('行为规范 · 要图硬规则与本轮提醒', () => {
    it('常驻规则里有「明确要图必须真的发」的硬要求', async () => {
        const stable = await buildStable([]);
        expect(stable).toContain('对方明确要照片 / 自拍 / 画图时，这一轮必须真的发出来');
        expect(stable).toContain('[[GEN_IMAGE:');
    });

    it('最后一条用户消息在要图 → 追加本轮硬提醒', async () => {
        const stable = await buildStable([userMsg('今天天气不错'), userMsg('给我发个自拍')]);
        expect(stable).toContain('【本轮提醒】对方刚在要图');
        expect(stable).toContain('不要只回「拍好了」');
    });

    it('普通聊天不追加提醒', async () => {
        const stable = await buildStable([userMsg('今天好累')]);
        expect(stable).not.toContain('【本轮提醒】对方刚在要图');
    });

    it('fire_pack（主动消息模板）不吃这个提醒', async () => {
        const stable = await buildStable([userMsg('给我发个自拍')], { forFirePack: true });
        expect(stable).not.toContain('【本轮提醒】对方刚在要图');
    });

    it('即时对话（timelyByWorker）照吃提醒', async () => {
        const stable = await buildStable([userMsg('发张照片给我看看')], { timelyByWorker: true });
        expect(stable).toContain('【本轮提醒】对方刚在要图');
    });
});
