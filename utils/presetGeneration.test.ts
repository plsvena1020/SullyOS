import { describe, expect, it } from 'vitest';
import { applyGenerationOverride } from './presetGeneration';

describe('applyGenerationOverride', () => {
    it('空 generation 原样回退', () => {
        const base = { temperature: 0.85, max_tokens: 8000 };
        expect(applyGenerationOverride(base, undefined)).toEqual(base);
        expect(applyGenerationOverride(base, null)).toEqual(base);
        expect(applyGenerationOverride(base, {})).toEqual(base);
    });

    it('逐项覆盖，缺项不动', () => {
        const out = applyGenerationOverride(
            { temperature: 0.85, max_tokens: 8000 },
            { temperature: 0.7, topP: 0.9, maxTokens: 4000 },
        );
        expect(out).toEqual({ temperature: 0.7, top_p: 0.9, max_tokens: 4000 });
    });

    it('非法值忽略', () => {
        const out = applyGenerationOverride(
            { temperature: 0.85 },
            { temperature: NaN, topP: Infinity, frequencyPenalty: 'x' as any },
        );
        expect(out).toEqual({ temperature: 0.85 });
    });

    it('omit 只留 temperature + max_tokens', () => {
        const out = applyGenerationOverride(
            { temperature: 0.85, top_p: 0.9, top_k: 40, frequency_penalty: 0.5, presence_penalty: 0.3, max_tokens: 8000 },
            { omitSamplingParams: true, temperature: 0.7, topP: 0.5, maxTokens: 2000 },
        );
        expect(out).toEqual({ temperature: 0.7, max_tokens: 2000 });
    });

    it('不污染输入对象', () => {
        const base = { temperature: 0.85 };
        const gen = { temperature: 0.7 };
        applyGenerationOverride(base, gen);
        expect(base).toEqual({ temperature: 0.85 });
        expect(gen).toEqual({ temperature: 0.7 });
    });
});
