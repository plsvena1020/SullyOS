import { afterEach, describe, expect, it } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { setGenieVoiceEnabled, setTtsProvider, setVoicePromptOverrides } from './ttsProvider';

const userProfile = { name: '测试用户' } as any;
const GENIE_CUE_RULE = '- <语音> 里不要写括号动作；Genie 不支持，会在发送前剥掉。';
const LEGACY_LANG_CUE_RULE = '- <语音> 里想要笑、叹气等真实语气用官方英文标签 (laughs)/(sighs)/(chuckle)/(gasps) 等，**不要写中文（轻笑）这类舞台指示**（中文括号会被直接删掉、不朗读）';
const LEGACY_DEFAULT_CUE_RULE = '- <语音> 里只写会被朗读的文字，不要写中文舞台指示/括号动作；想要笑、叹气等真实语气，用官方英文标签 (laughs)/(sighs)/(chuckle)/(gasps) 等（中文括号会被直接删掉、不朗读）';

type Provider = 'minimax' | 'fishaudio' | 'elevenlabs';
const providers: Provider[] = ['minimax', 'fishaudio', 'elevenlabs'];
const legacyCases: Array<[Provider, string, string]> = [];
const genieCases: Array<[Provider, string]> = [];
for (const provider of providers) {
    legacyCases.push([provider, '', LEGACY_DEFAULT_CUE_RULE]);
    legacyCases.push([provider, 'en', LEGACY_LANG_CUE_RULE]);
    genieCases.push([provider, '']);
    genieCases.push([provider, 'en']);
}

const buildVoicePrompt = async (provider: Provider, chatVoiceLang: string, genie: boolean) => {
    setTtsProvider(provider);
    setGenieVoiceEnabled(genie);
    setVoicePromptOverrides(undefined);
    const char = {
        id: `voice-cue-${provider}-${chatVoiceLang || 'default'}`,
        name: '测试角色',
        chatVoiceEnabled: true,
        chatVoiceLang,
    } as any;
    const parts = await ChatPrompts.buildSystemPromptParts(
        char, userProfile, [], [], [], [],
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    );
    return parts.stable;
};

afterEach(() => {
    setTtsProvider('minimax');
    setGenieVoiceEnabled(false);
    setVoicePromptOverrides(undefined);
});

describe('chat voice cue rules', () => {
    it.each(legacyCases)('Genie 关闭时 %s / %s 保留对应 legacy cue', async (provider, lang, expected) => {
        const prompt = await buildVoicePrompt(provider, lang, false);
        expect(prompt).toContain(expected);
        expect(prompt).not.toContain(GENIE_CUE_RULE);
    });

    it.each(genieCases)('Genie 开启时 %s / %s 使用 Genie cue', async (provider, lang) => {
        const prompt = await buildVoicePrompt(provider, lang, true);
        expect(prompt).toContain(GENIE_CUE_RULE);
        expect(prompt).not.toContain(LEGACY_LANG_CUE_RULE);
        expect(prompt).not.toContain(LEGACY_DEFAULT_CUE_RULE);
    });
});
