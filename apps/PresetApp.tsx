/**
 * 「预设」App —— 预设套组（Preset Kit）管理 + 提示词统合观测。
 *
 * 三个页签：
 * - 提示词：当前套组条目（顺序=注入顺序）+ 内置常驻段（可接管落位）+
 *   未入套组 + 正则 + 真实发送查看（抓取视图，唯一完整 prompt 来源）。
 * - 世界书：现有 WorldbookApp 原样嵌入（embedded 隐藏自带顶栏）。
 * - 调用地图：注册表按分类渲染调用卡（门三态 + 抓取直达 + 云端卡）。
 *
 * 数据存 IndexedDB `prompt_presets`（条目）+ `preset_packs`（套组顺序）+
 * `preset_pack_active`（当前指针），随备份动态枚举自动带走。
 *
 * UI 遵循原作玻璃拟态风格：slate 底 + 白/20 玻璃卡片 + Phosphor 线性图标。
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    ArrowLeft, Plus, Trash, CaretUp, CaretDown, PencilSimple,
    Check, X, NoteBlank, Info, DownloadSimple, UploadSimple,
    SquaresFour, ListBullets, BookOpen, MapPin, PaperPlaneTilt, BracketsCurly,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import type { PromptPreset, PresetPack, PresetRegexKit, PresetRegexRule } from '../types';
import {
    BUILTIN_PROMPT_ENTRIES, PROMPT_CATEGORY_META, type PromptCategory,
} from '../utils/promptPresetCatalog';
import { invalidatePromptPresetCache, applyBuiltinDefaultsToPreset } from '../utils/promptPresetRuntime';
import { DEFAULT_PACK_ID, DEFAULT_PACK_NAME } from '../utils/presetKitsMigration';
import { exportPresetKit, parsePresetKitShare } from '../utils/presetKitShare';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { applyRegexPlacement, getActiveRegexKitId, invalidatePresetRegexCache, setActiveRegexKitId } from '../utils/presetRegex';
import WorldbookApp from './WorldbookApp';
import { effectiveStatus } from '../utils/presetEffective';
import { getTtsProvider, getElevenLabsModel } from '../utils/ttsProvider';
import { isElevenLabsV3Model } from '../utils/elevenLabsTts';
import { getCaptured, renderCapturedText } from '../utils/promptCallCapture';
import { CALL_REGISTRY } from '../utils/promptCallRegistry';
import type { CallSite, CallGate } from '../utils/promptCallRegistry';

/** 内置条目在各注入点的位置说明（与 chatPrompts 实际逻辑同步维护） */
const BUILTIN_INJECTION_WHERE: Record<string, string> = {
    'chat.steelExpression': '聊天 · recency 尾部（模型开口前最后读到的内容之一）',
    'chat.steelYourself': '聊天 · recency 尾部（紧跟「关于对方的表达」之后）',
    'date.digDeeper': '约会模式 · 深挖块（见面提示词内）',
    'song.craftRules': '写歌 · 每次创作或点评前',
    'voice.minimax': '语音 · MiniMax 合成前注入',
    'voice.fish': '语音 · Fish 合成前注入',
    'voice.elevenlabsV3': '语音 · ElevenLabs v3 注入',
    'voice.elevenlabsStd': '语音 · ElevenLabs 标准版注入',
    'voice.date': '约会语音 · 注入约会提示词',
    'memory.reflectTask': '记忆 · 反刍任务模板',
    'memory.personalityDetect': '记忆 · 人格检测模板',
    'memory.extractionRules': '记忆 · 抽取规则模板',
    'memory.extractionEntityRule': '记忆 · 实体抽取规则模板',
    'memory.extractionMain': '记忆 · 抽取主模板',
    'memory.recallRouter': '记忆 · 检索路由模板',
    'amsg.emotionEval': '主动消息 · 情绪评估主模板',
    'amsg.emotionEvalMindful': '主动消息 · 情绪评估（正念模式）',
    'amsg.emotionEvalLiving': '主动消息 · 情绪评估（生活模式）',
    'chat.perspectiveTool': '聊天 · ChatApp 行为规范内（透视窗使用指南）',
    'chat.appRules': '聊天 · ChatApp 行为规范内（各槽位按条件回填）',
    'rel.genGuide': '人物关系 · 生成任务模板（神经连接 → 人物关系）',
};

/** 场景 tags 固定词表（下拉/多选只从这里取，不手填）。 */
const TAG_DEFS: { id: string; label: string }[] = [
    { id: 'chat', label: '聊天' },
    { id: 'date', label: '约会' },
    { id: 'story', label: '剧场' },
    { id: 'song', label: '写歌' },
    { id: 'phone', label: '查手机' },
    { id: 'memory', label: '记忆' },
];

const tagLabel = (id: string): string => TAG_DEFS.find(t => t.id === id)?.label || id;

/** 可接管的 sourceKey 行：落位下拉切到非 native 即走套组管道（原生点跳过）。 */
const ADOPTABLE_KEYS = new Set([
    'chat.steelExpression',
    'chat.steelYourself',
    'chat.perspectiveTool',
    'chat.appRules',
]);

const ADOPT_OPTIONS: { v: string; label: string }[] = [
    { v: 'native', label: '原生位' },
    { v: 'stable', label: '接管·角色卡后' },
    { v: 'afterHistory', label: '接管·历史后' },
    { v: 'absolute', label: '接管·历史内' },
];

/** 真实发送 overlay 列的抓取站点（Task 1 captureCall 的 7 个本地抓取点）。 */
const CAPTURE_SITES: { site: string; name: string }[] = [
    { site: 'chat-main', name: '主聊天请求' },
    { site: 'emotion-eval', name: '情绪评估' },
    { site: 'memory-extract', name: '记忆提取' },
    { site: 'memory-digest', name: '记忆消化' },
    { site: 'rel-gen', name: '人物关系生成' },
    { site: 'song-mentor', name: '写歌导师' },
    { site: 'date-session', name: '见面主回复' },
];

/** 调用地图时序（顶部时序卡按此顺序列数）。 */
const MAP_TRIGGERS = ['发送前', '每轮回复后', '手动按钮', '定时 fire', '工具轮内'] as const;

type PageId = 'prompt' | 'worldbook' | 'map';

const PAGES: { id: PageId; label: string; icon: React.ReactNode }[] = [
    { id: 'prompt', label: '提示词', icon: <ListBullets size={16} weight="bold" /> },
    { id: 'worldbook', label: '世界书', icon: <BookOpen size={16} weight="bold" /> },
    { id: 'map', label: '调用地图', icon: <MapPin size={16} weight="bold" /> },
];

/** 正则作用域选项（placement 值；4/仅显示 v1 未接，不提供）。 */
const REGEX_PLACEMENTS: { value: number; label: string; hint: string }[] = [
    { value: 1, label: '输入', hint: '发送前改用户话' },
    { value: 2, label: '输出', hint: 'AI 回复落库前改' },
    { value: 5, label: '发模型', hint: '预设条目发出前改' },
];

/** 采样参数字段：key=PresetGeneration 字段，label=UI 名，hint=占位说明。空=跟 API 设置。 */
const GEN_FIELDS: { key: 'temperature' | 'topP' | 'topK' | 'frequencyPenalty' | 'presencePenalty' | 'maxTokens'; label: string }[] = [
    { key: 'temperature', label: '温度' },
    { key: 'topP', label: 'Top P' },
    { key: 'topK', label: 'Top K' },
    { key: 'frequencyPenalty', label: '频率惩罚' },
    { key: 'presencePenalty', label: '存在惩罚' },
    { key: 'maxTokens', label: 'Max Tokens' },
];

const cardCls = (on: boolean) => `rounded-2xl border backdrop-blur-md transition-shadow ${
    on ? 'bg-white/70 border-white/60 shadow-sm' : 'bg-white/40 border-white/40 opacity-70'
}`;

const PresetApp: React.FC = () => {
    const { closeApp, addToast } = useOS();
    const [page, setPage] = useState<PageId>('prompt');
    const [packs, setPacks] = useState<PresetPack[]>([]);
    const [activeId, setActiveId] = useState<string>(DEFAULT_PACK_ID);
    const [rows, setRows] = useState<PromptPreset[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draftName, setDraftName] = useState('');
    const [draftContent, setDraftContent] = useState('');
    const [expandedId, setExpandedId] = useState<string | null>(null);
    /** 两段式删除确认：存放已 armed 的 id。 */
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [packEditingId, setPackEditingId] = useState<string | null>(null);
    const [packDraftName, setPackDraftName] = useState('');
    const [genOpenId, setGenOpenId] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    // 角色（全对象：生效判据要读语音/透视窗/深挖开关）+ 统一选中（角色 chip/预览/overlay 共用）
    const [chars, setChars] = useState<any[]>([]);
    const [selectedCharId, setSelectedCharId] = useState('');
    // 套组管理 sheet / 内置分组折叠（聊天组默认展开）/ 真实发送 overlay / 底部正则·预览折叠
    const [packSheet, setPackSheet] = useState(false);
    const [collapsedCats, setCollapsedCats] = useState<Record<string, boolean>>({});
    const [overlayOpen, setOverlayOpen] = useState(false);
    const [overlaySite, setOverlaySite] = useState<string | null>(null);
    const [regexOpen, setRegexOpen] = useState(false);
    // 正则页
    const [regexKits, setRegexKits] = useState<PresetRegexKit[]>([]);
    const [activeRegexId, setActiveRegexId] = useState<string | null>(null);
    const [ruleEditId, setRuleEditId] = useState<string | null>(null);
    const [ruleDraft, setRuleDraft] = useState({ name: '', find: '', replace: '' });
    const [testInput, setTestInput] = useState('你好{{user}}，今天[昨天]很开心((笑))');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [p, a, r, cs, rk, ra] = await Promise.all([
                DB.getPresetPacks(),
                DB.getActivePackId(),
                DB.getPromptPresets(),
                DB.getAllCharacters().catch(() => [] as { id: string; name: string }[]),
                DB.getPresetRegexes().catch(() => [] as PresetRegexKit[]),
                getActiveRegexKitId().catch(() => null),
            ]);
            setPacks(p);
            setActiveId(a);
            setRows(r);
            setRegexKits(rk || []);
            setActiveRegexId(ra ?? (rk && rk[0] ? rk[0].id : null));
            const list = (cs || []) as any[];
            setChars(list);
            const saved = localStorage.getItem('preset_preview_char') || '';
            setSelectedCharId(saved && list.some(c => c.id === saved) ? saved : (list[0]?.id || ''));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const byId = new Map(rows.map(r => [r.id, r]));
    const activePack = packs.find(p => p.id === activeId)
        ?? packs.find(p => p.id === DEFAULT_PACK_ID)
        ?? { id: DEFAULT_PACK_ID, name: DEFAULT_PACK_NAME, entryIds: [], createdAt: 0, updatedAt: 0 };
    // 套组条目只取无 sourceKey 的自定义行：内置行永不进 entryIds，
    // 即使某套组被污染也只在内置常驻段渲染，不双重显示。
    const packEntries = (activePack.entryIds || [])
        .map(id => byId.get(id))
        .filter((r): r is PromptPreset => !!r && !r.sourceKey);
    const referencedIds = new Set(packs.flatMap(p => p.entryIds || []));
    const unmanaged = rows.filter(r => !r.sourceKey && !referencedIds.has(r.id));

    // ── 角色选中 + 生效判据上下文（Task 3 三元组：读 {state, reason, adopted}）──
    const selectedChar = chars.find(c => c.id === selectedCharId) ?? null;
    const effCtx = useMemo(() => {
        if (!selectedChar) return null;
        return {
            char: selectedChar as any,
            provider: getTtsProvider(),
            // 语音互斥用模型级消歧（与 resolveVoiceActingGuide 同源）：elevenlabs 用户恰一行生效。
            isElevenLabsV3: isElevenLabsV3Model(getElevenLabsModel()),
            activeTags: ['chat'],
        };
    }, [selectedChar]);
    const selectChar = (id: string) => {
        setSelectedCharId(id);
        if (id) localStorage.setItem('preset_preview_char', id);
        else localStorage.removeItem('preset_preview_char');
    };

    /** 内置常驻行：按目录 order 全局排序，分组时再按分类切分。 */
    const builtinRows = useMemo(
        () => rows.filter(r => r.sourceKey).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
        [rows],
    );
    const isCatOpen = (id: string) => !(collapsedCats[id] ?? (id !== 'chat'));

    /** 互斥组头：语音当前供应商/模型；情绪当前 scheduleStyle 三选一（与 useChatAI 同口径）。 */
    const voiceNow = (() => {
        try {
            const p = getTtsProvider();
            if (p === 'elevenlabs') return isElevenLabsV3Model(getElevenLabsModel()) ? 'ElevenLabs v3' : 'ElevenLabs 标准模型';
            if (p === 'fishaudio') return 'Fish';
            return 'MiniMax';
        } catch {
            return 'MiniMax';
        }
    })();
    const emoNow = !selectedChar
        ? '未选角色'
        : selectedChar.scheduleStyle === 'mindful'
            ? '意识系规则'
            : (selectedChar.scheduleStyle === 'lifestyle' || selectedChar.scheduleStyle === 'living')
                ? '生活系规则'
                : '主模板';

    /** 生效徽标：off/off-disabled 等价（皆「不注入·已停用」）；已接管只看 adopted 标志。 */
    const effBadge = (entry: PromptPreset) => {
        if (!effCtx) return null;
        let st;
        try {
            st = effectiveStatus(entry, effCtx);
        } catch {
            return null;
        }
        const live = st.state === 'on' || st.state === 'on-fallback' || st.state === 'on-adopted';
        return (
            <span className="flex items-center gap-1 shrink-0">
                {st.adopted && (
                    <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-amber-100 text-amber-600 shrink-0">已接管</span>
                )}
                <span
                    title={st.reason}
                    className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold shrink-0 ${live ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}
                >
                    {st.reason}
                </span>
            </span>
        );
    };

    /** 内置行拖动排序：只写回双方 order（不动套组 entryIds）。 */
    const swapBuiltinOrder = async (a: PromptPreset, b: PromptPreset) => {
        if (a.id === b.id) return;
        const na = { ...a, order: b.order, updatedAt: Date.now() };
        const nb = { ...b, order: a.order, updatedAt: Date.now() };
        setRows(rows.map(r => r.id === a.id ? na : r.id === b.id ? nb : r));
        try {
            await DB.savePromptPreset(na);
            await DB.savePromptPreset(nb);
            invalidatePromptPresetCache();
        } catch {
            addToast('保存失败', 'error');
        }
    };

    // ── 真实发送 overlay 数据：当前角色各抓取站点最近一条 ──
    const overlayRecords = useMemo(() => {
        if (!selectedCharId) return [];
        return CAPTURE_SITES.map(s => {
            const list = getCaptured(s.site).filter(e => e.meta.charId === selectedCharId);
            return { ...s, latest: list[0] ?? null, count: list.length };
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedCharId, overlayOpen]);

    const copyCaptureText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            addToast('已复制全文', 'success');
        } catch {
            addToast('复制失败', 'error');
        }
    };

    const exportCaptureText = async (site: string, text: string, at: number) => {
        try {
            const d = new Date(at);
            const pad = (n: number) => String(n).padStart(2, '0');
            const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
            await shareOrDownloadBlob({
                blob: new Blob([text], { type: 'text/plain' }),
                fileName: `capture-${site}-${stamp}.txt`,
                shareTitle: `真实发送记录 ${site}`,
            });
        } catch (e: any) {
            addToast(e?.message || '导出失败', 'error');
        }
    };

    // ── 调用地图：分组 + 门三态 + 抓取直达 + sourceKey 跳转 ──
    /** 注册表按分类分组（保持登记顺序，即 spec §7 清单顺序）。 */
    const mapGroups = useMemo(() => {
        const groups: { category: string; sites: CallSite[] }[] = [];
        for (const s of CALL_REGISTRY) {
            const g = groups.find(x => x.category === s.category);
            if (g) g.sites.push(s);
            else groups.push({ category: s.category, sites: [s] });
        }
        return groups;
    }, []);

    /** 当前角色各本地站点的抓取（最近一条时间 + 条数；打开 overlay 即重算）。 */
    const mapCaptures = useMemo(() => {
        const m = new Map<string, { at: number; count: number }>();
        if (selectedCharId) {
            for (const s of CALL_REGISTRY) {
                if (s.visibility !== 'local') continue;
                const list = getCaptured(s.site).filter(e => e.meta.charId === selectedCharId);
                if (list[0]) m.set(s.site, { at: list[0].meta.at, count: list.length });
            }
        }
        return m;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedCharId, page, overlayOpen]);

    /**
     * 门三态（按当前角色实时算）：
     * - manual/global 门不随角色变 → 'idle'（中性徽标：手动 / 全局）。
     * - char 门读选中角色同名字段 → 有/开='on'，无/关='off'，未选角色='idle'。
     */
    const gateTone = (g: CallGate): 'on' | 'off' | 'idle' => {
        if (g.kind !== 'char') return 'idle';
        if (!selectedChar) return 'idle';
        let cur: any = selectedChar;
        for (const k of g.ref.replace(/^char\./, '').split('.')) {
            if (cur == null) return 'off';
            cur = cur[k];
        }
        return cur ? 'on' : 'off';
    };

    const gateChip = (g: CallGate, i: number) => {
        const tone = gateTone(g);
        const mark = g.kind === 'manual'
            ? '手动'
            : g.kind === 'global'
                ? '全局'
                : tone === 'on' ? '开' : tone === 'off' ? '关' : '未选角色';
        const cls = tone === 'on'
            ? 'bg-emerald-50 text-emerald-600'
            : tone === 'off'
                ? 'bg-red-50 text-red-500'
                : 'bg-slate-100 text-slate-400';
        return (
            <span
                key={i}
                title={`${g.label} · ${g.ref}`}
                className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold shrink-0 ${cls}`}
            >
                {g.label} · {mark}
            </span>
        );
    };

    /** sourceKey 点跳页1对应卡：仅内置常驻段可跳；切页 + 展开分类 + 展开卡 + 滚到卡位，锚点缺失则明示 toast（不静默）。 */
    const jumpToSource = (key: string) => {
        const row = builtinRows.find(r => r.sourceKey === key);
        if (!row) {
            addToast('该条目尚未播种', 'error');
            return;
        }
        setCollapsedCats(prev => ({ ...prev, [row.category || 'chat']: false }));
        setExpandedId(row.id);
        setPage('prompt');
        setTimeout(() => {
            const el = document.getElementById(`preset-row-${row.id}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            else addToast('对应卡片不在当前列表，请在提示词页手动查找', 'error');
        }, 80);
    };

    const renderMapCard = (s: CallSite) => {
        const cap = mapCaptures.get(s.site);
        return (
            <div key={s.site} className={cardCls(true)}>
                <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
                    <p className="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate" title={s.anchor}>{s.name}</p>
                    {s.visibility === 'local' && (
                        <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-emerald-50 text-emerald-600 shrink-0">本地</span>
                    )}
                    {s.visibility === 'local-uncaptured' && (
                        <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-slate-100 text-slate-400 shrink-0">未接入抓取</span>
                    )}
                    {s.visibility === 'cloud' && (
                        <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-sky-50 text-sky-600 shrink-0">云端</span>
                    )}
                </div>
                <p className="px-3 text-[11px] leading-relaxed text-slate-500">{s.blurb}</p>
                <div className="flex items-center gap-1 px-3 pt-1.5 flex-wrap">
                    {s.gates.map((g, i) => gateChip(g, i))}
                </div>
                {s.visibility === 'cloud' ? (
                    <div className="px-3 pt-1.5 pb-2.5">
                        <p className="text-[9px] font-bold text-slate-400">补段清单</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                            {s.sources.length > 0 ? s.sources.join('、') : '占位提示：到点由 worker 下发真实 prompt，无补段'}
                        </p>
                    </div>
                ) : (
                    s.sources.length > 0 && (
                        <div className="flex items-center gap-1 px-3 pt-1.5 pb-2.5 flex-wrap">
                            <span className="text-[9px] font-bold text-slate-400">消费</span>
                            {s.sources.map(src => src.startsWith('hardcoded:') ? (
                                <span key={src} className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-slate-100 text-slate-500 shrink-0">
                                    {src.slice('hardcoded:'.length)}
                                </span>
                            ) : (
                                <button
                                    key={src}
                                    onClick={() => jumpToSource(src)}
                                    title="跳到提示词页对应条目卡"
                                    className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-violet-50 text-violet-600 shrink-0 active:scale-95 transition-transform"
                                >
                                    {src}
                                </button>
                            ))}
                        </div>
                    )
                )}
                {s.visibility === 'local' && (
                    <div className="px-3 pb-2.5">
                        {cap ? (
                            <button
                                onClick={() => { setOverlaySite(s.site); setOverlayOpen(true); }}
                                className="w-full text-left px-2.5 py-1.5 rounded-xl bg-violet-50 text-violet-600 text-[10px] font-bold active:scale-[0.99] transition-transform"
                            >
                                最近一次 · {new Date(cap.at).toLocaleString()}（{cap.count} 条）→ 查看真实发送
                            </button>
                        ) : (
                            <p className="text-[10px] text-slate-400">暂无抓取：去聊一条消息再回来，绝不拿模拟顶数。</p>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const refresh = useCallback(async (msg?: string) => {
        try {
            const [p, a, r] = await Promise.all([
                DB.getPresetPacks(), DB.getActivePackId(), DB.getPromptPresets(),
            ]);
            setPacks(p);
            setActiveId(a);
            setRows(r);
            invalidatePromptPresetCache();
            if (msg) addToast(msg, 'success');
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        }
    }, [addToast]);

    // ── 套组操作 ──
    const handleSwitchPack = async (id: string) => {
        if (id === activeId) return;
        try {
            await DB.setActivePackId(id);
            setActiveId(id);
            addToast('已切换预设套组', 'success');
        } catch (e: any) {
            addToast(e?.message || '切换失败', 'error');
        }
    };

    const handleNewPack = async () => {
        const now = Date.now();
        const pack: PresetPack = {
            id: crypto.randomUUID(), name: '新预设', entryIds: [],
            createdAt: now, updatedAt: now,
        };
        try {
            await DB.savePresetPack(pack);
            setPacks([...packs, pack]);
            setPackEditingId(pack.id);
            setPackDraftName(pack.name);
        } catch (e: any) {
            addToast(e?.message || '创建失败', 'error');
        }
    };

    const commitPackRename = async () => {
        if (!packEditingId) return;
        const name = packDraftName.trim() || '未命名预设';
        const next = packs.map(p => p.id === packEditingId ? { ...p, name, updatedAt: Date.now() } : p);
        setPacks(next);
        setPackEditingId(null);
        try {
            const hit = next.find(p => p.id === packEditingId);
            if (hit) await DB.savePresetPack(hit);
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        }
    };

    const handleDeletePack = async (id: string) => {
        if (id === DEFAULT_PACK_ID) {
            addToast('默认预设不可删除', 'error');
            return;
        }
        if (confirmId !== id) {
            setConfirmId(id);
            return;
        }
        setConfirmId(null);
        try {
            await DB.deletePresetPack(id);
            const next = packs.filter(p => p.id !== id);
            setPacks(next);
            if (activeId === id) {
                await DB.setActivePackId(DEFAULT_PACK_ID);
                setActiveId(DEFAULT_PACK_ID);
            }
            addToast('套组已删除（条目保留在未入套组里）', 'success');
        } catch (e: any) {
            addToast(e?.message || '删除失败', 'error');
        }
    };

    const savePackGen = async (pack: PresetPack, gen: PresetPack['generation']) => {
        const next = { ...pack, generation: gen, updatedAt: Date.now() };
        setPacks(packs.map(p => p.id === pack.id ? next : p));
        try {
            await DB.savePresetPack(next);
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        }
    };

        // ── 正则操作 ──
    const activeKit = regexKits.find(k => k.id === activeRegexId) ?? regexKits[0] ?? null;

    const saveRegexKit = async (kit: PresetRegexKit) => {
        setRegexKits(regexKits.map(k => k.id === kit.id ? kit : k));
        try {
            await DB.savePresetRegex(kit);
            invalidatePresetRegexCache();
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        }
    };

    const handleNewRegexKit = async () => {
        const now = Date.now();
        const kit: PresetRegexKit = {
            id: crypto.randomUUID(), name: '新正则', rules: [],
            enabled: true, createdAt: now, updatedAt: now,
        };
        try {
            await DB.savePresetRegex(kit);
            setRegexKits([...regexKits, kit]);
            setActiveRegexId(kit.id);
            await setActiveRegexKitId(kit.id);
        } catch (e: any) {
            addToast(e?.message || '创建失败', 'error');
        }
    };

    const handleDeleteRegexKit = async (id: string) => {
        if (confirmId !== id) {
            setConfirmId(id);
            return;
        }
        setConfirmId(null);
        try {
            await DB.deletePresetRegex(id);
            const next = regexKits.filter(k => k.id !== id);
            setRegexKits(next);
            if (activeRegexId === id) {
                const fallback = next[0]?.id ?? null;
                setActiveRegexId(fallback);
                if (fallback) await setActiveRegexKitId(fallback);
                else invalidatePresetRegexCache();
            }
            addToast('正则套件已删除', 'success');
        } catch (e: any) {
            addToast(e?.message || '删除失败', 'error');
        }
    };

    const patchRule = (ruleId: string, patch: Partial<PresetRegexRule>) => {
        if (!activeKit) return;
        void saveRegexKit({
            ...activeKit,
            rules: activeKit.rules.map(r => r.id === ruleId ? { ...r, ...patch } : r),
            updatedAt: Date.now(),
        });
    };

    const handleAddRule = async () => {
        if (!activeKit) {
            addToast('先创建一个正则套件', 'error');
            return;
        }
        const now = Date.now();
        const rule: PresetRegexRule = {
            id: crypto.randomUUID(),
            scriptName: ruleDraft.name.trim() || '新规则',
            findRegex: ruleDraft.find,
            replaceString: ruleDraft.replace,
            placement: [2],
            disabled: false,
        };
        setRuleDraft({ name: '', find: '', replace: '' });
        await saveRegexKit({ ...activeKit, rules: [...activeKit.rules, rule], updatedAt: now });
        setRuleEditId(rule.id);
    };

    const handleDeleteRule = async (ruleId: string) => {
        if (!activeKit) return;
        if (confirmId !== ruleId) {
            setConfirmId(ruleId);
            return;
        }
        setConfirmId(null);
        if (ruleEditId === ruleId) setRuleEditId(null);
        await saveRegexKit({
            ...activeKit,
            rules: activeKit.rules.filter(r => r.id !== ruleId),
            updatedAt: Date.now(),
        });
    };

    const togglePlacement = (rule: PresetRegexRule, placement: number) => {
        const cur = rule.placement || [];
        patchRule(rule.id, {
            placement: cur.includes(placement) ? cur.filter(x => x !== placement) : [...cur, placement],
        });
    };

    const handleExport = async (pack: PresetPack) => {        try {
            const list = (pack.entryIds || []).map(id => byId.get(id)).filter((r): r is PromptPreset => !!r);
            const json = exportPresetKit(pack, list, null);
            const date = new Date().toISOString().slice(0, 10);
            await shareOrDownloadBlob({
                blob: new Blob([json], { type: 'application/json' }),
                fileName: `sully-preset-${pack.id.slice(0, 8)}-${date}.json`,
                shareTitle: `预设分享：${pack.name}`,
            });
        } catch (e: any) {
            addToast(e?.message || '导出失败', 'error');
        }
    };

    const handleImportFile = async (file: File) => {
        try {
            const text = await file.text();
            const parsed = parsePresetKitShare(text);
            const now = Date.now();
            // 重名套组自动后缀
            const names = new Set(packs.map(p => p.name));
            let name = parsed.packName;
            let n = 1;
            while (names.has(name)) {
                n += 1;
                name = `${parsed.packName} (${n})`;
            }
            const idMap = new Map<string, string>();
            const newRows: PromptPreset[] = parsed.entries.map(e => {
                const id = crypto.randomUUID();
                idMap.set(e.key, id);
                return {
                    id,
                    name: e.name,
                    content: e.content,
                    order: 0,
                    enabled: true,
                    createdAt: now,
                    updatedAt: now,
                    identifier: e.key,
                    role: e.role,
                    injectionPosition: e.injectionPosition,
                    injectionDepth: e.injectionDepth ?? 0,
                    afterChatHistory: e.afterChatHistory === true,
                    tags: e.tags,
                } as PromptPreset;
            });
            const pack: PresetPack = {
                id: crypto.randomUUID(),
                name,
                entryIds: parsed.entryKeys.map(k => idMap.get(k)).filter((id): id is string => !!id),
                generation: parsed.generation,
                createdAt: now,
                updatedAt: now,
            };
            for (const r of newRows) await DB.savePromptPreset(r);
            await DB.savePresetPack(pack);
            if (parsed.regexKit) {
                await DB.savePresetRegex({
                    id: crypto.randomUUID(),
                    name: parsed.regexKit.name,
                    rules: parsed.regexKit.rules as any,
                    enabled: true,
                    createdAt: now,
                    updatedAt: now,
                });
            }
            await refresh(`已导入套组「${name}」`);
        } catch (e: any) {
            addToast(e?.message || '导入失败', 'error');
        }
    };

    // ── 条目操作（当前套组）──
    const savePackOrder = async (entryIds: string[]) => {
        const next = { ...activePack, entryIds, updatedAt: Date.now() };
        setPacks(packs.map(p => p.id === next.id ? next : p));
        try {
            await DB.savePresetPack(next);
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        }
    };

    const handleAddEntry = async () => {
        const now = Date.now();
        const id = crypto.randomUUID();
        const item: PromptPreset = {
            id,
            name: '新段落',
            content: '',
            order: 0,
            enabled: true,
            createdAt: now,
            updatedAt: now,
            identifier: `custom_${id.slice(0, 8)}`,
            role: 'system',
            injectionPosition: 'relative',
        };
        try {
            await DB.savePromptPreset(item);
            setRows([...rows, item]);
            await savePackOrder([...(activePack.entryIds || []), id]);
            invalidatePromptPresetCache();
            setEditingId(id);
            setDraftName(item.name);
            setDraftContent('');
            setExpandedId(id);
        } catch (e: any) {
            addToast(e?.message || '创建失败', 'error');
        }
    };

    const handleDeleteEntry = async (id: string) => {
        if (confirmId !== id) {
            setConfirmId(id);
            return;
        }
        setConfirmId(null);
        setRows(rows.filter(r => r.id !== id));
        if (editingId === id) setEditingId(null);
        try {
            await DB.deletePromptPreset(id);
            // 扫掉所有套组里的引用（单 put 各自，套组数量少）
            for (const p of packs) {
                if ((p.entryIds || []).includes(id)) {
                    await DB.savePresetPack({ ...p, entryIds: p.entryIds.filter(x => x !== id), updatedAt: Date.now() });
                }
            }
            const [p] = await Promise.all([DB.getPresetPacks()]);
            setPacks(p);
            invalidatePromptPresetCache();
        } catch {
            addToast('删除失败', 'error');
        }
    };

    const toggleEnabled = async (entry: PromptPreset) => {
        const next = { ...entry, enabled: !entry.enabled, updatedAt: Date.now() };
        setRows(rows.map(r => r.id === entry.id ? next : r));
        try {
            await DB.savePromptPreset(next);
            invalidatePromptPresetCache();
        } catch {
            addToast('保存失败', 'error');
        }
    };

    // 下标按 packEntries（已滤内置）的可见序换算回 entryIds，保证污染套组也不错位。
    const moveEntry = (index: number, dir: -1 | 1) => {
        const visible = packEntries.map(p => p.id);
        const target = index + dir;
        if (target < 0 || target >= visible.length) return;
        const ids = [...(activePack.entryIds || [])];
        const ai = ids.indexOf(visible[index]);
        const bi = ids.indexOf(visible[target]);
        if (ai < 0 || bi < 0) return;
        const tmp = ids[ai];
        ids[ai] = ids[bi];
        ids[bi] = tmp;
        void savePackOrder(ids);
    };

    const joinPack = async (id: string) => {
        await savePackOrder([...(activePack.entryIds || []), id]);
        addToast('已加入当前套组', 'success');
    };

    const commitEdit = async () => {
        if (!editingId) return;
        const name = draftName.trim() || '未命名段落';
        const hit = byId.get(editingId);
        if (!hit) {
            setEditingId(null);
            return;
        }
        const next = { ...hit, name, content: draftContent, updatedAt: Date.now() };
        setRows(rows.map(r => r.id === editingId ? next : r));
        setEditingId(null);
        try {
            await DB.savePromptPreset(next);
            invalidatePromptPresetCache();
            addToast('已保存', 'success');
        } catch (e: any) {
            addToast(e?.message || '保存失败', 'error');
        }
    };

    const patchEntry = async (entry: PromptPreset, patch: Partial<PromptPreset>) => {
        const next = { ...entry, ...patch, updatedAt: Date.now() };
        setRows(rows.map(r => r.id === entry.id ? next : r));
        try {
            await DB.savePromptPreset(next);
            invalidatePromptPresetCache();
        } catch {
            addToast('保存失败', 'error');
        }
    };

    const startEdit = (p: PromptPreset) => {
        setEditingId(p.id);
        setDraftName(p.name);
        setDraftContent(p.content);
        setExpandedId(p.id);
    };

    // ── 渲染小件 ──
    const categoryChip = (p: PromptPreset) => {
        if (!p.sourceKey) {
            return <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-slate-100 text-slate-500 shrink-0">自定义</span>;
        }
        const meta = PROMPT_CATEGORY_META.find(c => c.id === (p.category as PromptCategory));
        if (!meta) return null;
        const colors: Record<string, string> = {
            chat: 'bg-violet-50 text-violet-600',
            date: 'bg-rose-50 text-rose-500',
            song: 'bg-sky-50 text-sky-600',
            voice: 'bg-emerald-50 text-emerald-600',
            memory: 'bg-amber-50 text-amber-600',
            amsg: 'bg-indigo-50 text-indigo-600',
        };
        return <span className={`px-1.5 py-0.5 rounded-md text-[9px] font-bold shrink-0 ${colors[p.category || ''] || 'bg-slate-100 text-slate-500'}`}>{meta.label}</span>;
    };

    const tagChips = (p: PromptPreset) => {
        if (!p.tags || p.tags.length === 0) {
            return <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-slate-100 text-slate-400 shrink-0">全场景</span>;
        }
        return (
            <span className="flex flex-wrap gap-0.5">
                {p.tags.map(t => (
                    <span key={t} className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-violet-50 text-violet-600 shrink-0">{tagLabel(t)}</span>
                ))}
            </span>
        );
    };

    const positionLabel = (p: PromptPreset): string => {
        if (p.marker === 'chatHistory') return '分界（不注入）';
        if (p.injectionPosition === 'absolute') return `历史内 depth=${p.injectionDepth ?? 0}`;
        if (p.afterChatHistory) return '历史之后';
        return '角色卡后';
    };

    const enableSwitch = (on: boolean, onToggle: () => void) => (
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input type="checkbox" className="opacity-0 w-0 h-0 peer" checked={on} onChange={onToggle} />
            <div className="absolute inset-0 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-violet-500"></div>
            <div className="w-8 h-5"></div>
        </label>
    );

    const deleteBtn = (id: string, title: string, onDelete: () => void) => (
        <button
            onClick={confirmId === id ? onDelete : () => setConfirmId(id)}
            onBlur={() => confirmId === id && setConfirmId(null)}
            className={`px-2 py-1.5 rounded-full active:scale-90 transition-transform shrink-0 ${confirmId === id ? 'bg-red-500 text-white text-[10px] font-bold' : 'hover:bg-red-50'}`}
            title={title}
        >
            {confirmId === id ? '确认删？' : <Trash size={15} className="text-red-400" />}
        </button>
    );

    const renderEntryCard = (p: PromptPreset, index: number, total: number, inPack: boolean) => {
        const editing = editingId === p.id;
        const expanded = expandedId === p.id;
        const isMarker = p.marker === 'chatHistory';
        return (
            <div key={p.id} className={cardCls(p.enabled)}>
                <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
                    {editing ? (
                        <input
                            value={draftName}
                            onChange={e => setDraftName(e.target.value)}
                            className="flex-1 min-w-0 bg-slate-100 rounded-lg px-2 py-1 text-sm font-bold text-slate-800 outline-none focus:ring-2 ring-violet-300"
                            placeholder="段落名"
                            autoFocus
                        />
                    ) : (
                        <div onClick={() => setExpandedId(expanded ? null : p.id)} className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer">
                            <span className="text-sm font-bold text-slate-800 truncate">{p.name}</span>
                            {isMarker && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-amber-50 text-amber-500 shrink-0">分界</span>}
                            {p.role && p.role !== 'system' && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-sky-50 text-sky-600 shrink-0">{p.role}</span>}
                            {effBadge(p)}
                        </div>
                    )}
                    {!editing && !isMarker && (
                        <button onClick={() => startEdit(p)} className="p-1.5 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform shrink-0" title="编辑全文">
                            <PencilSimple size={13} className="text-slate-500" />
                        </button>
                    )}
                    {inPack && (
                        <div className="flex flex-col -space-y-1 shrink-0">
                            <button onClick={() => moveEntry(index, -1)} disabled={index === 0} className="p-0.5 rounded hover:bg-slate-200/70 disabled:opacity-20 active:scale-90 transition-transform">
                                <CaretUp size={13} weight="bold" className="text-slate-500" />
                            </button>
                            <button onClick={() => moveEntry(index, 1)} disabled={index === total - 1} className="p-0.5 rounded hover:bg-slate-200/70 disabled:opacity-20 active:scale-90 transition-transform">
                                <CaretDown size={13} weight="bold" className="text-slate-500" />
                            </button>
                        </div>
                    )}
                    {enableSwitch(p.enabled, () => toggleEnabled(p))}
                    {deleteBtn(p.id, '删除', () => handleDeleteEntry(p.id))}
                </div>
                {/* 落位 + tags 一行 */}
                <div className="flex items-center gap-1.5 px-3 pb-1.5 flex-wrap">
                    <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-slate-100 text-slate-500 shrink-0">{positionLabel(p)}</span>
                    {tagChips(p)}
                </div>
                {editing ? (
                    <div className="px-3 pb-3">
                        <textarea
                            value={draftContent}
                            onChange={e => setDraftContent(e.target.value)}
                            rows={8}
                            className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[13px] leading-relaxed text-slate-700 outline-none focus:ring-2 ring-violet-300 resize-none no-scrollbar"
                            placeholder="这段提示词的正文……支持 {{char}} {{user}} {{lastUser}} 等宏"
                        />
                        <div className="flex justify-end gap-2 mt-2">
                            <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-xl bg-slate-200/80 text-slate-600 text-xs font-bold active:scale-95 transition-transform">
                                <X size={13} weight="bold" className="inline -mt-0.5 mr-0.5" />取消
                            </button>
                            <button onClick={commitEdit} className="px-3 py-1.5 rounded-xl bg-violet-500 text-white text-xs font-bold active:scale-95 transition-transform">
                                <Check size={13} weight="bold" className="inline -mt-0.5 mr-0.5" />保存
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="px-3 pb-3">
                        {isMarker ? (
                            <p className="text-[11px] text-amber-600 leading-relaxed">分界条目：本身不注入，只决定它之后的条目落到「历史之后」。{p.content ? '（附带正文会被忽略）' : ''}</p>
                        ) : (
                            <>
                                <p
                                    onClick={() => p.content && p.content.length > 120 && setExpandedId(expanded ? null : p.id)}
                                    className={`text-[13px] leading-relaxed whitespace-pre-wrap ${p.content ? 'text-slate-600' : 'text-slate-400 italic'}`}
                                >
                                    {p.content
                                        ? ((expanded || p.content.length <= 120) ? p.content : p.content.slice(0, 120) + '……')
                                        : '（空段落，点右上角编辑填写）'}
                                </p>
                                {p.content && p.content.length > 120 && (
                                    <button onClick={() => setExpandedId(expanded ? null : p.id)} className="mt-1 text-[10px] font-bold text-violet-500 active:scale-95 transition-transform">
                                        {expanded ? '收起' : '展开全文'}
                                    </button>
                                )}
                            </>
                        )}
                        {/* 条目属性编辑区（展开时） */}
                        {expanded && !isMarker && (
                            <div className="mt-2 pt-2 border-t border-slate-100 space-y-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold text-slate-400 w-10 shrink-0">身份</span>
                                    <div className="flex gap-1">
                                        {(['system', 'user', 'assistant'] as const).map(r => (
                                            <button
                                                key={r}
                                                onClick={() => patchEntry(p, { role: r })}
                                                className={`px-2 py-1 rounded-lg text-[10px] font-bold active:scale-95 transition-transform ${p.role === r || (!p.role && r === 'system') ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                                            >
                                                {r}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] font-bold text-slate-400 w-10 shrink-0">落位</span>
                                    <div className="flex gap-1 flex-wrap">
                                        <button
                                            onClick={() => patchEntry(p, { injectionPosition: 'relative', afterChatHistory: false, marker: undefined })}
                                            className={`px-2 py-1 rounded-lg text-[10px] font-bold active:scale-95 transition-transform ${p.injectionPosition !== 'absolute' && !p.afterChatHistory ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                                        >
                                            角色卡后
                                        </button>
                                        <button
                                            onClick={() => patchEntry(p, { injectionPosition: 'relative', afterChatHistory: true, marker: undefined })}
                                            className={`px-2 py-1 rounded-lg text-[10px] font-bold active:scale-95 transition-transform ${p.injectionPosition !== 'absolute' && !!p.afterChatHistory ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                                        >
                                            历史之后
                                        </button>
                                        <button
                                            onClick={() => patchEntry(p, { injectionPosition: 'absolute', marker: undefined })}
                                            className={`px-2 py-1 rounded-lg text-[10px] font-bold active:scale-95 transition-transform ${p.injectionPosition === 'absolute' ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                                        >
                                            历史内
                                        </button>
                                        <button
                                            onClick={() => patchEntry(p, { marker: 'chatHistory' })}
                                            className="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-100 text-slate-500 active:scale-95 transition-transform"
                                        >
                                            设为分界
                                        </button>
                                    </div>
                                </div>
                                {p.injectionPosition === 'absolute' && (
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-bold text-slate-400 w-10 shrink-0">深度</span>
                                        <input
                                            type="number"
                                            min={0}
                                            max={50}
                                            value={p.injectionDepth ?? 0}
                                            onChange={e => patchEntry(p, { injectionDepth: Math.max(0, Math.min(50, Math.floor(Number(e.target.value) || 0))) })}
                                            className="w-16 bg-slate-100 rounded-lg px-2 py-1 text-xs text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                        />
                                        <span className="text-[10px] text-slate-400">距聊天底部条数（0=末尾）</span>
                                    </div>
                                )}
                                <div className="flex items-start gap-2">
                                    <span className="text-[10px] font-bold text-slate-400 w-10 shrink-0 mt-1">场景</span>
                                    <div className="flex gap-1 flex-wrap">
                                        {TAG_DEFS.map(t => {
                                            const has = (p.tags || []).includes(t.id);
                                            return (
                                                <button
                                                    key={t.id}
                                                    onClick={() => {
                                                        const cur = p.tags || [];
                                                        patchEntry(p, { tags: has ? cur.filter(x => x !== t.id) : [...cur, t.id] });
                                                    }}
                                                    className={`px-2 py-1 rounded-lg text-[10px] font-bold active:scale-95 transition-transform ${has ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                                                >
                                                    {t.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <p className="text-[9.5px] text-slate-400">不选场景=全场景出现；选了=只在对应功能里注入。宏：{'{{char}} {{user}} {{lastUser}} {{lastAssistant}} {{time}} {{date}}'}</p>
                            </div>
                        )}
                        {expanded && isMarker && (
                            <button
                                onClick={() => patchEntry(p, { marker: undefined })}
                                className="mt-1.5 block text-[10px] font-bold text-slate-400 hover:text-slate-600 active:scale-95 transition-transform"
                            >
                                取消分界，转回普通段落
                            </button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    /** 内置常驻行卡片：改名/改文/启停 + 目录序上下移（只写回 order）+ 接管落位。 */
    const renderBuiltinCard = (p: PromptPreset, list: PromptPreset[], i: number) => {
        const editing = editingId === p.id;
        const expanded = expandedId === p.id;
        const builtin = p.sourceKey ? BUILTIN_PROMPT_ENTRIES.find(e => e.sourceKey === p.sourceKey) : undefined;
        const customized = builtin ? (p.content ?? '') !== builtin.content : false;
        const where = p.sourceKey ? BUILTIN_INJECTION_WHERE[p.sourceKey] : undefined;
        const adoptable = !!p.sourceKey && ADOPTABLE_KEYS.has(p.sourceKey);
        const adoptPos = p.adoptPosition ?? 'native';
        return (
            <div key={p.id} id={`preset-row-${p.id}`} className={cardCls(p.enabled)}>
                <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
                    {editing ? (
                        <input
                            value={draftName}
                            onChange={e => setDraftName(e.target.value)}
                            className="flex-1 min-w-0 bg-slate-100 rounded-lg px-2 py-1 text-sm font-bold text-slate-800 outline-none focus:ring-2 ring-violet-300"
                            autoFocus
                        />
                    ) : (
                        <div onClick={() => setExpandedId(expanded ? null : p.id)} className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer">
                            <span className="text-sm font-bold text-slate-800 truncate">{p.name}</span>
                            {categoryChip(p)}
                            {customized && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-amber-50 text-amber-500 shrink-0">已改</span>}
                            {effBadge(p)}
                        </div>
                    )}
                    {!editing && (
                        <button onClick={() => startEdit(p)} className="p-1.5 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform shrink-0" title="编辑全文">
                            <PencilSimple size={13} className="text-slate-500" />
                        </button>
                    )}
                    <div className="flex flex-col -space-y-1 shrink-0">
                        <button onClick={() => i > 0 && swapBuiltinOrder(p, list[i - 1])} disabled={i === 0} className="p-0.5 rounded hover:bg-slate-200/70 disabled:opacity-20 active:scale-90 transition-transform" title="上移（只改目录序）">
                            <CaretUp size={13} weight="bold" className="text-slate-500" />
                        </button>
                        <button onClick={() => i < list.length - 1 && swapBuiltinOrder(p, list[i + 1])} disabled={i === list.length - 1} className="p-0.5 rounded hover:bg-slate-200/70 disabled:opacity-20 active:scale-90 transition-transform" title="下移（只改目录序）">
                            <CaretDown size={13} weight="bold" className="text-slate-500" />
                        </button>
                    </div>
                    {enableSwitch(p.enabled, () => toggleEnabled(p))}
                </div>
                {where && (
                    <p className="px-3 pb-1 text-[10px] text-slate-400 flex items-start gap-1 leading-tight">
                        <Info size={11} weight="bold" className="shrink-0 mt-0.5" />{where}
                        {!adoptable && <span className="px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-slate-100 text-slate-500 shrink-0">原生注入</span>}
                    </p>
                )}
                {adoptable && (
                    <div className="flex items-center gap-1.5 px-3 pb-1.5 flex-wrap">
                        <span className="text-[10px] font-bold text-slate-400 shrink-0">落位</span>
                        <select
                            value={adoptPos}
                            onChange={e => patchEntry(p, { adoptPosition: e.target.value as PromptPreset['adoptPosition'] })}
                            className="bg-slate-100 rounded-lg px-2 py-1 text-[11px] font-bold text-slate-700 outline-none focus:ring-2 ring-violet-300"
                        >
                            {ADOPT_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                        </select>
                        {adoptPos === 'absolute' && (
                            <>
                                <span className="text-[10px] font-bold text-slate-400 shrink-0">深度</span>
                                <input
                                    type="number"
                                    min={0}
                                    max={50}
                                    value={p.injectionDepth ?? 0}
                                    onChange={e => patchEntry(p, { injectionDepth: Math.max(0, Math.min(50, Math.floor(Number(e.target.value) || 0))) })}
                                    className="w-16 bg-slate-100 rounded-lg px-2 py-1 text-xs text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                />
                            </>
                        )}
                        {adoptPos !== 'native' && (
                            <span className="text-[9px] font-bold text-amber-500">原生点跳过，走套组管道</span>
                        )}
                    </div>
                )}
                {editing ? (
                    <div className="px-3 pb-3">
                        <textarea
                            value={draftContent}
                            onChange={e => setDraftContent(e.target.value)}
                            rows={8}
                            className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[13px] leading-relaxed text-slate-700 outline-none focus:ring-2 ring-violet-300 resize-none no-scrollbar"
                        />
                        <div className="flex justify-end gap-2 mt-2">
                            <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-xl bg-slate-200/80 text-slate-600 text-xs font-bold active:scale-95 transition-transform">
                                <X size={13} weight="bold" className="inline -mt-0.5 mr-0.5" />取消
                            </button>
                            <button onClick={commitEdit} className="px-3 py-1.5 rounded-xl bg-violet-500 text-white text-xs font-bold active:scale-95 transition-transform">
                                <Check size={13} weight="bold" className="inline -mt-0.5 mr-0.5" />保存
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="px-3 pb-3">
                        <p
                            onClick={() => p.content && p.content.length > 120 && setExpandedId(expanded ? null : p.id)}
                            className={`text-[13px] leading-relaxed whitespace-pre-wrap ${p.content ? 'text-slate-600' : 'text-slate-400 italic'}`}
                        >
                            {p.content
                                ? ((expanded || p.content.length <= 120) ? p.content : p.content.slice(0, 120) + '……')
                                : '（空段落，点右上角编辑填写）'}
                        </p>
                        {builtin && customized && (
                            <button onClick={async () => {
                                const next = applyBuiltinDefaultsToPreset(p);
                                setRows(rows.map(x => x.id === p.id ? next : x));
                                try {
                                    await DB.savePromptPreset(next);
                                    invalidatePromptPresetCache();
                                    addToast('已恢复内置默认', 'success');
                                } catch {
                                    addToast('保存失败', 'error');
                                }
                            }} className="mt-1.5 block text-[10px] font-bold text-slate-400 hover:text-slate-600 active:scale-95 transition-transform">
                                恢复内置默认文案
                            </button>
                        )}
                    </div>
                )}
            </div>
        );
    };

    // ── 主渲染：三页（提示词 / 世界书 / 调用地图入口）──
    return (
        <div className="h-full w-full bg-slate-100 flex flex-col">
            <div className="px-4 pt-3 pb-2 bg-white/60 backdrop-blur-xl border-b border-white/40 shrink-0">
                <div className="flex items-center gap-2">
                    <button onClick={closeApp} className="p-2 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform">
                        <ArrowLeft size={22} weight="bold" className="text-slate-700" />
                    </button>
                    <h1 className="text-lg font-bold text-slate-800">
                        {page === 'prompt' ? '提示词' : page === 'worldbook' ? '世界书' : '调用地图'}
                    </h1>
                    {page === 'prompt' && (
                        <span className="ml-1 px-2 py-0.5 rounded-full bg-violet-100 text-violet-600 text-[10px] font-bold max-w-[140px] truncate">{activePack.name}</span>
                    )}
                    {page === 'prompt' && (
                        <>
                            <button onClick={() => setPackSheet(true)} className="ml-auto p-2 rounded-full hover:bg-slate-200/70 text-slate-600 active:scale-90 transition-transform" title="套组管理">
                                <SquaresFour size={19} weight="bold" />
                            </button>
                            <button onClick={() => { setOverlaySite(null); setOverlayOpen(true); }} className="p-2 rounded-full hover:bg-slate-200/70 text-slate-600 active:scale-90 transition-transform" title="真实发送记录">
                                <PaperPlaneTilt size={19} weight="bold" />
                            </button>
                        </>
                    )}
                </div>
                <div className="mt-2 flex gap-1 bg-slate-200/60 rounded-xl p-1">
                    {PAGES.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setPage(t.id)}
                            className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-bold transition-all active:scale-95 ${page === t.id ? 'bg-white text-violet-600 shadow-sm' : 'text-slate-400'}`}
                        >
                            {t.icon}{t.label}
                        </button>
                    ))}
                </div>
            </div>

            {page === 'worldbook' && (
                <div className="flex-1 min-h-0">
                    <WorldbookApp embedded />
                </div>
            )}
            {page === 'map' && (
                <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 pb-24 space-y-3">
                    {/* 角色 chip：门三态按当前角色实时算 */}
                    <div className="flex gap-1.5 overflow-x-auto no-scrollbar px-0.5 py-0.5">
                        <button
                            onClick={() => selectChar('')}
                            className={`px-3 py-1.5 rounded-xl text-[11px] font-bold whitespace-nowrap active:scale-95 transition-transform ${!selectedCharId ? 'bg-slate-700 text-white shadow-sm' : 'bg-white/70 text-slate-500 border border-white/60'}`}
                        >
                            全部
                        </button>
                        {chars.map(c => (
                            <button
                                key={c.id}
                                onClick={() => selectChar(c.id)}
                                className={`px-3 py-1.5 rounded-xl text-[11px] font-bold whitespace-nowrap active:scale-95 transition-transform ${c.id === selectedCharId ? 'bg-violet-500 text-white shadow-sm' : 'bg-white/70 text-slate-500 border border-white/60'}`}
                            >
                                {c.name}
                            </button>
                        ))}
                    </div>
                    {/* 顶部时序卡：触发时机分组计数 */}
                    <div className={cardCls(true)}>
                        <div className="px-3 pt-2.5 pb-1">
                            <p className="text-sm font-bold text-slate-800">调用时序</p>
                            <p className="text-[10px] text-slate-400 mt-0.5">
                                登记 {CALL_REGISTRY.length} 个站点 · 本地可抓 {CALL_REGISTRY.filter(s => s.visibility === 'local').length} 个 · 云端 {CALL_REGISTRY.filter(s => s.visibility === 'cloud').length} 个
                            </p>
                        </div>
                        <div className="flex gap-1.5 px-3 pb-2.5 flex-wrap">
                            {MAP_TRIGGERS.map(t => (
                                <span key={t} className="px-2 py-1 rounded-lg text-[10px] font-bold bg-slate-100 text-slate-500">
                                    {t} × {CALL_REGISTRY.filter(s => s.trigger === t).length}
                                </span>
                            ))}
                        </div>
                    </div>
                    {mapGroups.map(g => (
                        <div key={g.category}>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1 mb-1.5">{g.category}（{g.sites.length}）</p>
                            <div className="space-y-3">
                                {g.sites.map(renderMapCard)}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {page === 'prompt' && (
            <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 pb-24 space-y-3">
                {loading && <p className="text-center text-xs text-slate-400 pt-8">加载中…</p>}
                {!loading && (
                    <>
                        {/* 套组条：横滑切换 + 管理入口 */}
                        <div className="flex gap-1.5 overflow-x-auto no-scrollbar px-0.5 py-0.5">
                            {packs.map(p => (
                                <button
                                    key={p.id}
                                    onClick={() => handleSwitchPack(p.id)}
                                    className={`px-3 py-1.5 rounded-xl text-[11px] font-bold whitespace-nowrap active:scale-95 transition-transform ${p.id === activeId ? 'bg-violet-500 text-white shadow-sm' : 'bg-white/70 text-slate-500 border border-white/60'}`}
                                >
                                    {p.name}
                                </button>
                            ))}
                            <button onClick={() => setPackSheet(true)} className="px-3 py-1.5 rounded-xl text-[11px] font-bold whitespace-nowrap bg-white/70 text-violet-600 border border-white/60 active:scale-95 transition-transform">
                                管理
                            </button>
                        </div>
                        {/* 角色 chip：可清空；选中驱动生效徽标/互斥组头/overlay */}
                        <div className="flex gap-1.5 overflow-x-auto no-scrollbar px-0.5 py-0.5">
                            <button
                                onClick={() => selectChar('')}
                                className={`px-3 py-1.5 rounded-xl text-[11px] font-bold whitespace-nowrap active:scale-95 transition-transform ${!selectedCharId ? 'bg-slate-700 text-white shadow-sm' : 'bg-white/70 text-slate-500 border border-white/60'}`}
                            >
                                全部
                            </button>
                            {chars.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => selectChar(c.id)}
                                    className={`px-3 py-1.5 rounded-xl text-[11px] font-bold whitespace-nowrap active:scale-95 transition-transform ${c.id === selectedCharId ? 'bg-violet-500 text-white shadow-sm' : 'bg-white/70 text-slate-500 border border-white/60'}`}
                                >
                                    {c.name}
                                </button>
                            ))}
                        </div>
                        {/* 内置常驻段：按目录序分组（可折叠；聊天组默认展开） */}
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-1">内置常驻（{builtinRows.length}）</p>
                        {PROMPT_CATEGORY_META.slice().sort((a, b) => a.order - b.order).map(meta => {
                            const list = builtinRows.filter(r => (r.category || 'chat') === meta.id);
                            if (list.length === 0) return null;
                            const open = isCatOpen(meta.id);
                            return (
                                <div key={meta.id}>
                                    <button
                                        onClick={() => setCollapsedCats({ ...collapsedCats, [meta.id]: open })}
                                        className="w-full flex items-center gap-1.5 pl-1 mb-1.5 active:opacity-70"
                                    >
                                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{meta.label}（{list.length}）</span>
                                        {(meta.id === 'voice' || meta.id === 'amsg') && (
                                            <span className="text-[9px] font-bold text-violet-500 normal-case tracking-normal">
                                                当前：{meta.id === 'voice' ? voiceNow : emoNow}
                                            </span>
                                        )}
                                        <span className="ml-auto text-slate-300">
                                            {open ? <CaretUp size={13} weight="bold" /> : <CaretDown size={13} weight="bold" />}
                                        </span>
                                    </button>
                                    {open && (
                                        <div className="space-y-3">
                                            {list.map((p, i) => renderBuiltinCard(p, list, i))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {/* 自定义段：当前套组条目 */}
                        <div className="flex items-center gap-2 pl-1 pt-1">
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">自定义段（{packEntries.length}）</p>
                            <button onClick={handleAddEntry} className="ml-auto p-1.5 rounded-full bg-violet-500 text-white shadow-sm hover:bg-violet-600 active:scale-90 transition-transform" title="新增段落">
                                <Plus size={14} weight="bold" />
                            </button>
                        </div>
                    </>
                )}
                {!loading && (
                    <>
                        {packEntries.length === 0 && unmanaged.length === 0 && builtinRows.length === 0 && (
                            <div className="flex flex-col items-center pt-14 text-slate-400">
                                <NoteBlank size={44} weight="light" />
                                <p className="text-sm mt-3">这个套组还没有段落</p>
                                <p className="text-xs mt-1 text-slate-400/80">点自定义段旁 + 建第一条</p>
                            </div>
                        )}
                        {packEntries.map((p, i) => renderEntryCard(p, i, packEntries.length, true))}
                {packSheet && (
                    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40" onClick={() => setPackSheet(false)}>
                        <div onClick={e => e.stopPropagation()} className="w-full max-w-lg max-h-[82%] overflow-y-auto no-scrollbar bg-slate-100 rounded-t-3xl px-4 py-3 pb-8 space-y-3">
                            <div className="flex items-center gap-2 py-1">
                                <p className="text-sm font-bold text-slate-800 flex-1">套组管理</p>
                                <button onClick={handleNewPack} className="p-2 rounded-full bg-violet-500 text-white shadow-sm hover:bg-violet-600 active:scale-90 transition-transform" title="新建套组">
                                    <Plus size={16} weight="bold" />
                                </button>
                                <button onClick={() => setPackSheet(false)} className="p-2 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform" title="关闭">
                                    <X size={16} weight="bold" className="text-slate-500" />
                                </button>
                            </div>
                        {packs.map(pack => {
                            const active = pack.id === activeId;
                            const isDefault = pack.id === DEFAULT_PACK_ID;
                            const editing = packEditingId === pack.id;
                            return (
                                <div key={pack.id} className={cardCls(true)}>
                                    <div className="flex items-center gap-2 px-3 py-2.5">
                                        <button
                                            onClick={() => handleSwitchPack(pack.id)}
                                            className={`w-5 h-5 rounded-full border-2 grid place-items-center shrink-0 active:scale-90 transition-transform ${active ? 'border-violet-500' : 'border-slate-300'}`}
                                            title={active ? '当前套组' : '切换到此套组'}
                                        >
                                            {active && <div className="w-2.5 h-2.5 rounded-full bg-violet-500" />}
                                        </button>
                                        {editing ? (
                                            <input
                                                value={packDraftName}
                                                onChange={e => setPackDraftName(e.target.value)}
                                                onBlur={commitPackRename}
                                                onKeyDown={e => e.key === 'Enter' && commitPackRename()}
                                                className="flex-1 min-w-0 bg-slate-100 rounded-lg px-2 py-1 text-sm font-bold text-slate-800 outline-none focus:ring-2 ring-violet-300"
                                                autoFocus
                                            />
                                        ) : (
                                            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => { setPackSheet(false); if (pack.id !== activeId) void handleSwitchPack(pack.id); }}>
                                                <p className="text-sm font-bold text-slate-800 truncate">
                                                    {pack.name}
                                                    {isDefault && <span className="ml-1.5 px-1.5 py-0.5 rounded-md text-[9px] font-bold bg-violet-50 text-violet-600">默认</span>}
                                                </p>
                                                <p className="text-[10px] text-slate-400">{(pack.entryIds || []).length} 条目{pack.generation ? ' · 采样参数已配' : ''}</p>
                                            </div>
                                        )}
                                        {!editing && !isDefault && (
                                            <button onClick={() => { setPackEditingId(pack.id); setPackDraftName(pack.name); }} className="p-1.5 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform shrink-0" title="重命名">
                                                <PencilSimple size={13} className="text-slate-500" />
                                            </button>
                                        )}
                                        <button onClick={() => handleExport(pack)} className="p-1.5 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform shrink-0" title="导出分享">
                                            <DownloadSimple size={15} className="text-slate-500" />
                                        </button>
                                        {!isDefault && deleteBtn(pack.id, '删除套组', () => handleDeletePack(pack.id))}
                                    </div>
                                    {/* 采样参数（空=跟 API 设置；配了就随套组生效+分享带走） */}
                                    <div className="px-3 pb-2.5">
                                        <button
                                            onClick={() => setGenOpenId(genOpenId === pack.id ? null : pack.id)}
                                            className="text-[10px] font-bold text-violet-500 active:scale-95 transition-transform"
                                        >
                                            {genOpenId === pack.id ? '收起采样参数' : `采样参数${pack.generation ? '（已配）' : ''}`}
                                        </button>
                                        {genOpenId === pack.id && (
                                            <div className="mt-1.5 grid grid-cols-3 gap-1.5">
                                                {GEN_FIELDS.map(f => (
                                                    <label key={f.key} className="bg-slate-100 rounded-lg px-2 py-1.5">
                                                        <span className="block text-[9px] font-bold text-slate-400">{f.label}</span>
                                                        <input
                                                            type="number"
                                                            step="any"
                                                            defaultValue={pack.generation?.[f.key] ?? ''}
                                                            placeholder="空=跟随"
                                                            onBlur={e => {
                                                                const raw = e.target.value.trim();
                                                                const v = raw === '' ? undefined : Number(raw);
                                                                const gen = { ...(pack.generation || {}) };
                                                                if (v === undefined || !Number.isFinite(v)) delete gen[f.key];
                                                                else (gen as any)[f.key] = v;
                                                                void savePackGen(pack, Object.keys(gen).length > 0 || pack.generation?.omitSamplingParams ? gen : undefined);
                                                            }}
                                                            className="w-full bg-transparent text-xs font-bold text-slate-700 outline-none"
                                                        />
                                                    </label>
                                                ))}
                                                <label className="col-span-3 flex items-center gap-2 bg-slate-100 rounded-lg px-2 py-1.5 cursor-pointer">
                                                    <input
                                                        type="checkbox"
                                                        checked={!!pack.generation?.omitSamplingParams}
                                                        onChange={e => {
                                                            const gen = { ...(pack.generation || {}), omitSamplingParams: e.target.checked };
                                                            if (!e.target.checked && Object.keys(gen).filter(k => k !== 'omitSamplingParams').length === 0) {
                                                                void savePackGen(pack, undefined);
                                                            } else {
                                                                void savePackGen(pack, gen);
                                                            }
                                                        }}
                                                        className="accent-violet-500"
                                                    />
                                                    <span className="text-[10px] font-bold text-slate-500">精简模式（只发温度+Max Tokens，兼容报错的接口）</span>
                                                </label>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        <button
                            onClick={() => fileRef.current?.click()}
                            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-2xl bg-white/70 border border-white/60 text-xs font-bold text-violet-600 active:scale-[0.99] transition-transform"
                        >
                            <UploadSimple size={14} weight="bold" /> 从文件导入套组
                        </button>
                        <p className="text-[10px] text-slate-400 text-center leading-relaxed">点套组名进入条目编辑；圆点切换当前生效套组。<br />默认预设不可删除；删套组不删条目（条目回到未入套组）。</p>
                        </div>
                    </div>
                )}
                {!loading && (
                    <>
                        {unmanaged.length > 0 && (
                            <div className="pt-2">
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 pl-1">未入套组（{unmanaged.length}）</p>
                                <div className="space-y-3">
                                    {unmanaged.map(u => (
                                        <div key={u.id} className={cardCls(u.enabled)}>
                                            <div className="flex items-center gap-2 px-3 py-2.5">
                                                <p className="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">{u.name}</p>
                                                <button onClick={() => joinPack(u.id)} className="px-2.5 py-1 rounded-lg bg-violet-500 text-white text-[10px] font-bold active:scale-95 transition-transform shrink-0">加入</button>
                                                {deleteBtn(u.id, '删除', () => handleDeleteEntry(u.id))}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </>
                )}
                {!loading && (
                    <div className="pt-1">
                        <button onClick={() => setRegexOpen(!regexOpen)} className="w-full flex items-center gap-1.5 pl-1 mb-1.5 active:opacity-70">
                            <BracketsCurly size={13} weight="bold" className="text-slate-400" />
                            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">正则{activeKit ? `（${activeKit.rules.length}）` : ''}</span>
                            <span className="ml-auto text-slate-300">{regexOpen ? <CaretUp size={13} weight="bold" /> : <CaretDown size={13} weight="bold" />}</span>
                        </button>
                        {regexOpen && (
                            <div className="space-y-3">
                        <p className="text-[10px] text-slate-400 leading-relaxed px-1">查找替换脚本：按顺序串行执行。替换支持 $1 分组与 {'{{char}}'} 宏；非法正则整条跳过。仅显示作用域 v1 未接，不提供。</p>
                        {/* 套件选择 */}
                        <div className="flex gap-1.5 flex-wrap">
                            {regexKits.map(k => (
                                <button
                                    key={k.id}
                                    onClick={async () => {
                                        setActiveRegexId(k.id);
                                        try { await setActiveRegexKitId(k.id); } catch { /* 忽略 */ }
                                    }}
                                    className={`px-3 py-1.5 rounded-xl text-[11px] font-bold active:scale-95 transition-transform ${k.id === activeKit?.id ? 'bg-violet-500 text-white shadow-sm' : 'bg-white/70 text-slate-500 border border-white/60'}`}
                                >
                                    {k.name}
                                </button>
                            ))}
                            <button onClick={handleNewRegexKit} className="px-3 py-1.5 rounded-xl text-[11px] font-bold bg-white/70 text-violet-600 border border-white/60 active:scale-95 transition-transform">
                                <Plus size={12} weight="bold" className="inline -mt-0.5" /> 套件
                            </button>
                        </div>
                        {activeKit && (
                            <div className="flex items-center gap-2 px-1">
                                <span className="text-[11px] font-bold text-slate-500 flex-1 truncate">{activeKit.name}（{activeKit.rules.length} 条）</span>
                                {enableSwitch(activeKit.enabled, () => saveRegexKit({ ...activeKit, enabled: !activeKit.enabled, updatedAt: Date.now() }))}
                                {deleteBtn(activeKit.id, '删除套件', () => handleDeleteRegexKit(activeKit.id))}
                            </div>
                        )}
                        {/* 测试器 */}
                        <div className={cardCls(true)}>
                            <div className="px-3 pt-2.5 pb-1.5">
                                <p className="text-[11px] font-bold text-slate-700">测试器 <span className="font-normal text-slate-400">（用当前套件、输出作用域跑一遍）</span></p>
                            </div>
                            <div className="px-3 pb-3 space-y-2">
                                <textarea
                                    value={testInput}
                                    onChange={e => setTestInput(e.target.value)}
                                    rows={3}
                                    className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[12px] leading-relaxed text-slate-700 outline-none focus:ring-2 ring-violet-300 resize-none no-scrollbar"
                                    placeholder="输入样文……"
                                />
                                <div className="bg-violet-50/70 rounded-xl px-3 py-2">
                                    <p className="text-[9px] font-bold text-violet-400 mb-0.5">输出</p>
                                    <p className="text-[12px] leading-relaxed text-slate-700 whitespace-pre-wrap">{
                                        (() => {
                                            try {
                                                return applyRegexPlacement(testInput, activeKit, 2, { charName: '阿澈', userName: '小雨' }) || '（空）';
                                            } catch {
                                                return '（计算失败）';
                                            }
                                        })()
                                    }</p>
                                </div>
                            </div>
                        </div>
                        {/* 新规则 */}
                        {activeKit && (
                            <div className={cardCls(true)}>
                                <div className="px-3 pt-2.5 pb-1.5">
                                    <p className="text-[11px] font-bold text-slate-700">新规则</p>
                                </div>
                                <div className="px-3 pb-3 space-y-2">
                                    <input
                                        value={ruleDraft.name}
                                        onChange={e => setRuleDraft({ ...ruleDraft, name: e.target.value })}
                                        placeholder="规则名（可选）"
                                        className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[12px] text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                    />
                                    <input
                                        value={ruleDraft.find}
                                        onChange={e => setRuleDraft({ ...ruleDraft, find: e.target.value })}
                                        placeholder="查找（正则，如：\[.*?\])"
                                        className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[12px] font-mono text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                    />
                                    <input
                                        value={ruleDraft.replace}
                                        onChange={e => setRuleDraft({ ...ruleDraft, replace: e.target.value })}
                                        placeholder="替换（支持 $1 与 {{char}}）"
                                        className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[12px] font-mono text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                    />
                                    <button onClick={handleAddRule} disabled={!ruleDraft.find.trim()} className="w-full py-2 rounded-xl bg-violet-500 text-white text-xs font-bold active:scale-[0.99] transition-transform disabled:opacity-40">
                                        添加规则
                                    </button>
                                </div>
                            </div>
                        )}
                        {/* 规则列表 */}
                        {activeKit?.rules.map(rule => {
                            const editing = ruleEditId === rule.id;
                            return (
                                <div key={rule.id} className={cardCls(!rule.disabled)}>
                                    <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
                                        <p className="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">{rule.scriptName}</p>
                                        <button onClick={() => setRuleEditId(editing ? null : rule.id)} className="p-1.5 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform shrink-0" title="编辑">
                                            <PencilSimple size={13} className="text-slate-500" />
                                        </button>
                                        {enableSwitch(!rule.disabled, () => patchRule(rule.id, { disabled: !rule.disabled }))}
                                        {deleteBtn(rule.id, '删除规则', () => handleDeleteRule(rule.id))}
                                    </div>
                                    <div className="flex items-center gap-1 px-3 pb-1.5 flex-wrap">
                                        {REGEX_PLACEMENTS.map(pl => {
                                            const on = (rule.placement || []).includes(pl.value);
                                            return (
                                                <button
                                                    key={pl.value}
                                                    onClick={() => togglePlacement(rule, pl.value)}
                                                    title={pl.hint}
                                                    className={`px-2 py-1 rounded-lg text-[10px] font-bold active:scale-95 transition-transform ${on ? 'bg-violet-500 text-white' : 'bg-slate-100 text-slate-500'}`}
                                                >
                                                    {pl.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <div className="px-3 pb-3">
                                        <p className="text-[11px] font-mono text-slate-500 truncate">/{rule.findRegex}/ → {rule.replaceString || '（删空）'}</p>
                                        {editing && (
                                            <div className="mt-2 pt-2 border-t border-slate-100 space-y-2">
                                                <input
                                                    defaultValue={rule.scriptName}
                                                    onBlur={e => patchRule(rule.id, { scriptName: e.target.value.trim() || '未命名规则' })}
                                                    className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[12px] text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                                />
                                                <input
                                                    defaultValue={rule.findRegex}
                                                    onBlur={e => patchRule(rule.id, { findRegex: e.target.value })}
                                                    className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[12px] font-mono text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                                />
                                                <input
                                                    defaultValue={rule.replaceString}
                                                    onBlur={e => patchRule(rule.id, { replaceString: e.target.value })}
                                                    className="w-full bg-slate-100 rounded-xl px-3 py-2 text-[12px] font-mono text-slate-700 outline-none focus:ring-2 ring-violet-300"
                                                />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        {activeKit && activeKit.rules.length === 0 && (
                            <p className="text-center text-[11px] text-slate-400 pt-4">还没有规则，在上面添加第一条</p>
                        )}
                        {!activeKit && (
                            <div className="flex flex-col items-center pt-14 text-slate-400">
                                <NoteBlank size={44} weight="light" />
                                <p className="text-sm mt-3">还没有正则套件</p>
                                <p className="text-xs mt-1 text-slate-400/80">点「套件」创建一个</p>
                            </div>
                        )}
                            </div>
                        )}
                    </div>
                )}
                {!loading && (
                    <div className="pt-1">
                        <div className={cardCls(true)}>
                            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                                <PaperPlaneTilt size={15} weight="bold" className="text-violet-500 shrink-0" />
                                <p className="flex-1 min-w-0 text-sm font-bold text-slate-800 truncate">
                                    真实发送{selectedChar ? ` · ${selectedChar.name}` : ''}
                                </p>
                                <button onClick={() => { setOverlaySite(null); setOverlayOpen(true); }} className="px-2.5 py-1 rounded-lg bg-violet-500 text-white text-[10px] font-bold active:scale-95 transition-transform shrink-0">
                                    查看
                                </button>
                            </div>
                            <p className="px-3 pb-2.5 text-[10px] leading-relaxed text-slate-400">
                                {selectedCharId
                                    ? (overlayRecords.some(s => s.latest)
                                        ? `本会话已抓 ${overlayRecords.filter(s => s.latest).length}/${overlayRecords.length} 个站点（只标字数，不估 token）。`
                                        : '本会话尚无真实发送记录：去聊一条消息再回来，绝不拿模拟顶数。')
                                    : '先在上方选一个角色，再看它的真实发送记录。'}
                            </p>
                        </div>
                    </div>
                )}
                    </>
                )}
            </div>
            )}
            {overlayOpen && (
                <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/40" onClick={() => { setOverlayOpen(false); setOverlaySite(null); }}>
                    <div onClick={e => e.stopPropagation()} className="mt-16 flex-1 min-h-0 bg-slate-100 rounded-t-3xl flex flex-col overflow-hidden">
                        <div className="flex items-center gap-2 px-4 py-3 bg-white/60 border-b border-white/40 shrink-0">
                            <p className="text-sm font-bold text-slate-800 flex-1">真实发送记录{selectedChar ? ` · ${selectedChar.name}` : ''}</p>
                            <button onClick={() => { setOverlayOpen(false); setOverlaySite(null); }} className="p-2 rounded-full hover:bg-slate-200/70 active:scale-90 transition-transform" title="关闭">
                                <X size={16} weight="bold" className="text-slate-500" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 pb-8 space-y-3">
                            {!selectedCharId && (
                                <p className="text-center text-xs text-slate-400 pt-10">先在提示词页选一个角色，再看它的真实发送记录。</p>
                            )}
                            {selectedCharId && !overlaySite && overlayRecords.map(s => (
                                <button
                                    key={s.site}
                                    disabled={!s.latest}
                                    onClick={() => s.latest && setOverlaySite(s.site)}
                                    className={`w-full text-left rounded-2xl border backdrop-blur-md px-3 py-2.5 transition-transform ${s.latest ? 'bg-white/70 border-white/60 active:scale-[0.99]' : 'bg-white/40 border-white/40 opacity-60'}`}
                                >
                                    <p className="text-sm font-bold text-slate-800">{s.name}<span className="ml-2 text-[10px] font-bold text-slate-400">{s.count} 条</span></p>
                                    <p className="text-[10px] text-slate-400 mt-0.5">{s.latest ? new Date(s.latest.meta.at).toLocaleString() : '暂无记录'}</p>
                                </button>
                            ))}
                            {selectedCharId && !overlaySite && overlayRecords.every(s => !s.latest) && (
                                <p className="text-center text-[11px] text-slate-400">该角色暂无抓取记录：去聊一条消息再回来。</p>
                            )}
                            {selectedCharId && overlaySite && (() => {
                                const rec = overlayRecords.find(s => s.site === overlaySite)?.latest ?? null;
                                if (!rec) return <p className="text-center text-xs text-slate-400 pt-10">该站点暂无记录。</p>;
                                const hit = overlayRecords.find(s => s.site === overlaySite)!;
                                const text = renderCapturedText(rec);
                                return (
                                    <div className="space-y-2">
                                        <button onClick={() => setOverlaySite(null)} className="text-[11px] font-bold text-violet-500 active:scale-95 transition-transform">← 全部站点</button>
                                        <p className="text-[10px] text-slate-400">{hit.name} · {new Date(rec.meta.at).toLocaleString()} · {rec.charCount} 字</p>
                                        <pre className="rounded-2xl bg-white/70 border border-white/60 px-3 py-2.5 text-[11px] leading-relaxed text-slate-600 whitespace-pre-wrap max-h-[50vh] overflow-y-auto no-scrollbar">{text}</pre>
                                        <div className="flex gap-2">
                                            <button onClick={() => copyCaptureText(text)} className="flex-1 py-2 rounded-xl bg-violet-500 text-white text-xs font-bold active:scale-[0.99] transition-transform">复制全文</button>
                                            <button onClick={() => exportCaptureText(hit.site, text, rec.meta.at)} className="flex-1 py-2 rounded-xl bg-white/70 border border-white/60 text-violet-600 text-xs font-bold active:scale-[0.99] transition-transform">导出 txt</button>
                                        </div>
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                </div>
            )}
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
                onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) void handleImportFile(f);
                    e.target.value = '';
                }}
            />
        </div>
    );
};

export default PresetApp;
