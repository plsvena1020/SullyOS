/**
 * presetKitShare — 预设套组分享格式 `sullyos.preset-kit` 的导出/解析。
 *
 * 纯函数，不碰 DB：调用方（PresetApp）负责重命名、落库、切 active。
 * 导出用稳定的 entry key（identifier 优先）承载顺序，导入时重发 id 并重写引用，
 * 失配引用直接丢弃；绝不复用原 id（防与本地行串）。
 */
import type { PresetGeneration, PresetPack, PresetRegexKit, PromptPreset } from '../types';

export const PRESET_KIT_SCHEMA = 'sullyos.preset-kit';
export const PRESET_KIT_VERSION = 1;

export interface PresetKitShareEntry {
    key: string;
    name: string;
    content: string;
    role?: 'system' | 'user' | 'assistant';
    injectionPosition?: 'relative' | 'absolute';
    injectionDepth?: number;
    afterChatHistory?: boolean;
    tags?: string[];
}

export interface PresetKitShareDoc {
    schema: string;
    version: number;
    exportedAt: number;
    pack: {
        name: string;
        entryKeys: string[];
        generation?: PresetGeneration;
    };
    entries: PresetKitShareEntry[];
    regexKit?: {
        name: string;
        rules: PresetRegexKit['rules'];
    } | null;
}

export function exportPresetKit(
    pack: PresetPack,
    entries: PromptPreset[],
    regexKit?: PresetRegexKit | null,
): string {
    const usedKeys = new Set<string>();
    const keyOf = (e: PromptPreset, index: number): string => {
        let base = (e.identifier || '').trim() || `entry_${index}`;
        let key = base;
        let n = 1;
        while (usedKeys.has(key)) {
            n += 1;
            key = `${base}_${n}`;
        }
        usedKeys.add(key);
        return key;
    };
    const byId = new Map(entries.map((e) => [e.id, e]));
    const shareEntries: PresetKitShareEntry[] = [];
    const entryKeys: string[] = [];
    // 顺序以 pack.entryIds 为准（套组顺序即注入顺序）；entryIds 之外的行不导出。
    for (const [index, id] of (pack.entryIds || []).entries()) {
        const e = byId.get(id);
        if (!e) continue;
        const key = keyOf(e, index);
        entryKeys.push(key);
        shareEntries.push({
            key,
            name: e.name,
            content: e.content || '',
            role: e.role,
            injectionPosition: e.injectionPosition,
            injectionDepth: e.injectionDepth,
            afterChatHistory: e.afterChatHistory === true ? true : undefined,
            tags: e.tags && e.tags.length > 0 ? [...e.tags] : undefined,
        });
    }
    const doc: PresetKitShareDoc = {
        schema: PRESET_KIT_SCHEMA,
        version: PRESET_KIT_VERSION,
        exportedAt: Date.now(),
        pack: {
            name: pack.name,
            entryKeys,
            generation: pack.generation ? { ...pack.generation } : undefined,
        },
        entries: shareEntries,
        regexKit: regexKit
            ? { name: regexKit.name, rules: JSON.parse(JSON.stringify(regexKit.rules || [])) }
            : null,
    };
    return JSON.stringify(doc, null, 2);
}

export interface ParsedPresetKit {
    packName: string;
    generation?: PresetGeneration;
    entryKeys: string[];
    entries: PresetKitShareEntry[];
    regexKit: { name: string; rules: PresetRegexKit['rules'] } | null;
}

const fail = (msg: string): never => {
    throw new Error(msg);
};

/** 解析分享 JSON；格式不对直接抛错（调用方 toast 展示 e.message）。 */
export function parsePresetKitShare(json: string): ParsedPresetKit {
    let doc: any;
    try {
        doc = JSON.parse(json);
    } catch {
        fail('不是有效的 JSON 文件');
    }
    if (!doc || typeof doc !== 'object') fail('不是有效的预设分享文件');
    if (doc.schema !== PRESET_KIT_SCHEMA) fail('不是小手机预设分享文件（schema 不匹配）');
    if (doc.version !== PRESET_KIT_VERSION) fail(`不支持的分享版本：${String(doc.version)}`);
    const packName = typeof doc.pack?.name === 'string' && doc.pack.name.trim()
        ? doc.pack.name.trim()
        : fail('分享文件缺少套组名称');
    if (!Array.isArray(doc.entries)) fail('分享文件缺少条目列表');
    const entries: PresetKitShareEntry[] = [];
    for (const raw of doc.entries) {
        if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !raw.key) continue;
        entries.push({
            key: raw.key,
            name: typeof raw.name === 'string' ? raw.name : '未命名段落',
            content: typeof raw.content === 'string' ? raw.content : '',
            role: raw.role === 'user' || raw.role === 'assistant' ? raw.role : 'system',
            injectionPosition: raw.injectionPosition === 'absolute' ? 'absolute' : 'relative',
            injectionDepth: Number.isFinite(raw.injectionDepth) ? Math.max(0, Math.floor(raw.injectionDepth)) : 0,
            afterChatHistory: raw.afterChatHistory === true ? true : undefined,
            tags: Array.isArray(raw.tags) ? raw.tags.filter((t: any) => typeof t === 'string') : undefined,
        });
    }
    const entryKeys = Array.isArray(doc.pack?.entryKeys)
        ? doc.pack.entryKeys.filter((k: any) => typeof k === 'string' && entries.some((e) => e.key === k))
        : entries.map((e) => e.key);
    let regexKit: ParsedPresetKit['regexKit'] = null;
    if (doc.regexKit && typeof doc.regexKit === 'object' && Array.isArray(doc.regexKit.rules)) {
        regexKit = {
            name: typeof doc.regexKit.name === 'string' && doc.regexKit.name.trim()
                ? doc.regexKit.name.trim()
                : '导入的正则',
            rules: doc.regexKit.rules,
        };
    }
    return {
        packName,
        generation: doc.pack?.generation && typeof doc.pack.generation === 'object'
            ? doc.pack.generation
            : undefined,
        entryKeys,
        entries,
        regexKit,
    };
}
