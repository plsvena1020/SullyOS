/**
 * promptPreviewComposer — 提示词注入预览组装器（只读、零模型调用）。
 *
 * 用途：Preset App 的「注入预览」视图。镜像 chatPrompts.buildSystemPromptParts 的
 * 组装流，把将要注入聊天主链路 system prompt 的全部内容按三段式
 * （stable / volatileState / recencyTail）逐块列出，附来源标签、参与性标记、
 * 插入位、命中状态与 token 估算。
 *
 * 原则：
 * · 只读 —— 不写任何 DB / localStorage，不调用任何会改状态的函数。
 * · 网络副作用仅限天气（Open-Meteo 免 key，失败静默降级为「未注入」标注）。
 *   日记（Notion/飞书）属外部服务，预览只标「已启用」，不实际拉取。
 * · 正文优先取真实产物（buildCoreContext / buildScheduleInjection /
 *   buildMusicAtmosphere / getMcpResultMemoryBlock …），与实际注入一字不差；
 *   无法离线还原的块给出忠实说明而不是编造。
 *
 * 注意：世界书条目正文已织入「角色核心上下文」大块（buildCoreContext 是黑盒），
 * 条目明细单独列出仅供标注（插入位 / 命中状态），token 小计不重复计算。
 */
import type { CharacterProfile } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import {
    resolveWorldbookEntries,
    WORLDBOOK_POSITION_LABELS,
    type WorldbookScanMessage,
    type WorldbookLike,
} from './worldbook';
import { getBuiltinContent } from './promptPresetCatalog';
import { getResolvedPromptPresets, resolveVoiceGuide } from './promptPresetRuntime';
import { getTtsProvider, getVoicePromptOverride } from './ttsProvider';
import { isElevenLabsV3Model, getElevenLabsVoiceActingGuide } from './elevenLabsTts';
import { getElevenLabsModel } from './ttsProvider';
import { isScheduleFeatureOn } from './scheduleFeature';
import { getDailyScheduleForChar } from './dailySchedule';
import { buildScheduleInjection } from './scheduleInjection';
import { resolveCharTimeZone, nowInTimeZone } from './timezone';
import { computeCurrentListening, getCurrentSlot } from './charMusicSchedule';
import { isMcpChatAvailable, loadMcpSettings } from './mcpClient';
import { getMcpResultMemoryBlock } from './mcpResultMemory';
import { RealtimeContextManager, defaultRealtimeConfig, resolveCharCity } from './realtimeContext';

// ========== 类型 ==========

export type PromptSegment = 'stable' | 'volatileState' | 'recencyTail' | 'history';

export type PromptBlockRole = 'content' | 'discipline' | 'disabled';

export interface PromptPreviewBlock {
    id: string;
    segment: PromptSegment;
    title: string;
    /** 来源类型，UI 凭此着色/配图标 */
    sourceType: 'char' | 'worldbook' | 'user' | 'memory' | 'preset' | 'builtin' | 'mcp'
        | 'schedule' | 'music' | 'group' | 'system' | 'diary' | 'realtime';
    sourceLabel: string;
    /** content = 参与内容；discipline = 结构纪律（防重复/格式钢印，不贡献剧情）；disabled = 不注入 */
    role: PromptBlockRole;
    enabled: boolean;
    /** 预设插入顺序号（仅预设块） */
    order?: number;
    /** 插入位标注（世界书 / 自定义预设） */
    insertionPoint?: string;
    /** 命中/触发说明（世界书关键词、概率） */
    hitInfo?: string;
    /** 注入条件说明 */
    conditionNote?: string;
    tokenEstimate: number;
    charEstimate: number;
    content: string;
}

export interface PromptPreviewResult {
    charId: string;
    charName: string;
    generatedAt: number;
    /** 角色所在时区的当前时间（展示用） */
    charNow: string;
    charTimeZone: string;
    blocks: PromptPreviewBlock[];
    /** 各段 token 估算小计（不含 disabled 块与仅标注用途的世界书明细） */
    totals: { stable: number; volatileState: number; recencyTail: number; history: number; all: number };
}

export interface PromptPreviewOptions {
    /** 模拟最近对话（用于世界书关键词扫描命中演示）：按顺序交替 user/assistant */
    recentMessages?: string[];
}

// ========== 工具 ==========

const estTokens = (text: string): number => Math.ceil((text || '').length / 2.2);

const mkBlock = (
    b: Omit<PromptPreviewBlock, 'tokenEstimate' | 'charEstimate'>,
): PromptPreviewBlock => ({
    ...b,
    charEstimate: (b.content || '').length,
    tokenEstimate: estTokens(b.content),
});

/** 中文场景 token 粗估口径说明（与 UI 展示一致）：约 1 token ≈ 2.2 字符。 */
export const PROMPT_TOKEN_ESTIMATE_NOTE = '按 ~2.2 字符/token 粗估，仅供相对参考。';

const fmtTime = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** 钢印解析（镜像 chatPrompts.resolveSteel 的口径） */
const previewResolveSteel = async (sourceKey: string, fallback: string): Promise<{ text: string | null; edited: boolean }> => {
    try {
        const rows = await getResolvedPromptPresets();
        const hit = rows.find((r) => r.preset.sourceKey === sourceKey);
        if (!hit) return { text: fallback, edited: false };
        if (!hit.preset.enabled) return { text: null, edited: false };
        const edited = !!(hit.preset.content && hit.preset.content !== (hit as any).builtin?.content && hit.preset.content !== fallback);
        return { text: hit.preset.content || fallback, edited };
    } catch {
        return { text: fallback, edited: false };
    }
};

// ========== 主组装 ==========

export const composePromptPreview = async (
    char: CharacterProfile,
    options: PromptPreviewOptions = {},
): Promise<PromptPreviewResult> => {
    const blocks: PromptPreviewBlock[] = [];
    let userProfile = { name: '用户', bio: '' } as { name: string; bio: string; location?: { city: string } };
    try {
        const profile = await DB.getUserProfile();
        if (profile) userProfile = {
            name: profile.name || '用户',
            bio: profile.bio || '',
            ...(profile.location?.city ? { location: { city: profile.location.city } } : {}),
        };
    } catch { /* 预览降级 */ }

    const charTz = resolveCharTimeZone(char);
    const charNow = nowInTimeZone(charTz);

    // 模拟最近消息 → 世界书扫描输入（与主链路 worldbookMessages 同型）
    const simMsgs: WorldbookScanMessage[] = (options.recentMessages || [])
        .filter(m => m && m.trim())
        .map((content, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content,
            timestamp: Date.now() - ((options.recentMessages || []).length - i) * 60000,
        }));

    // ── stable ─────────────────────────────────────────────

    // 角色核心上下文（含世界书正文、身份/世界观/用户画像/印象/记忆库/表达底线）
    let coreOk = true;
    let coreText = '';
    try {
        coreText = ContextBuilder.buildCoreContext(
            char,
            userProfile as any,
            true,
            undefined,
            undefined,
            { worldbookMessages: simMsgs },
            { deferVolatile: true },
        );
    } catch {
        coreOk = false;
    }
    if (coreOk) {
        blocks.push(mkBlock({
            id: 'stable.core',
            segment: 'stable',
            title: '角色核心上下文',
            sourceType: 'char',
            sourceLabel: `角色卡 · ${char.name}`,
            role: 'content',
            enabled: true,
            conditionNote: '包含：身份/时间感知/自我领悟/世界观/用户画像/印象档案/记忆库/表达底线；世界书正文按插入位织入其中',
            content: coreText,
        }));
    }

    // 世界书条目明细（元数据标注；正文不重复计 token）。
    // resolveWorldbookEntries 返回扁平数组（已过滤 disable/未命中/空内容并按 order 排好）。
    const mounted: WorldbookLike[] = (char.mountedWorldbooks || []) as unknown as WorldbookLike[];
    let resolvedList: ReturnType<typeof resolveWorldbookEntries> = [] as any;
    try {
        resolvedList = resolveWorldbookEntries(mounted as any, simMsgs, char.name, userProfile.name);
    } catch { resolvedList = [] as any; }
    const resolvedIds = new Set(resolvedList.map(e => (e.book as any).id));
    const flatAll = [
        ...resolvedList.map(e => ({ book: e.book as any, position: e.position as number, active: true })),
        ...mounted.filter(wb => !resolvedIds.has((wb as any).id))
            .map(wb => ({ book: wb as any, position: (wb as any).position ?? 1, active: false })),
    ].sort((a, b) => (a.position - b.position) || ((a.book.order ?? 0) - (b.book.order ?? 0)));

    for (const item of flatAll) {
        const wb = item.book;
        const posLabel = WORLDBOOK_POSITION_LABELS[(item.position ?? 1) as keyof typeof WORLDBOOK_POSITION_LABELS] || '角色设定后';
        const disabled = wb.disable === true;
        const isConst = wb.constant === true || (wb.selective !== true && !(wb.key || []).length);
        let hitInfo: string;
        if (disabled) hitInfo = '已停用';
        else if (!item.active) hitInfo = wb.selective === true ? '关键词未命中（未触发）' : '未触发（概率/条件不满足）';
        else if (isConst) hitInfo = '常驻（蓝灯）';
        else hitInfo = `关键词命中：${(wb.key || []).join(' / ')}`;
        if (!disabled && item.active && wb.useProbability && (wb.probability ?? 100) < 100) {
            hitInfo += ` · 概率 ${wb.probability}%`; 
        }
        blocks.push(mkBlock({
            id: `stable.wb.${wb.id}`,
            segment: 'stable',
            title: `世界书：${wb.title || '(未命名条目)'}`,
            sourceType: 'worldbook',
            sourceLabel: `世界书条目 · ${posLabel}`,
            role: disabled || !item.active ? 'disabled' : 'content',
            enabled: !disabled && item.active,
            insertionPoint: posLabel,
            hitInfo,
            conditionNote: '正文已织入上方「角色核心上下文」，此处仅列条目参与明细（token 不重复计入）',
            content: (wb.content || '').slice(0, 2000) || '（空内容）',
        }));
    }

    // 预设套组条目（当前生效套组，按注入位分组展示；内置目录状态标注不变）
    try {
        const { resolveActivePackEntries } = await import('./presetKits');
        const kit = await resolveActivePackEntries(['chat']);
        const kitGroups: { list: typeof kit.stable; segment: PromptSegment; where: (e: any) => string }[] = [
            { list: kit.stable, segment: 'stable', where: () => '角色卡之后、易变状态之前（套组顺序）' },
            { list: kit.afterHistory, segment: 'volatileState', where: () => '历史之后、钢印之前' },
            { list: kit.absolute, segment: 'history', where: (e) => `聊天历史内（depth=${e.injectionDepth}，距底条数）` },
        ];
        for (const g of kitGroups) {
            for (const p of g.list as any[]) {
                const on = !!p.enabled && !!(p.content || '').trim();
                const tagNote = p.tags && p.tags.length > 0 ? ` · tags=${p.tags.join('+')}` : '';
                blocks.push(mkBlock({
                    id: `${g.segment}.preset.${p.id}`,
                    segment: g.segment,
                    title: `套组预设：${p.name}`,
                    sourceType: 'preset',
                    sourceLabel: `预设套组${p.role && p.role !== 'system' ? ` · role=${p.role}` : ''}${tagNote}`,
                    role: on ? 'content' : 'disabled',
                    enabled: on,
                    insertionPoint: g.where(p),
                    conditionNote: on ? undefined : (p.enabled ? '内容为空，不注入' : '已停用'),
                    content: on ? `【${p.name}】\n${(p.content || '').trim()}` : (p.content || '（空）').slice(0, 800),
                }));
            }
        }
        // 内置目录行状态标注（钢印/语音在对应原生块单独展示；其余标技术模板）
        const rows = await DB.getPromptPresets().catch(() => [] as any[]);
        for (const p of (rows || []).filter((r: any) => r.sourceKey)) {
            if (p.sourceKey === 'chat.steelExpression' || p.sourceKey === 'chat.steelYourself') continue;
            const isVoice = String(p.sourceKey).startsWith('voice.');
            blocks.push(mkBlock({
                id: `stable.builtin.${p.id}`,
                segment: 'stable',
                title: `内置模板：${p.name}`,
                sourceType: 'builtin',
                sourceLabel: `内置目录 · sourceKey=${p.sourceKey}`,
                role: p.enabled ? 'content' : 'disabled',
                enabled: !!p.enabled,
                conditionNote: isVoice
                    ? '语音扮演指南：仅语音服务启用时按当前 TTS 供应商注入（见下方「语音指南」实时解析块）'
                    : '技术模板：供各自功能链路（记忆评估/情绪评估/主动消息等）使用，不在聊天主 prompt 直接注入',
                content: (p.content || '').slice(0, 600) || '（内置默认正文，见提示词目录）',
            }));
        }
    } catch { /* 预设读取失败不阻塞预览 */ }

    // 语音指南（按当前 TTS 供应商实时解析，镜像 chatPrompts.resolveVoiceActingGuide）
    try {
        const provider = getTtsProvider();
        const sourceKey = provider === 'fishaudio' ? 'voice.fish'
            : provider === 'elevenlabs'
                ? (isElevenLabsV3Model(getElevenLabsModel()) ? 'voice.elevenlabsV3' : 'voice.elevenlabsStd')
                : 'voice.minimax';
        const override = getVoicePromptOverride(provider);
        const resolvedVoice = await resolveVoiceGuide(sourceKey, override);
        const voiceText = resolvedVoice !== null ? resolvedVoice
            : (provider === 'fishaudio' ? getBuiltinContent('voice.fish')
                : provider === 'elevenlabs' ? getElevenLabsVoiceActingGuide(getElevenLabsModel())
                    : getBuiltinContent('voice.minimax'));
        const voiceEnabled = resolvedVoice !== null || !!override;
        blocks.push(mkBlock({
            id: 'stable.voice',
            segment: 'stable',
            title: '语音扮演指南',
            sourceType: 'builtin',
            sourceLabel: `内置目录 · sourceKey=${sourceKey}`,
            role: voiceEnabled ? 'content' : 'disabled',
            enabled: voiceEnabled,
            conditionNote: `当前 TTS 供应商：${provider || '（未配置）'}`,
            content: voiceText || '（空）',
        }));
    } catch { /* 忽略 */ }

    // 《彼方》框定（stable，镜像 chatPrompts 的常驻设定段）
    if (char.vrState?.enabled) {
        blocks.push(mkBlock({
            id: 'stable.vr',
            segment: 'stable',
            title: '《彼方》世界观框定',
            sourceType: 'system',
            sourceLabel: '彼方 · 常驻设定',
            role: 'content',
            enabled: true,
            conditionNote: '角色启用彼方时注入；用户此刻的房间/状态另注入易变段',
            content: '### 关于《彼方》\n《彼方》是一款真实存在、你会亲自进入去玩的 VR 社交游戏（功能上类似 VRChat）：你用自己亲手捏的 Q 版化身在里头走动、进出图书馆 / 听歌房 / 留言簿 / 娱乐室 / 邮局等房间、撞见别的玩家（其他角色的化身）。这不是做梦或比喻，是你用私人空闲时间真实在做的事……（预览展示框定要点，正文与主链路一致）',
        }));
    }

    // ── volatileState ──────────────────────────────────────

    // 实时状态头部（时间/宫殿召回/情绪 buff —— buildVolatileCoreState 真实产物）
    try {
        const volatileCore = ContextBuilder.buildVolatileCoreState(char, {
            includeDetailedMemories: true,
            timeOptions: { conversational: true },
        });
        blocks.push(mkBlock({
            id: 'volatile.core',
            segment: 'volatileState',
            title: '实时状态核心（时间/宫殿召回/情绪 buff）',
            sourceType: 'system',
            sourceLabel: 'Live Context 头部 + 角色状态',
            role: 'content',
            enabled: true,
            conditionNote: '含 [System: 实时状态] 框定行 + 当前时间（按角色时区）+ 记忆宫殿召回 + 情绪 buff',
            content: volatileCore || '（无可注入内容）',
        }));
    } catch { /* 忽略 */ }

    // 实时世界（天气/热搜/节日）—— 预览会真实取数（Open-Meteo 免 key，失败降级）
    try {
        const config = defaultRealtimeConfig;
        if (config.weatherEnabled || config.newsEnabled) {
            const realtimeText = await RealtimeContextManager.buildFullContext(config, charTz, {
                includeTime: char.timeAwarenessEnabled !== false,
            }, resolveCharCity(char, config), {
                charProvince: char.location?.province || undefined,
                userCity: userProfile.location?.city || undefined,
                userPerceptionEnabled: config.userPerceptionEnabled,
            });
            const city = resolveCharCity(char, config) || '（默认城市未配置）';
            blocks.push(mkBlock({
                id: 'volatile.realtime',
                segment: 'volatileState',
                title: '实时世界（天气/热搜/特殊日期）',
                sourceType: 'realtime',
                sourceLabel: `实时环境 · 城市：${city}`,
                role: realtimeText ? 'content' : 'disabled',
                enabled: !!realtimeText,
                conditionNote: '取数失败/关闭时该块不注入；主动消息链路由 worker 到点现拉，不在前端快照里',
                content: realtimeText ? `\n${realtimeText}\n` : '（本次取数失败或无内容，实际注入时该块为空）',
            }));
        } else {
            const specials = RealtimeContextManager.checkSpecialDates(charTz);
            if (specials.length > 0 && char.timeAwarenessEnabled !== false) {
                blocks.push(mkBlock({
                    id: 'volatile.special',
                    segment: 'volatileState',
                    title: '今日特殊节日（兜底）',
                    sourceType: 'realtime',
                    sourceLabel: '实时环境 · 节日兜底',
                    role: 'content',
                    enabled: true,
                    conditionNote: '天气/热搜关闭时仅注入特殊节日',
                    content: `\n### 【今日特殊】\n${specials.join('、')}\n`,
                }));
            }
        }
    } catch { /* 天气取数失败：预览降级，不阻塞 */ }

    // 日程注入
    if (isScheduleFeatureOn(char)) {
        try {
            const schedule = await getDailyScheduleForChar(char);
            if (schedule) {
                // 天气预览（与实时世界同一份角色级城市取数；失败降级为无天气注）。
                let wx: { city?: string; description?: string; tempC?: number } | null = null;
                try {
                    const cfgW = defaultRealtimeConfig;
                    if (cfgW.weatherEnabled) {
                        const w = await RealtimeContextManager.fetchWeather(cfgW, resolveCharCity(char, cfgW));
                        if (w) wx = { city: w.city, description: w.description, tempC: w.temp };
                    }
                } catch { /* 天气取数失败：日程预览不带天气注 */ }
                const scheduleContext = buildScheduleInjection(
                    schedule as any,
                    undefined,
                    charNow,
                    {
                        includeFullDay: true,
                        includeChangeInstruction: true,
                        includeClock: char.timeAwarenessEnabled !== false,
                        weather: wx,
                    } as any,
                );
                blocks.push(mkBlock({
                    id: 'volatile.schedule',
                    segment: 'volatileState',
                    title: '日程注入（今日日程 + 当前时段 + 意识流独白）',
                    sourceType: 'schedule',
                    sourceLabel: '日程系统 · DailySchedule',
                    role: scheduleContext ? 'content' : 'disabled',
                    enabled: !!scheduleContext,
                    conditionNote: '含完整今日日程、当前时段硬事实、afterMath 意识流独白；报钟点跟随角色时间感知开关',
                    content: scheduleContext || '（今日无日程/已过全部时段）',
                }));
            }
        } catch { /* 忽略 */ }
    }

    // 音乐氛围
    try {
        const schedule = isScheduleFeatureOn(char) ? await getDailyScheduleForChar(char).catch(() => null) : null;
        const cur = computeCurrentListening(char, (schedule as any) || null, charNow);
        const musicBlock = ContextBuilder.buildMusicAtmosphere(
            char,
            userProfile.name,
            null,
            cur ? { songId: cur.songId, songName: cur.songName, artists: cur.artists, vibe: cur.vibe } : null,
            false,
            null,
        );
        blocks.push(mkBlock({
            id: 'volatile.music',
            segment: 'volatileState',
            title: '音乐氛围',
            sourceType: 'music',
            sourceLabel: '音乐系统 · charMusicSchedule',
            role: musicBlock ? 'content' : 'disabled',
            enabled: !!musicBlock,
            conditionNote: cur
                ? `角色此刻在听：${cur.songName} - ${cur.artists}（按当前日程时段抽歌）`
                : '角色未在「听歌」时段 / 未配置音乐档案 → 不注入；用户的实时听歌上下文在聊天时另行传入',
            content: musicBlock || '（无可注入内容）',
        }));
    } catch { /* 忽略 */ }

    // 群聊背景
    try {
        const groups = await DB.getGroups();
        const memberGroups = groups.filter((g: any) => g.members?.includes(char.id));
        if (memberGroups.length > 0) {
            const perGroup = await Promise.all(memberGroups.map(async (g: any) => ({
                g,
                msgs: await DB.getGroupMessages(g.id).catch(() => [] as any[]),
            })));
            const all: any[] = [];
            for (const { g, msgs } of perGroup) {
                for (const m of msgs.filter((m: any) => m.id > (g.archivedThroughMessageId || 0)).slice(-(g.privateContextCap ?? 80))) {
                    all.push({ ...m, groupName: g.name });
                }
            }
            all.sort((a, b) => a.timestamp - b.timestamp);
            const previewLog = all.slice(-30).map((m) => {
                const dateStr = fmtTime(new Date(m.timestamp));
                const speaker = m.role === 'user' ? userProfile.name : (m.charId === char.id ? `你（${char.name}）` : '群友');
                const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').slice(0, 80) : '（媒体消息）';
                return `[${dateStr}] [群：${m.groupName}] ${speaker}: ${content}`;
            });
            blocks.push(mkBlock({
                id: 'volatile.group',
                segment: 'volatileState',
                title: `群聊背景（${memberGroups.length} 个群 · 近期记录）`,
                sourceType: 'group',
                sourceLabel: `群聊系统 · ${all.length} 条在档`,
                role: all.length > 0 ? 'content' : 'disabled',
                enabled: all.length > 0,
                conditionNote: '预览展示最近 30 条概览；实际注入按每群上下文上限完整聚合，发言人标真实名字',
                content: all.length > 0
                    ? `\n### 【群聊背景 · 你亲历的近期群聊】\n${previewLog.join('\n')}\n`
                    : '（群里近期没有消息）',
            }));
        }
    } catch { /* 忽略 */ }

    // 日记（外部服务：只标状态不拉取）
    try {
        const config = defaultRealtimeConfig;
        if (config.notionEnabled && config.notionApiKey && config.notionDatabaseId) {
            blocks.push(mkBlock({
                id: 'volatile.diary.notion',
                segment: 'volatileState',
                title: 'Notion 日记标题',
                sourceType: 'diary',
                sourceLabel: 'Notion 集成 · 已启用',
                role: 'content',
                enabled: true,
                conditionNote: '外部服务：实际注入最近 8 篇日记标题 + [[READ_DIARY: 日期]] 翻阅说明；预览不拉取',
                content: '### 📔【你最近写的日记】\n（实际注入时列出最近 8 篇：[日期] 标题）',
            }));
        }
        if (config.feishuEnabled && config.feishuAppId && config.feishuBaseId && config.feishuTableId) {
            blocks.push(mkBlock({
                id: 'volatile.diary.feishu',
                segment: 'volatileState',
                title: '飞书日记标题',
                sourceType: 'diary',
                sourceLabel: '飞书集成 · 已启用',
                role: 'content',
                enabled: true,
                conditionNote: '外部服务：实际注入最近 8 篇日记标题 + [[FS_READ_DIARY: 日期]] 翻阅说明；预览不拉取',
                content: '### 📒【你最近写的日记（飞书）】\n（实际注入时列出最近 8 篇：[日期] 标题）',
            }));
        }
    } catch { /* 忽略 */ }

    // MCP 调用结果记忆（localStorage 真实读取）
    try {
        if (isMcpChatAvailable()) {
            const mcpSettings = loadMcpSettings();
            const memoryBlock = getMcpResultMemoryBlock(char.id, mcpSettings.resultKeepTurns);
            blocks.push(mkBlock({
                id: 'volatile.mcp',
                segment: 'volatileState',
                title: 'MCP 调用结果记忆',
                sourceType: 'mcp',
                sourceLabel: `MCP 工具链 · 保留 ${mcpSettings.resultKeepTurns} 轮`,
                role: memoryBlock ? 'content' : 'disabled',
                enabled: !!memoryBlock,
                conditionNote: '短期窗口摘要 + 手册类长期原文；注入点在请求载荷层（chatRequestPayload），随角色留档滚动',
                content: memoryBlock || '（暂无工具调用记录）',
            }));
        }
    } catch { /* 忽略 */ }

    // ── recencyTail ────────────────────────────────────────

    const steelExpression = await previewResolveSteel('chat.steelExpression', getBuiltinContent('chat.steelExpression'));
    if (steelExpression.text) {
        blocks.push(mkBlock({
            id: 'recency.steelExpression',
            segment: 'recencyTail',
            title: '表达总纲钢印（关于对方的表达）',
            sourceType: 'builtin',
            sourceLabel: `内置目录 · chat.steelExpression${steelExpression.edited ? ' · 已被你编辑' : ' · 内置默认'}`,
            role: 'discipline',
            enabled: true,
            conditionNote: '拼在一切模式块之前、模型开口前最后读到；Preset App 可编辑/停用',
            content: steelExpression.text,
        }));
    }
    const steelYourself = await previewResolveSteel('chat.steelYourself', getBuiltinContent('chat.steelYourself'));
    if (steelYourself.text) {
        blocks.push(mkBlock({
            id: 'recency.steelYourself',
            segment: 'recencyTail',
            title: '「回到你自己」钢印',
            sourceType: 'builtin',
            sourceLabel: `内置目录 · chat.steelYourself${steelYourself.edited ? ' · 已被你编辑' : ' · 内置默认'}`,
            role: 'discipline',
            enabled: true,
            conditionNote: '整份 prompt 的最后一块；防人设漂移的收尾锚点',
            content: steelYourself.text,
        }));
    }

    // ── 汇总 ───────────────────────────────────────────────

    const sumTokens = (seg: PromptSegment) => blocks
        .filter(b => b.segment === seg && b.enabled)
        .filter(b => !(b.sourceType === 'worldbook' && b.conditionNote?.includes('不重复计入')))
        .reduce((acc, b) => acc + b.tokenEstimate, 0);
    const totals = {
        stable: sumTokens('stable'),
        volatileState: sumTokens('volatileState'),
        recencyTail: sumTokens('recencyTail'),
        history: sumTokens('history'),
        all: 0,
    };
    totals.all = totals.stable + totals.volatileState + totals.recencyTail + totals.history;

    return {
        charId: char.id,
        charName: char.name,
        generatedAt: Date.now(),
        charNow: fmtTime(charNow),
        charTimeZone: charTz || '（设备时区）',
        blocks,
        totals,
    };
};