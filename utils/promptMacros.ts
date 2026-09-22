/**
 * promptMacros — 预设套组宏引擎（纯函数，零 IO）。
 *
 * 宏集合：{{char}} {{user}} {{persona}} {{lastUser}} {{lastAssistant}}
 * {{time}} {{date}}。大小写不敏感，花括号内允许空格；未知宏原样保留。
 *
 * 口径约束：
 * - {{user}} 缺省回退「对方」——与 promptPresetCatalog.fillIdentity 一致，
 *   钢印路径替换 fillIdentity 时行为不变。
 * - {{char}} 为空时不替换（不吞字）；fillIdentity 旧行为是替换成空串，
 *   新路径 charName 恒非空，实际无差异。
 * - 世界书 expandWorldbookMacros 只统一 char/user 的正则口径，不扩宏集合。
 */

export interface PromptMacroCtx {
    charName?: string;
    userName?: string;
    /** 用户画像/简介（UserProfile.bio）。 */
    persona?: string;
    lastUser?: string;
    lastAssistant?: string;
    /** 可注入时钟（测试钉时间用）；缺省 new Date()。 */
    now?: Date;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const fmtTime = (d: Date): string => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const fmtDate = (d: Date): string =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function expandPromptMacros(content: string, ctx: PromptMacroCtx = {}): string {
    if (!content || content.indexOf('{{') === -1) return content;
    const now = ctx.now ?? new Date();
    const values: Record<string, string | undefined> = {
        char: ctx.charName ? ctx.charName : undefined,
        user: (ctx.userName && ctx.userName.trim()) || '对方',
        persona: ctx.persona ?? '',
        lastuser: ctx.lastUser ?? '',
        lastassistant: ctx.lastAssistant ?? '',
        time: fmtTime(now),
        date: fmtDate(now),
    };
    let out = content;
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined) continue;
        out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'gi'), () => value);
    }
    return out;
}
