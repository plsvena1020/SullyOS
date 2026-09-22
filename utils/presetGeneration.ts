/**
 * presetGeneration — 套组采样参数覆盖（纯函数）。
 *
 * applyGenerationOverride(base, gen)：active 套组的 generation 逐项覆盖请求体
 * 采样参数；缺项回退（不动 base）；omitSamplingParams=true 时只留
 * temperature + max_tokens（兼容酒馆高级参数报错的接口）。
 * 非法值（非数字/NaN/Infinity）一律忽略，不抛。
 */
import type { PresetGeneration } from '../types';

export interface GenerationBase {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens?: number;
}

const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export function applyGenerationOverride(
    base: GenerationBase,
    gen?: PresetGeneration | null,
): GenerationBase {
    if (!gen) return { ...base };
    const out: GenerationBase = { ...base };
    if (gen.omitSamplingParams === true) {
        delete out.top_p;
        delete out.top_k;
        delete out.frequency_penalty;
        delete out.presence_penalty;
        const t = num(gen.temperature);
        if (t !== undefined) out.temperature = t;
        const m = num(gen.maxTokens);
        if (m !== undefined) out.max_tokens = m;
        return out;
    }
    const t = num(gen.temperature);
    if (t !== undefined) out.temperature = t;
    const tp = num(gen.topP);
    if (tp !== undefined) out.top_p = tp;
    const tk = num(gen.topK);
    if (tk !== undefined) out.top_k = tk;
    const fp = num(gen.frequencyPenalty);
    if (fp !== undefined) out.frequency_penalty = fp;
    const pp = num(gen.presencePenalty);
    if (pp !== undefined) out.presence_penalty = pp;
    const m = num(gen.maxTokens);
    if (m !== undefined) out.max_tokens = m;
    return out;
}
