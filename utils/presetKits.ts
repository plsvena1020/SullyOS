/**
 * presetKits — 预设套组解析器（纯组装逻辑 + 薄 DB 读取）。
 *
 * resolveActivePackEntries(activeTags)：读 active 指针 → 按 entryIds 取条目 →
 * enabled / 非空 / tags / marker 四道过滤 → 按注入位分成 stable / afterHistory /
 * absolute 三组。调用方（chatPrompts）只管落位，不管排序过滤。
 */
import { DB } from './db';
import type { PresetGeneration, PromptPreset } from '../types';

export type PresetEntryRole = 'system' | 'user' | 'assistant';
export type PresetInjectionPosition = 'relative' | 'absolute';

/** 归一化后的条目：role/position/depth/afterChatHistory 必有值。 */
export type ResolvedPresetEntry = PromptPreset & {
    role: PresetEntryRole;
    injectionPosition: PresetInjectionPosition;
    injectionDepth: number;
    afterChatHistory: boolean;
    adopted: boolean; // sourceKey 行被接管才 true；其余 sourceKey 行不进三组
};

export interface ResolvedPackEntries {
    stable: ResolvedPresetEntry[];
    afterHistory: ResolvedPresetEntry[];
    absolute: ResolvedPresetEntry[];
}

const EMPTY: ResolvedPackEntries = { stable: [], afterHistory: [], absolute: [] };

/** tags 为空=全场景；非空要求 tags ⊆ activeTags（与参考仓库 getPromptTags 同口径）。 */
export function tagsMatch(entryTags: string[] | undefined, activeTags: string[]): boolean {
    if (!entryTags || entryTags.length === 0) return true;
    return entryTags.every((t) => activeTags.includes(t));
}

/** 当前生效套组的采样参数；无套组/无配置返回 undefined（调用方回退 API 设置）。 */
export async function getActivePackGeneration(): Promise<PresetGeneration | undefined> {
    try {
        const packId = await DB.getActivePackId();
        const packs = await DB.getPresetPacks();
        return packs.find((p) => p.id === packId)?.generation;
    } catch {
        return undefined;
    }
}

export function normalizePresetEntry(r: PromptPreset): ResolvedPresetEntry {
    return {
        ...r,
        role: r.role === 'user' || r.role === 'assistant' ? r.role : 'system',
        injectionPosition: r.injectionPosition === 'absolute' ? 'absolute' : 'relative',
        injectionDepth: Math.max(0, Math.floor(r.injectionDepth ?? 0)),
        afterChatHistory: r.afterChatHistory === true,
        adopted: false,
    };
}

export async function resolveActivePackEntries(activeTags: string[] = ['chat']): Promise<ResolvedPackEntries> {
    let packId: string;
    let packs: Awaited<ReturnType<typeof DB.getPresetPacks>>;
    let rows: Awaited<ReturnType<typeof DB.getPromptPresets>>;
    try {
        packId = await DB.getActivePackId();
        packs = await DB.getPresetPacks();
        rows = await DB.getPromptPresets();
    } catch {
        return EMPTY;
    }
    const pack = (packs || []).find((p) => p.id === packId);
    if (!pack) return EMPTY;
    const byId = new Map((rows || []).map((r) => [r.id, r]));
    const stable: ResolvedPresetEntry[] = [];
    const afterHistory: ResolvedPresetEntry[] = [];
    const absolute: ResolvedPresetEntry[] = [];
    // 接管行按目录序（行 order）排在同组自定义之后，先收进缓冲，最后拼接。
    const adoptedStable: ResolvedPresetEntry[] = [];
    const adoptedAfter: ResolvedPresetEntry[] = [];
    const adoptedAbsolute: ResolvedPresetEntry[] = [];
    for (const id of pack.entryIds || []) {
        const r = byId.get(id);
        if (!r) continue; // 失配引用丢弃
        if (!r.enabled) continue;
        if (!(r.content || '').trim()) continue; // 空段不注入（与旧行为一致）
        if (r.marker === 'chatHistory') continue; // 分界占位本身不注入
        if (!tagsMatch(r.tags, activeTags)) continue;
        if (r.sourceKey && r.adoptPosition !== 'stable' && r.adoptPosition !== 'afterHistory' && r.adoptPosition !== 'absolute') continue;
        const norm = normalizePresetEntry(r);
        if (r.sourceKey && (r.adoptPosition === 'stable' || r.adoptPosition === 'afterHistory' || r.adoptPosition === 'absolute')) {
            norm.adopted = true;
            if (r.adoptPosition === 'absolute') adoptedAbsolute.push(norm);
            else if (r.adoptPosition === 'afterHistory') adoptedAfter.push(norm);
            else adoptedStable.push(norm);
            continue;
        }
        if (norm.injectionPosition === 'absolute') absolute.push(norm);
        else if (norm.afterChatHistory) afterHistory.push(norm);
        else stable.push(norm);
    }
    // 同组自定义按 entryIds 序在前（上游已保序），接管按目录序（行 order）在后。
    const byOrder = (a: ResolvedPresetEntry, b: ResolvedPresetEntry) => a.order - b.order;
    // 同 depth 内保持套组顺序（稳定排序）；depth 小的离底越近先排。
    absolute.sort((a, b) => a.injectionDepth - b.injectionDepth);
    adoptedStable.sort(byOrder);
    adoptedAfter.sort(byOrder);
    adoptedAbsolute.sort(byOrder);
    return {
        stable: [...stable, ...adoptedStable],
        afterHistory: [...afterHistory, ...adoptedAfter],
        absolute: [...absolute, ...adoptedAbsolute],
    };
}
