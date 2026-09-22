/**
 * presetKitsMigration — 旧 prompt_presets 自定义段落 → 「默认预设」套组的一次性迁移。
 *
 * 幂等：`preset_packs/default` 已存在即直接返回，可重跑。
 * 等价保证：迁移只补新可选字段、按旧 order 生成 entryIds，不改 name/content/enabled，
 * 空段落仍按旧口径不注入（解析层过滤），用户行为零变化。
 */
import { DB } from './db';
import type { PresetPack, PromptPreset } from '../types';

export const DEFAULT_PACK_ID = 'default';
export const DEFAULT_PACK_NAME = '默认预设';

export interface MigrateResult {
    created: boolean;
    entries: number;
}

export async function migrateToDefaultPack(): Promise<MigrateResult> {
    const packs = await DB.getPresetPacks();
    if (packs.some((p) => p.id === DEFAULT_PACK_ID)) {
        return { created: false, entries: 0 };
    }
    const rows = await DB.getPromptPresets();
    // 只迁用户自建段落（无 sourceKey）；内置目录行走各自原生注入点，不进套组。
    const customs = (rows || [])
        .filter((r) => !r.sourceKey)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const now = Date.now();
    const updated: PromptPreset[] = customs.map((r) => ({
        ...r,
        identifier: r.identifier || `custom_${String(r.id).slice(0, 8)}`,
        role: r.role ?? 'system',
        injectionPosition: r.injectionPosition ?? 'relative',
        afterChatHistory: r.afterChatHistory === true,
    }));
    for (const u of updated) {
        await DB.savePromptPreset(u);
    }
    const pack: PresetPack = {
        id: DEFAULT_PACK_ID,
        name: DEFAULT_PACK_NAME,
        entryIds: updated.map((u) => u.id),
        createdAt: now,
        updatedAt: now,
    };
    await DB.savePresetPack(pack);
    await DB.setActivePackId(DEFAULT_PACK_ID);
    return { created: true, entries: updated.length };
}
