/**
 * presetRegex — 输出正则脚本执行器（placement 1/2/5）。
 *
 * placement 口径：1=用户输入（发送前）/ 2=AI 输出（粗洗之后、消费之前）/
 * 5=仅发给模型（预设条目渲染后）。placement 4 / displayOnly 暂不执行
 * （渲染层未接显示分支，执行层跳过并 warn，见 spec §4.6 v1 边界）。
 *
 * 非法 findRegex → 整条跳过 + console.warn，绝不抛（保护主链路）。
 * replaceString 支持 $1 分组引用（原生）+ {{char}}/{{user}} 宏。
 * 读取带模块级缓存；任何写 preset_regexes 的地方必须调
 * invalidatePresetRegexCache()。
 */
import { DB } from './db';
import type { PresetRegexKit, PresetRegexRule } from '../types';
import { expandPromptMacros } from './promptMacros';
import { tagsMatch } from './presetKits';

export const REGEX_ACTIVE_ID = 'regex-active';

export interface RegexRunCtx {
    /** placement=2 历史回放时的深度；主输出 depth=0。 */
    depth?: number;
    charName?: string;
    userName?: string;
    activeTags?: string[];
}

let kitCache: PresetRegexKit | null | undefined = undefined;

export const invalidatePresetRegexCache = (): void => {
    kitCache = undefined;
};

const effectivePlacements = (rule: PresetRegexRule): number[] => {
    const set = new Set(rule.placement || []);
    if (rule.promptOnly) set.add(5);
    if (rule.displayOnly) set.add(4);
    return [...set];
};

const depthAllowed = (rule: PresetRegexRule, depth: number): boolean => {
    if (rule.minDepth !== undefined && Number.isFinite(rule.minDepth) && depth < rule.minDepth) return false;
    if (rule.maxDepth !== undefined && Number.isFinite(rule.maxDepth) && depth > rule.maxDepth) return false;
    return true;
};

export function runRegexRule(
    rule: PresetRegexRule,
    text: string,
    ctx: RegexRunCtx = {},
): string {
    let re: RegExp;
    try {
        re = new RegExp(rule.findRegex, 'g');
    } catch (e) {
        console.warn('[PresetRegex] 非法正则，整条跳过:', rule.scriptName || rule.id, e);
        return text;
    }
    let replacement = rule.replaceString ?? '';
    if (replacement.indexOf('{{') !== -1) {
        replacement = expandPromptMacros(replacement, {
            charName: ctx.charName || '',
            userName: ctx.userName || '',
        });
    }
    try {
        // 回调形态返回替换串：替换串里的 $ 按字面走，避免 $&/$' 语义 surprises；
        // 分组引用 $1..$9 手动展开（String.replace 回调的 args 尾部即分组）。
        return text.replace(re, (...args: any[]) => {
            const groups: string[] = args.slice(1, -2);
            return replacement.replace(/\$(\d{1,2})/g, (_m, n: string) => {
                const idx = Number(n) - 1;
                return idx >= 0 && idx < groups.length ? (groups[idx] ?? '') : _m;
            });
        });
    } catch (e) {
        console.warn('[PresetRegex] 替换失败，保留原文:', rule.scriptName || rule.id, e);
        return text;
    }
}

/** placement=4 / displayOnly 的规则：v1 执行层跳过（渲染层未接），只 warn。 */
const isDeferredDisplay = (rule: PresetRegexRule): boolean =>
    effectivePlacements(rule).includes(4) || rule.displayOnly === true;

export function applyRegexPlacement(
    text: string,
    kit: PresetRegexKit | null | undefined,
    placement: 1 | 2 | 5,
    ctx: RegexRunCtx = {},
): string {
    if (!kit || kit.enabled === false || !text) return text;
    const activeTags = ctx.activeTags ?? ['chat'];
    const depth = ctx.depth ?? 0;
    let out = text;
    for (const rule of kit.rules || []) {
        if (!rule || rule.disabled) continue;
        if (!effectivePlacements(rule).includes(placement)) continue;
        if (isDeferredDisplay(rule)) {
            console.warn('[PresetRegex] 仅显示规则暂不执行（渲染层未接），已跳过:', rule.scriptName || rule.id);
            continue;
        }
        if (!tagsMatch(rule.tags, activeTags)) continue;
        if (placement === 2 && !depthAllowed(rule, depth)) continue;
        out = runRegexRule(rule, out, ctx);
    }
    return out;
}

/** 当前生效的正则 kit；无指针/无 kit/被停用返回 undefined（调用方零变化）。 */
export async function getActiveRegexKit(): Promise<PresetRegexKit | undefined> {
    if (kitCache !== undefined) return kitCache ?? undefined;
    try {
        const kits = await DB.getPresetRegexes();
        if (!kits || kits.length === 0) {
            kitCache = null;
            return undefined;
        }
        let kit = kits[0];
        try {
            const db = await (await import('./db')).openDB();
            if (db.objectStoreNames.contains('preset_pack_active')) {
                const row = await new Promise<any>((resolve, reject) => {
                    const tx = db.transaction('preset_pack_active', 'readonly');
                    const req = tx.objectStore('preset_pack_active').get(REGEX_ACTIVE_ID);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                if (row && typeof row.kitId === 'string') {
                    kit = kits.find((k) => k.id === row.kitId) ?? kits[0];
                }
            }
        } catch { /* 指针读取失败就用第一个 kit */ }
        kitCache = kit.enabled === false ? null : kit;
        return kitCache ?? undefined;
    } catch {
        return undefined;
    }
}

export async function getActiveRegexKitId(): Promise<string | null> {
    try {
        const { openDB } = await import('./db');
        const db = await openDB();
        if (!db.objectStoreNames.contains('preset_pack_active')) return null;
        const row = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction('preset_pack_active', 'readonly');
            const req = tx.objectStore('preset_pack_active').get(REGEX_ACTIVE_ID);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return (row && typeof row.kitId === 'string' && row.kitId) || null;
    } catch {
        return null;
    }
}

export async function setActiveRegexKitId(kitId: string): Promise<void> {    const { openDB } = await import('./db');
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('preset_pack_active', 'readwrite');
        tx.objectStore('preset_pack_active').put({ id: REGEX_ACTIVE_ID, kitId });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    invalidatePresetRegexCache();
}

/** 输出侧统一入口（placement=2，主输出 depth=0）。失败回原文。 */
export async function applyActiveOutputRegex(text: string, ctx: RegexRunCtx = {}): Promise<string> {
    try {
        const kit = await getActiveRegexKit();
        if (!kit) return text;
        return applyRegexPlacement(text, kit, 2, ctx);
    } catch (e) {
        console.warn('[PresetRegex] output regex skipped:', e);
        return text;
    }
}

/** 输入侧统一入口（placement=1）。失败回原文。 */
export async function applyActiveInputRegex(text: string, ctx: RegexRunCtx = {}): Promise<string> {
    try {
        const kit = await getActiveRegexKit();
        if (!kit) return text;
        return applyRegexPlacement(text, kit, 1, ctx);
    } catch (e) {
        console.warn('[PresetRegex] input regex skipped:', e);
        return text;
    }
}

/**
 * 输入正则在消息数组上的落点：只改最后一条纯文本 user 消息（发给模型的那份），
 * 不写回 DB。worldbook 关键词扫描在它之后跑——世界书按模型实际看到的文本命中。
 * vision 数组 content 跳过（v1 边界）。
 */
export async function applyActiveInputRegexToLastUser<
    T extends { role?: string; content?: any },
>(messages: T[], ctx: RegexRunCtx = {}): Promise<T[]> {
    try {
        const kit = await getActiveRegexKit();
        if (!kit) return messages;
        let idx = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]?.role === 'user' && typeof messages[i]?.content === 'string') {
                idx = i;
                break;
            }
        }
        if (idx === -1) return messages;
        const out = [...messages];
        out[idx] = {
            ...messages[idx],
            content: applyRegexPlacement(messages[idx].content, kit, 1, ctx),
        };
        return out;
    } catch (e) {
        console.warn('[PresetRegex] input regex to messages skipped:', e);
        return messages;
    }
}
