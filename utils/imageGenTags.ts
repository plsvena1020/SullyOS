/**
 * imageGenTags — 聊天自动生图的标签解析纯函数。
 *
 * 模型在回复里写 `[[GEN_IMAGE: 英文 tag, ... | portrait|landscape|square]]`，
 * 这里负责：解析 / 从正文剥离 / 把 @角色名 替换成外貌档案。
 * 无副作用，可单测；真正的网络调用在 latentImageGen.ts。
 */

export type ImageGenResolution = 'square' | 'portrait' | 'landscape';

/** 生图显式性别（相册生成界面用：修 AI 把角色性别认错的情况）。 */
export type GenGender = 'male' | 'female';

export interface GenImageRequest {
    /** 清理过的英文 tag 串（已压成单行）。 */
    prompt: string;
    resolution: ImageGenResolution;
}

export const DEFAULT_IMAGE_GEN_RESOLUTION: ImageGenResolution = 'portrait';

// 容忍模型手滑：中括号间空格、全角冒号「：」、收尾空格
// （[[ GEN_IMAGE：cat | portrait ]] 这类写法现在也能认出来、剥干净）。
const TAG_RE = /\[\s*\[\s*GEN_IMAGE\s*[:：]\s*([\s\S]*?)\s*\]\s*\]/gi;

const RESOLUTION_ALIASES: Record<string, ImageGenResolution> = {
    square: 'square',
    portrait: 'portrait',
    landscape: 'landscape',
    '方': 'square',
    '竖': 'portrait',
    '横': 'landscape',
};

/** 分辨率别名归一（英/中简写都认）；认不出返回 null。 */
export function normalizeImageGenResolution(token: unknown): ImageGenResolution | null {
    if (typeof token !== 'string' || !token.trim()) return null;
    return RESOLUTION_ALIASES[token.trim().toLowerCase()] ?? null;
}

function cleanPrompt(raw: string): string {
    return raw.replace(/\s+/g, ' ').trim();
}

/**
 * 从回复文本里抽出所有 GEN_IMAGE 请求。
 * - `|` 最后一个分段若是已知的分辨率词才算分辨率，否则整个 body 都是 prompt。
 * - 空 prompt 的标签直接丢弃。
 */
export function extractGenImageTags(text: string): GenImageRequest[] {
    if (!text || !/gen_image/i.test(text)) return [];
    const out: GenImageRequest[] = [];
    // 每次调用重置 lastIndex（TAG_RE 是全局正则）。
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(text)) !== null) {
        const body = (m[1] || '').trim();
        if (!body) continue;
        const parts = body.split('|');
        let resolution: ImageGenResolution | null = null;
        let promptRaw = body;
        if (parts.length > 1) {
            const maybeRes = normalizeImageGenResolution(parts[parts.length - 1]);
            if (maybeRes) {
                resolution = maybeRes;
                promptRaw = parts.slice(0, -1).join('|');
            }
        }
        const prompt = cleanPrompt(promptRaw);
        if (!prompt) continue;
        out.push({ prompt, resolution: resolution ?? DEFAULT_IMAGE_GEN_RESOLUTION });
    }
    return out;
}

/** 把所有 GEN_IMAGE 标签从正文里剥掉（落库前调用），保留周围文字。 */
export function stripGenImageTags(text: string): string {
    if (!text || !/gen_image/i.test(text)) return text;
    TAG_RE.lastIndex = 0;
    return text
        .replace(TAG_RE, '')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export interface AppearanceProfile {
    /** 名字 + 昵称/爱称，任一命中即替换。 */
    names: string[];
    /** 英文外貌 tag 串。 */
    tags: string;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 prompt 里的 @角色名 机械替换成档案里的外貌 tag（柏宝绘式防漂移）。
 * - 长名字优先，避免「小白」吃掉「小白脸」的前缀。
 * - 名字大小写不敏感（模型可能把 @Sully 写成 @sully），替换后统一是档案里的 tag。
 * - 档案里没建档的名字原样保留。
 */
export function resolveAppearanceRefs(prompt: string, profiles: AppearanceProfile[]): string {
    if (!prompt || !prompt.includes('@') || profiles.length === 0) return prompt;
    const entries: Array<{ name: string; tags: string }> = [];
    for (const p of profiles) {
        const tags = (p.tags || '').trim();
        if (!tags) continue;
        for (const n of p.names || []) {
            const name = (n || '').trim();
            if (name) entries.push({ name, tags });
        }
    }
    entries.sort((a, b) => b.name.length - a.name.length);
    let out = prompt;
    for (const { name, tags } of entries) {
        out = out.replace(new RegExp(`@${escapeRegExp(name)}(?![\\w])`, 'gi'), tags);
    }
    return out;
}

// ─── 提示词合成（固定注入 + 性别矫正 + 去重） ────────────────────────────────

/** prompt 里是否 @了这个名字（大小写不敏感；在 resolveAppearanceRefs 之前判定用）。 */
export function mentionsCharacterRef(prompt: string, name: string): boolean {
    const key = (name || '').trim();
    if (!prompt || !key || !prompt.includes('@')) return false;
    return new RegExp(`@${escapeRegExp(key)}(?![\\w])`, 'i').test(prompt);
}

/** 显式性别时要剔除的旧性别标记（含裸 male/female 与 focus 变体，防止画面主体打架）。 */
const GENDER_CONFLICT_TAGS = new Set(['1girl', '1boy', 'male', 'female', 'male focus', 'female focus']);

/** 逗号（中英文）分隔 → 去空白 tag 列表。 */
function splitTagList(text: string): string[] {
    return String(text || '')
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
}

/**
 * 把多层来源的 tag 合成一行最终 prompt，保证不重复、不打架。
 *
 * 合并顺序（也是去重后保留的顺序）：质量词 → 性别标记 → 主体 tag → 画风/画师 tag。
 * 规则：
 * - 传了 gender 时，先把主体 / 画风里原有的 `1girl` / `1boy` / `male` / `female` /
 *   `male focus` / `female focus` 全部剔除，再注入选中的那一个 —— AI 分析图时认错性别也不会打架；
 * - 所有 tag 大小写不敏感去重（统一输出小写 danbooru 风格）；
 * - 质量词跟主体重复时同样只留一份。
 *
 * 纯函数，可单测；真实生图在 imageGenFlow / latentImageGen。
 */
export function composeImagePrompt(
    basePrompt: string,
    opts?: {
        /** 画风 / 画师 tag（固定注入栏）。 */
        styleTags?: string;
        /** 显式性别（相册「画角色」时选）。 */
        gender?: GenGender;
        /** 默认质量词（由调用方传 DEFAULT_QUALITY_PROMPT，保持本模块零依赖）。 */
        qualityTags?: string;
    },
): string {
    const genderTag = opts?.gender
        ? (opts.gender === 'male' ? '1boy' : '1girl')
        : '';
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (raw: string) => {
        const tag = raw.trim().toLowerCase();
        if (!tag || seen.has(tag)) return;
        if (genderTag && GENDER_CONFLICT_TAGS.has(tag) && tag !== genderTag) return;
        seen.add(tag);
        out.push(tag);
    };

    for (const t of splitTagList(opts?.qualityTags || '')) push(t);
    if (genderTag) push(genderTag);
    for (const t of splitTagList(basePrompt)) push(t);
    for (const t of splitTagList(opts?.styleTags || '')) push(t);
    return out.join(', ');
}
