// utils/presetEffective.ts
// 每角色生效清单的判据（纯函数）：Task 9/12 消费。
//
// 直接复用真实注入同源的输入——同 char 字段（chatVoiceEnabled / dateVoiceEnabled /
// dateStyleConfig.digDeeper / perspectiveEnabled）、同 getTtsProvider()、同 Task 2 的
// adopted 语义（ResolvedPresetEntry.adopted，或 sourceKey 行的 adoptPosition 落位）。
// Async 的 resolve* 本体在这里不直接调用（同步纯判据）：enabled/停用语义与它们逐条对齐——
// resolveVoiceGuide(Sync) 停用→null→调用方 ?? 内置（= on-fallback，见 chatPrompts
// resolveVoiceActingGuide / datePrompts voice.date 行）；resolveTechnicalPrompt(Sync)
// 停用→回退内置（= on-fallback）；resolveManagedPrompt(Sync)/resolveSteel 停用→null
// 不注入（= off-disabled）。零平行逻辑：门控字段与注入点读的是同一批字段。
import { getTtsProvider } from './ttsProvider';
import type { PromptPreset, TtsProvider } from '../types';

export type EffectiveState =
    | 'on'
    | 'on-fallback'
    | 'on-adopted'
    | 'off'
    | 'off-disabled'
    | 'off-tags'
    | 'off-char'
    | 'off-scene'
    | 'dead';

export interface EffectiveStatus {
    state: EffectiveState;
    reason: string;
    adopted: boolean;
}

export interface EffectiveChar {
    chatVoiceEnabled?: boolean;
    dateVoiceEnabled?: boolean;
    perspectiveEnabled?: boolean;
    dateStyleConfig?: { digDeeper?: boolean };
}

export interface EffectiveCtx {
    char: EffectiveChar;
    provider?: TtsProvider;
    activeTags?: string[];
}

/** Task 2 的接管行也可能是裸 PromptPreset（只有 adoptPosition）——两种形态都认。 */
export type EffectiveEntry = PromptPreset & { adopted?: boolean };

const isAdoptedPosition = (p: PromptPreset['adoptPosition']): boolean =>
    p === 'stable' || p === 'afterHistory' || p === 'absolute';

// chatPrompts resolveVoiceActingGuide 的四选一：provider→sourceKey。
const VOICE_ROWS: Record<string, TtsProvider> = {
    'voice.minimax': 'minimax',
    'voice.fish': 'fishaudio',
    'voice.elevenlabsV3': 'elevenlabs',
    'voice.elevenlabsStd': 'elevenlabs',
};

// 停用回退内置的技术模板：memory.* 全系、rel.genGuide、amsg.emotionEval（主模板）。
// 注意 amsg.emotionEvalMindful/Living 不在此列——它们走 dead（见下）。
const isTechnicalFallbackRow = (sourceKey: string): boolean =>
    sourceKey === 'amsg.emotionEval'
    || sourceKey === 'rel.genGuide'
    || sourceKey.startsWith('memory.');

// tags ⊆ activeTags（与 presetKits.tagsMatch 同口径）；空=全场景。
const tagsMatch = (entryTags: string[] | undefined, activeTags: string[]): boolean => {
    if (!entryTags || entryTags.length === 0) return true;
    return entryTags.every((t) => activeTags.includes(t));
};

// v1 未接线的场景 tags：phone/story/memory（接线另立项，接上即自动生效）。
const UNWIRED_SCENE_TAGS = ['phone', 'story', 'memory'];

export function effectiveStatus(entry: EffectiveEntry, ctx: EffectiveCtx): EffectiveStatus {
    const key = entry.sourceKey;
    const char = ctx?.char ?? ({} as EffectiveChar);
    const provider = ctx?.provider ?? getTtsProvider();
    const activeTags = ctx?.activeTags ?? ['chat'];

    // amsg.emotionEvalMindful/Living：useChatAI 的 scheduleStyle 分支（约 164-167 行）
    // 仍是硬编码文案、不读这两行（Task 9 附带修复接活前）——无消费点。
    if (key === 'amsg.emotionEvalMindful' || key === 'amsg.emotionEvalLiving') {
        return { state: 'dead', reason: '无消费点', adopted: false };
    }

    const adopted = entry.adopted === true || isAdoptedPosition(entry.adoptPosition);
    const adoptedNote = adopted && entry.adoptPosition && entry.adoptPosition !== 'native'
        ? `（${entry.adoptPosition}）`
        : '';

    if (!entry.enabled) {
        // 语音行停用→调用方 ?? 内置仍注入；技术模板停用→回退内置：都是 on-fallback。
        if ((key && (key in VOICE_ROWS || key === 'voice.date')) || (key && isTechnicalFallbackRow(key))) {
            return { state: 'on-fallback', reason: '生效·兜底内置', adopted: false };
        }
        if (!key) return { state: 'off', reason: '已停用', adopted: false };
        return { state: 'off-disabled', reason: '已停用', adopted: false };
    }

    // 语音四条：先供应商、再角色开关（与 resolveVoiceActingGuide 的选择顺序一致）。
    if (key && key in VOICE_ROWS) {
        if (VOICE_ROWS[key] !== provider) {
            return { state: 'off-char', reason: `供应商不匹配（当前 ${provider}）`, adopted: false };
        }
        if (char.chatVoiceEnabled !== true) {
            return { state: 'off-char', reason: '该角色未开语音', adopted: false };
        }
        return { state: 'on', reason: '生效', adopted: false };
    }

    // voice.date：见面语音开关（datePrompts 630 行：关→整段不出；停用→ ?? 内置）。
    if (key === 'voice.date') {
        if (char.dateVoiceEnabled !== true) {
            return { state: 'off-char', reason: '该角色未开语音', adopted: false };
        }
        return { state: 'on', reason: '生效', adopted: false };
    }

    // date.digDeeper：dateStyleConfig.digDeeper === false 关（DateSettings 开关同源）。
    if (key === 'date.digDeeper') {
        if (char.dateStyleConfig?.digDeeper === false) {
            return { state: 'off-char', reason: '该角色已关闭深挖', adopted: false };
        }
        return { state: 'on', reason: '生效', adopted: false };
    }

    // chat.perspectiveTool：接管优先（原生点自动跳过）；否则看角色透视窗开关
    //（chatPrompts 858 行 perspectiveEnabled，另有全局端点门——见 registry 门，不在条目态里）。
    if (key === 'chat.perspectiveTool') {
        if (adopted) return { state: 'on-adopted', reason: `生效·已接管${adoptedNote}`, adopted: true };
        if (char.perspectiveEnabled !== true) {
            return { state: 'off-char', reason: '该角色未开透视窗', adopted: false };
        }
        return { state: 'on', reason: '生效', adopted: false };
    }

    // 钢印两条：接管走管道（原生 resolveSteel 返回 null）；native 走原生注入。
    if (key === 'chat.steelExpression' || key === 'chat.steelYourself') {
        if (adopted) return { state: 'on', reason: `生效·已接管${adoptedNote}`, adopted: true };
        return { state: 'on', reason: '生效', adopted: false };
    }

    // song.craftRules：写歌导师 prompt 常驻（停用→回退空串，已在 !enabled 分支处理）。
    if (key === 'song.craftRules') {
        return { state: 'on', reason: '生效', adopted: false };
    }

    // 技术模板启用态：独立 LLM 调用的整段模板，有启用即生效。
    if (key && isTechnicalFallbackRow(key)) {
        return { state: 'on', reason: '生效', adopted: false };
    }

    // 自定义行（含未来未知 sourceKey）：先判未接线场景，再判场景 tags。
    const tags = entry.tags ?? [];
    if (tags.some((t) => UNWIRED_SCENE_TAGS.includes(t))) {
        return { state: 'off-scene', reason: '该场景暂未接入', adopted: false };
    }
    if (!tagsMatch(tags, activeTags)) {
        return { state: 'off-tags', reason: '场景不含', adopted: false };
    }
    return { state: 'on', reason: '生效', adopted: false };
}
