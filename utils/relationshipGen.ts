/**
 * 人物关系生成引擎（神经连接 · 人物关系）。
 *
 * 为单个 char 生成「ta 生命中确定认识的人」：单次 LLM 调用批量产出 NPC 群像
 * （名字 + 人设词 + 彼此关系），落库到 char.relationshipProfiles，随后由
 * ContextBuilder.buildCoreContext 注入 char 的 system prompt 作为稳定人设。
 *
 * 两种模式：
 * - directed（定向）：用户给出要求，如「加两个大学时期的朋友」。
 * - divergent（发散）：用户不给要求，仅依据 char 的 systemPrompt / worldview
 *   推演「这个人生命里可能出现、且还没被写下的身影」，要求多样化、贴合设定。
 *
 * temperature 统一 1.0（产品决策，不分模式调参）。人设词硬限 200 字——NPC 是
 * 配角，占的 token 越少，主 prompt 越清爽。
 */
import type { CharacterProfile, RelationshipProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { extractContent, extractJson, safeFetchJson } from './safeApi';
import { getBuiltinContent, fillIdentity } from './promptPresetCatalog';
import { resolveTechnicalPrompt } from './promptPresetRuntime';

/** MiniApiConfig 结构由调用方（Character.tsx 的 apiConfig）满足，这里只取要用的字段 */
export interface RelGenApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/** 人设词硬上限：解析时超长截断，绝不让 NPC 人设把主 prompt 撑爆 */
export const REL_PERSONA_MAX_CHARS = 200;
/** 一次最多生成几个 */
export const REL_GEN_MAX_COUNT = 6;
/** 单次调用的硬上限：UI 不允许无限「生成中」；主代理上行 120s abort，这里留余量。 */
export const REL_GEN_TIMEOUT_MS = 180_000;

export interface RelationshipGenRequest {
    char: CharacterProfile;
    user: UserProfile;
    api: RelGenApiConfig;
    /** 用户给的定向要求；空 = 发散模式 */
    requirement?: string;
    /** 生成数量 1..6（默认 2） */
    count?: number;
}

export interface RelationshipGenResult {
    created: RelationshipProfile[];
    /** 生成模式（回显用） */
    mode: 'directed' | 'divergent';
}

/**
 * 生成人物关系。
 * 上下文用 buildCoreContext(char, user, false)——不携带详细记忆，省 token：
 * 生成 NPC 群像只需要人设骨架，不需要聊天记录。
 */
export async function generateRelationshipProfiles(
    req: RelationshipGenRequest,
): Promise<RelationshipGenResult> {
    const { char, user, api } = req;
    const requirement = (req.requirement || '').trim();
    const mode: 'directed' | 'divergent' = requirement ? 'directed' : 'divergent';
    const count = Math.min(Math.max(Math.floor(req.count ?? 2), 1), REL_GEN_MAX_COUNT);

    if (!api.apiKey) throw new Error('请先配置 API Key');

    // 人设骨架（不含详细记忆）。失败不阻塞——退化成只给名字与性格字段。
    let coreContext = '';
    try {
        coreContext = ContextBuilder.buildCoreContext(char, user, false);
    } catch {
        coreContext = `### 你的身份 (Character)\n- 名字: ${char.name}\n- 核心性格/指令:\n${char.systemPrompt || ''}`;
    }

    const modeBlock = requirement
        ? `本次生成要求（用户定向）：${requirement}`
        : `本次不设具体要求：请你基于上面的人设与世界观，推演这个人生命里自然存在、但设定里还没写到的人。要求：
- 多样化：性别、年龄、与主角的关系类型尽量不重复（如家人 / 旧友 / 同事 / 偶遇的人…）。
- 贴合设定：每个人都必须能从这个人的经历、职业、性格里自然长出来，不要凭空乱入。
- 克制：宁可少而真，不要堆砌戏剧化的巧合。`;

    // 任务指令迁入提示词目录（rel.genGuide —— 预设 App 可编辑/启停；停用走内置默认，
    // 生成器属系统能力，永不因面板误操作瘫痪）。占位符：{{char}}/{{user}} 由 fillIdentity
    // 统一替换；__REL_MODE__ / __REL_COUNT__ 为动态段，按请求语义填充。
    const taskGuide = await resolveTechnicalPrompt('rel.genGuide', getBuiltinContent('rel.genGuide'));
    const taskBlock = fillIdentity(taskGuide, char.name, user.name)
        .replace(/__REL_MODE__/g, modeBlock)
        .replace(/__REL_COUNT__/g, String(count));
    const prompt = `${coreContext}

${taskBlock}`;

    let data: any;
    try {
        data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 1.0,
            }),
        }, 0, REL_GEN_TIMEOUT_MS);
    } catch (e: any) {
        if (e?.name === 'AbortError' || /aborted|timeout/i.test(String(e?.message || ''))) {
            throw new Error('生成超时，请重试');
        }
        throw e;
    }
    const content = extractContent(data);
    const raw = extractJson(content);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('生成结果解析失败，请重试');

    const now = Date.now();
    const created: RelationshipProfile[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const name = String((item as any).name ?? '').trim().slice(0, 30);
        const persona = String((item as any).persona ?? '').trim().slice(0, REL_PERSONA_MAX_CHARS);
        const relation = String((item as any).relation ?? '').trim().slice(0, 120);
        if (!name || !persona || !relation) continue;
        // 同名去重（含与已有档案重名）：人物关系是稳定人设，同名并存只会造成混乱
        if ([...(req.char.relationshipProfiles || []), ...created].some(r => r.name === name)) continue;
        created.push({
            id: `rel-${now}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            persona,
            relation,
            generatedFrom: mode,
            createdAt: now,
        });
        if (created.length >= count) break;
        void user; // user 仅经 buildCoreContext 间接使用
    }
    if (created.length === 0) throw new Error('没有生成有效的人物，请重试');
    return { created, mode };
}
