/**
 * presetKits — 预设套组解析器（纯组装逻辑 + 薄 DB 读取）。
 *
 * resolveActivePackEntries(activeTags)：读 active 指针 → 按 entryIds 取条目 →
 * enabled / 非空 / tags / marker 四道过滤 → 按注入位分成 stable / afterHistory /
 * absolute 三组；再按行状态补收 adoptPosition 非 native 的 sourceKey 接管行
 * （不依赖 entryIds，切套组不丢），同组内排自定义之后（按行 order）。
 * 非接管 sourceKey 行在所有路径都不进三组。调用方（chatPrompts）只管落位，
 * 不管排序过滤。
 */
import { DB } from './db';
import { expandPromptMacros, type PromptMacroCtx } from './promptMacros';
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

/**
 * 共享条目渲染（主链路 stable/afterHistory/absolute 与 date/song 接线同源）：
 * content→trim→宏展开→placement=5 正则（仅发给模型）。
 *
 * 正则段走动态 import（presetRegex 反向依赖本模块的 tagsMatch，静态互引成环，
 * 与 chatPrompts 的旧内联实现同口径）；正则 kit 缺失/失败只 warn 不抛，
 * 调用方保持「渲染永不挡主链路」语义。
 */
export async function renderKitEntryText(content: string, macroCtx: PromptMacroCtx = {}): Promise<string> {
    const expanded = expandPromptMacros((content || '').trim(), macroCtx);
    try {
        const { applyRegexPlacement, getActiveRegexKit } = await import('./presetRegex');
        const regexKit = await getActiveRegexKit();
        // 无 kit 时零开销（getActiveRegexKit 缓存空命中），与旧内联路径一致。
        if (!regexKit) return expanded;
        return applyRegexPlacement(expanded, regexKit, 5, {
            charName: macroCtx.charName || '',
            userName: macroCtx.userName || '',
        });
    } catch (e) {
        console.warn('[PresetRegex] prompt stage skipped:', e);
        return expanded;
    }
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
    const seen = new Set<string>();
    for (const id of pack.entryIds || []) {
        const r = byId.get(id);
        if (!r) continue; // 失配引用丢弃
        seen.add(id);
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
    // 接管行按行状态进管道：adoptPosition 非 native 的 sourceKey 行不依赖
    // entryIds（切套组不丢、免手动加组）；非接管 sourceKey 行永不进三组。
    const isAdoptedRow = (r: { adoptPosition?: PromptPreset['adoptPosition'] }) =>
        r.adoptPosition === 'stable' || r.adoptPosition === 'afterHistory' || r.adoptPosition === 'absolute';
    for (const r of rows || []) {
        if (!r.sourceKey || !isAdoptedRow(r)) continue;
        if (seen.has(r.id)) continue; // 套组内已收，不重复
        if (!r.enabled) continue;
        if (!(r.content || '').trim()) continue;
        if (r.marker === 'chatHistory') continue;
        if (!tagsMatch(r.tags, activeTags)) continue;
        const norm = normalizePresetEntry(r);
        norm.adopted = true;
        if (r.adoptPosition === 'absolute') adoptedAbsolute.push(norm);
        else if (r.adoptPosition === 'afterHistory') adoptedAfter.push(norm);
        else adoptedStable.push(norm);
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
