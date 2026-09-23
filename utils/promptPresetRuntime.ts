/**
 * 提示词目录的运行时合成层。
 *
 * 职责：把 IndexedDB `prompt_presets` 里的行与内置目录（promptPresetCatalog）
 * 按 sourceKey 对齐，产出各注入点要消费的「已解析条目」：DB 行（用户编辑过的
 * 内容）+ 目录登记（恢复默认的内容源）+ 是否被改过。
 *
 * 与 chatPrompts 旧的直接读表不同，这里跳过 sourceKey 未登记的行——那是本功能
 * 之前用户手建的自定义段落，它们的注入行为不变（见 chatPrompts 的 legacy 分支），
 * 但不进「内置可管理」视图；Preset App 里仍可看到和编辑它们。
 *
 * 读取带模块级缓存：buildSystemPrompt 每条消息都会取一遍，缓存避免重复开事务。
 * 所有写入路径（Preset App 保存/恢复默认/播种迁移）必须调 invalidatePromptPresetCache()。
 */
import { DB } from './db';
import { getBuiltinEntry, type BuiltinPromptEntry } from './promptPresetCatalog';
import type { PromptPreset } from '../types';

export interface ResolvedPrompt {
    preset: PromptPreset;        // DB 记录（含用户已编辑的 content）
    builtin: BuiltinPromptEntry; // 目录登记（builtin.content = 恢复默认的内容源）
    customized: boolean;         // 用户是否改过内容（与内置默认逐字不同）
}

let cache: ResolvedPrompt[] | null = null;

/** 任何对 prompt_presets 的写操作之后都必须调用（Preset App / 播种迁移已接）。 */
export const invalidatePromptPresetCache = (): void => {
    cache = null;
};

/**
 * 只读模块级缓存的同步快照（P6 写链用）：预热前返回 null，调用方按「无改写」处理。
 * 同步不碰 IDB —— 打包路径不因数据库阻塞，也与假时钟测试兼容；
 * OSContext 启动播种即预热，正常使用中缓存是热的。
 */
export const peekResolvedPromptCache = (): ResolvedPrompt[] | null =>
    cache ? [...cache] : null;

export const getResolvedPromptPresets = async (): Promise<ResolvedPrompt[]> => {
    if (cache) return cache;
    try {
        const rows = await DB.getPromptPresets();
        const resolved: ResolvedPrompt[] = [];
        for (const p of rows || []) {
            const builtin = p.sourceKey ? getBuiltinEntry(p.sourceKey) : undefined;
            if (!builtin) continue; // 未登记的行（旧自定义段落）不进内置视图
            resolved.push({
                preset: p,
                builtin,
                customized: (p.content ?? '') !== builtin.content,
            });
        }
        cache = resolved;
        return resolved;
    } catch (e) {
        console.warn('[PresetPrompt] resolved presets unavailable:', e);
        return [];
    }
};

/**
 * 恢复默认：按目录登记回写一行（名字 + 内容 + 版本），保留 id/order/enabled，
 * 用户对注入顺序与启停的选择不被「恢复内容」误伤。
 */
export const applyBuiltinDefaultsToPreset = (preset: PromptPreset): PromptPreset => {
    const builtin = preset.sourceKey ? getBuiltinEntry(preset.sourceKey) : undefined;
    if (!builtin) return preset;
    return {
        ...preset,
        name: builtin.name,
        content: builtin.content,
        builtinVersion: builtin.builtinVersion,
        updatedAt: Date.now(),
    };
};

/**
 * 面向用户段落的统一解析：DB 行内容优先，缺行回退内置默认，停用返回 null
 * （调用方据语义决定不注入）。返回值必不为空串（空内容回退默认）。
 */
export const resolveManagedPrompt = async (sourceKey: string, fallback: string): Promise<string | null> => {
    try {
        const rows = await getResolvedPromptPresets();
        const hit = rows.find((r) => r.preset.sourceKey === sourceKey);
        if (!hit) return fallback;            // 目录缺行：内置默认兜底
        if (!hit.preset.enabled) return null; // 用户停用：不注入
        return hit.preset.content || fallback;
    } catch {
        return fallback;
    }
};

/**
 * resolveManagedPrompt 的同步版：只读模块级缓存（OSContext 启动播种 + 各异步
 * 注入点都会预热）。缓存未就绪时回退内置默认 —— 供同步拼 prompt 的构建器
 * （写歌导师、约会 VN 深挖块）使用，不改变它们的同步签名。
 */
export const resolveManagedPromptSync = (sourceKey: string, fallback: string): string | null => {
    const rows = cache;
    if (!rows) return fallback;
    const hit = rows.find((r) => r.preset.sourceKey === sourceKey);
    if (!hit) return fallback;
    if (!hit.preset.enabled) return null;
    return hit.preset.content || fallback;
};

/**
 * 技术模板专用解析：DB 行内容优先，缺行/停用/异常一律回退内置默认 ——
 * 记忆消化、检索路由这类系统能力永不因预设面板的误操作而瘫痪。
 * 与 resolveManagedPrompt（停用返回 null，供面向用户的段落用）语义相对。
 */
export const resolveTechnicalPrompt = async (sourceKey: string, fallback: string): Promise<string> => {
    try {
        const rows = await getResolvedPromptPresets();
        const hit = rows.find((r) => r.preset.sourceKey === sourceKey);
        if (hit && hit.preset.enabled && hit.preset.content) return hit.preset.content;
    } catch {
        /* fallthrough */
    }
    return fallback;
};

/** 同步版：只读模块级缓存，未就绪时回退内置默认。 */
export const resolveTechnicalPromptSync = (sourceKey: string, fallback: string): string => {
    const rows = cache;
    if (rows) {
        const hit = rows.find((r) => r.preset.sourceKey === sourceKey);
        if (hit && hit.preset.enabled && hit.preset.content) return hit.preset.content;
    }
    return fallback;
};

/**
 * 语音指南三级解析（voice.minimax / voice.fish / voice.elevenlabs* / voice.date）：
 * 1) 预设面板行被用户改过 -> 用面板内容（面板即唯一入口）；
 * 2) 行停用 -> 返回 null（调用方整段不注入，面向用户文案语义）；
 * 3) 行未动过 -> 设置页旧覆盖（便捷入口）仍生效；最后由调用方回退内置默认。
 */
export const resolveVoiceGuide = async (sourceKey: string, legacyOverride?: string): Promise<string | null> => {
    try {
        const rows = await getResolvedPromptPresets();
        const hit = rows.find((r) => r.preset.sourceKey === sourceKey);
        if (hit) {
            if (!hit.preset.enabled) return null;
            if (hit.preset.content && hit.preset.content !== hit.builtin.content) return hit.preset.content;
        }
    } catch {
        /* fallthrough */
    }
    return legacyOverride && legacyOverride.trim() ? legacyOverride : null;
};

/** 同步版：只读模块级缓存（未就绪时直接走旧覆盖/回退，行为同迁移前的同步路径）。 */
export const resolveVoiceGuideSync = (sourceKey: string, legacyOverride?: string): string | null => {
    const rows = cache;
    if (rows) {
        const hit = rows.find((r) => r.preset.sourceKey === sourceKey);
        if (hit) {
            if (!hit.preset.enabled) return null;
            if (hit.preset.content && hit.preset.content !== hit.builtin.content) return hit.preset.content;
        }
    }
    return legacyOverride && legacyOverride.trim() ? legacyOverride : null;
};
