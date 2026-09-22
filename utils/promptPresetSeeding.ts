/**
 * 内置提示词条目的一次性播种（首次加载 / 版本升级补缺）。
 *
 * 规则：prompt_presets 里缺哪个 sourceKey 就补哪条——已存在的行**永不覆盖**，
 * 用户对内容的编辑、启停、排序都原样保留。落库走 DB.reconcilePromptPresets 的
 * 单事务对账：并发播种不会产生重复行，历史竞态重复行会在同一事务里合并。
 * OSContext 启动时调用，跑一次成本是一次写事务，之后秒回。
 */
import { DB } from './db';
import { BUILTIN_PROMPT_ENTRIES } from './promptPresetCatalog';
import { invalidatePromptPresetCache } from './promptPresetRuntime';
import type { PromptPreset } from '../types';

/** 已知被 9fa253b7 手滑改坏的展示名（sourceKey → 错名原文）；修复值取目录当前 name。 */
const CORRUPTED_BUILTIN_NAMES: Record<string, string[]> = {
    'memory.personalityDetect': ['记忆消化 · 认知风风风风判定'],
};

export const seedBuiltinPromptPresets = async (): Promise<void> => {
    try {
        const now = Date.now();
        const seeds: PromptPreset[] = BUILTIN_PROMPT_ENTRIES.map((entry) => ({
            id: crypto.randomUUID(),
            sourceKey: entry.sourceKey,
            category: entry.category,
            name: entry.name,
            content: entry.content,
            order: entry.order,
            enabled: true,
            builtinVersion: entry.builtinVersion,
            createdAt: now,
            updatedAt: now,
        }));
        const builtinByKey: Record<string, { name: string; content: string }> = {};
        for (const entry of BUILTIN_PROMPT_ENTRIES) {
            builtinByKey[entry.sourceKey] = { name: entry.name, content: entry.content };
        }
        const { seeded, removed } = await DB.reconcilePromptPresets(seeds, builtinByKey);
        if (seeded > 0) console.log(`[PresetPrompt] seeded ${seeded} builtin prompt entries`);
        if (removed > 0) console.log(`[PresetPrompt] merged ${removed} duplicate prompt rows`);
        await repairCorruptedBuiltinNames();
        if (seeded > 0 || removed > 0) invalidatePromptPresetCache();
    } catch (e) {
        console.warn('[PresetPrompt] seeding builtin entries failed:', e);
    }
};

/**
 * 一次性修复：把历史播种行上被改坏的展示名还原成目录当前 name。
 * 只精确匹配已知错名（避免覆盖用户自己起的名字），只动 name，内容/启停/排序/版本不动。
 * 幂等；导入的备份里带回来的错名行也会在下次启动时被修好。
 */
export const repairCorruptedBuiltinNames = async (): Promise<void> => {
    try {
        const rows = await DB.getPromptPresets();
        const now = Date.now();
        let fixed = 0;
        for (const row of rows || []) {
            const badNames = row.sourceKey ? CORRUPTED_BUILTIN_NAMES[row.sourceKey] : undefined;
            if (!badNames || !badNames.includes(row.name)) continue;
            const builtin = BUILTIN_PROMPT_ENTRIES.find((e) => e.sourceKey === row.sourceKey);
            if (!builtin || row.name === builtin.name) continue;
            await DB.savePromptPreset({ ...row, name: builtin.name, updatedAt: now });
            fixed++;
        }
        if (fixed > 0) {
            invalidatePromptPresetCache();
            console.log(`[PresetPrompt] repaired ${fixed} corrupted builtin name(s)`);
        }
    } catch (e) {
        console.warn('[PresetPrompt] corrupted builtin name repair skipped:', e);
    }
};

/**
 * 一次性迁移（P3）：把「设置 → 其他 API → 语音提示词」里的旧覆盖值搬进预设面板的
 * voice 分类行 —— 只搬「仍然是内置默认」的行（用户已在面板改过的绝不覆盖），搬完
 * 清空旧字段，让面板成为唯一管理入口。设置页的框变成便捷入口：再填的值在
 * resolveVoiceGuide 的第二级仍然生效。幂等：旧字段为空时立即返回。
 */
export const migrateLegacyVoiceOverrides = async (): Promise<void> => {
    try {
        const raw = localStorage.getItem('os_api_config');
        if (!raw) return;
        const cfg = JSON.parse(raw);
        const vp = cfg?.voicePrompts || {};
        // 旧字段 -> 面板 sourceKey（elevenlabs 旧值同时喂给 v3 / 标准两行）
        const map: Array<[string, string | undefined]> = [
            ['voice.minimax', vp.minimax],
            ['voice.fish', vp.fishaudio],
            ['voice.elevenlabsV3', vp.elevenlabs],
            ['voice.elevenlabsStd', vp.elevenlabs],
            ['voice.date', vp.dateVoice],
        ];
        const pending = map.filter(([, v]) => typeof v === 'string' && v && v.trim());
        if (pending.length === 0) return;
        const rows = await DB.getPromptPresets();
        const now = Date.now();
        let migrated = 0;
        for (const [sourceKey, legacy] of pending) {
            const row = (rows || []).find((r) => r.sourceKey === sourceKey);
            const builtin = BUILTIN_PROMPT_ENTRIES.find((e) => e.sourceKey === sourceKey);
            if (!row || !builtin) continue;
            if ((row.content ?? '') !== builtin.content) continue; // 已在面板改过 -> 不动
            await DB.savePromptPreset({
                ...row,
                content: legacy as string,
                builtinVersion: builtin.builtinVersion,
                updatedAt: now,
            });
            migrated++;
        }
        if (migrated > 0) {
            delete cfg.voicePrompts;
            localStorage.setItem('os_api_config', JSON.stringify(cfg));
            invalidatePromptPresetCache();
            console.log(`[PresetPrompt] migrated ${migrated} legacy voice override(s) into the preset panel`);
        }
    } catch (e) {
        console.warn('[PresetPrompt] legacy voice override migration skipped:', e);
    }
};
