/**
 * 查手机「家」卡片 —— VPS Home（角色的小屋）在手机里的样子。
 *
 * 三区布局（视觉 token 照抄 CheckPhone.tsx 的深色玻璃拟态）：
 *   状态区 —— 在线徽章（点按强刷、60 秒静默刷新，手感同 StatusBadge）+
 *              消息/记忆/事件条数 + 下次去看看 TA 的锚点；
 *              VPS 停机时显式离线横幅，绝不留白。
 *   数据区 —— 最近动静列表（默认收起只看 5 条，点开展开全部事件入口）。
 *   行为区 —— 间隔 / 夜间 / 日上限 / 阈值四组滑杆 + 数字输入、
 *              恢复默认按钮、VPS / 本地切源开关（二次确认后才写盘）。
 *
 * 远端调用只走两处契约（别人并行实现，这里只按锁定的签名 import）：
 *   probeHome({ agentUrl?, agentToken? }) —— components/home/HomeBadgeBridge
 *   fetchHome / fetchHomeMessages / getHomeSource / setHomeSource —— utils/homeClient
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { probeHome } from '../components/home/HomeBadgeBridge';
import {
  fetchHome, fetchHomeMessages, fetchHomeConfig, saveHomeConfig,
  getHomeSource, setHomeSource,
} from '../utils/homeClient';

export const HOME_ACCENT = '#f59e0b';

export type HomeProbeStatus = 'ok' | 'warn' | 'err' | 'off' | 'checking';

export interface HomeStats {
    messages: number;
    memories: number;
    events: number;
}

export interface HomeConfig {
    /** 自主生活每隔多少分钟转一轮（5–120）。 */
    roundIntervalMin: number;
    /** 夜间从几点开始只记事不打扰（0–23 点）。 */
    quietStartHour: number;
    /** 一天最多转几轮（1–48，到顶就只推进锚点）。 */
    dailyMaxRounds: number;
    /** TA 主动想分享的积极度阈值（0–100 分）。 */
    shareThreshold: number;
}

export const HOME_CONFIG_DEFAULTS: HomeConfig = {
    roundIntervalMin: 30,
    quietStartHour: 0,
    dailyMaxRounds: 48,
    shareThreshold: 60,
};

const HOME_CONFIG_LIMITS: Record<keyof HomeConfig, { min: number; max: number }> = {
    roundIntervalMin: { min: 5, max: 120 },
    quietStartHour: { min: 0, max: 23 },
    dailyMaxRounds: { min: 1, max: 48 },
    shareThreshold: { min: 0, max: 100 },
};

const HOME_CONFIG_META: Array<{ key: keyof HomeConfig; label: string; hint: string; unit: string }> = [
    { key: 'roundIntervalMin', label: '转一轮间隔', hint: '隔多久去小屋看一眼 TA', unit: '分钟' },
    { key: 'quietStartHour', label: '夜间安静', hint: '从几点起只记事不打扰', unit: '点' },
    { key: 'dailyMaxRounds', label: '一天上限', hint: '到顶后只推进锚点不转了', unit: '轮' },
    { key: 'shareThreshold', label: '分享积极度', hint: '超过这个分 TA 才主动开口', unit: '分' },
];

const clampCfg = (key: keyof HomeConfig, v: number): number => {
    const { min, max } = HOME_CONFIG_LIMITS[key];
    if (!Number.isFinite(v)) return HOME_CONFIG_DEFAULTS[key];
    return Math.min(max, Math.max(min, Math.floor(v)));
};

const cfgKey = (charId: string) => `os_home_cfg_${charId}`;

/** 服务端推送：best-effort PUT（幂等），失败静默——本地已落盘，离线可用。 */
const pushHomeConfig = (charId: string, next: HomeConfig): void => {
    try {
        const hh = String(clampCfg('quietStartHour', next.quietStartHour)).padStart(2, '0');
        void saveHomeConfig(charId, {
            roundIntervalMin: next.roundIntervalMin,
            quietStart: `${hh}:00`,
            dailyMaxRounds: next.dailyMaxRounds,
        }).catch(() => { /* 离线：本地值照用，下次改参再推 */ });
    } catch { /* 同上 */ }
};

/** 行为参数钩子：本地存档即读即用；挂载后 best-effort 拉服务端合并，失败回退本地。 */
export function useHomeConfig(charId: string) {
    const [config, setConfigState] = useState<HomeConfig>(() => {
        try {
            const raw = localStorage.getItem(cfgKey(charId));
            if (!raw) return { ...HOME_CONFIG_DEFAULTS };
            const parsed = JSON.parse(raw) as Partial<HomeConfig>;
            return {
                roundIntervalMin: clampCfg('roundIntervalMin', Number(parsed.roundIntervalMin)),
                quietStartHour: clampCfg('quietStartHour', Number(parsed.quietStartHour)),
                dailyMaxRounds: clampCfg('dailyMaxRounds', Number(parsed.dailyMaxRounds)),
                shareThreshold: clampCfg('shareThreshold', Number(parsed.shareThreshold)),
            };
        } catch {
            return { ...HOME_CONFIG_DEFAULTS };
        }
    });
    const setConfig = useCallback((patch: Partial<HomeConfig>) => {
        setConfigState((prev) => {
            const next: HomeConfig = { ...prev };
            for (const k of Object.keys(patch) as Array<keyof HomeConfig>) {
                next[k] = clampCfg(k, Number(patch[k]));
            }
            try {
                localStorage.setItem(cfgKey(charId), JSON.stringify(next));
            } catch { /* 存档满了就先放内存里用 */ }
            pushHomeConfig(charId, next);
            return next;
        });
    }, [charId]);
    const resetConfig = useCallback(() => {
        setConfigState({ ...HOME_CONFIG_DEFAULTS });
        try {
            localStorage.setItem(cfgKey(charId), JSON.stringify(HOME_CONFIG_DEFAULTS));
        } catch { /* 同上 */ }
        pushHomeConfig(charId, { ...HOME_CONFIG_DEFAULTS });
    }, [charId]);
    // 服务端合并：只在挂载后拉一次；quietStart(HH:MM)→quietStartHour 取小时，
    // 其余按本地 clamp 收敛；失败（离线/未配）留本地值，卡片照常可用。
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const srv = await fetchHomeConfig(charId);
                if (!alive) return;
                setConfigState((prev) => {
                    const next: HomeConfig = { ...prev };
                    if (Number.isFinite(Number(srv.roundIntervalMin))) {
                        next.roundIntervalMin = clampCfg('roundIntervalMin', Number(srv.roundIntervalMin));
                    }
                    if (typeof srv.quietStart === 'string') {
                        const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(srv.quietStart);
                        if (m) next.quietStartHour = clampCfg('quietStartHour', Number(m[1]));
                    }
                    if (Number.isFinite(Number(srv.dailyMaxRounds))) {
                        next.dailyMaxRounds = clampCfg('dailyMaxRounds', Number(srv.dailyMaxRounds));
                    }
                    try {
                        localStorage.setItem(cfgKey(charId), JSON.stringify(next));
                    } catch { /* 同上 */ }
                    return next;
                });
            } catch { /* 离线：本地值照用 */ }
        })();
        return () => { alive = false; };
    }, [charId]);
    return { config, setConfig, resetConfig };
}

export interface HomeRecentItem {
    id: string;
    role: string;
    content: string;
    createdAt: number;
}

export interface HomeStatsState {
    probe: HomeProbeStatus;
    detail: string;
    counts: HomeStats;
    recent: HomeRecentItem[];
    /** 下次去看看 TA 的时间点（展示用字符串）。 */
    nextAnchor: string;
    checking: boolean;
    refresh: (force?: boolean) => void;
}

/** 状态数据钩子：先探活，活着才拉条数和最近动静，挂了就显式离线。 */
export function useHomeStats(charId: string, intervalMin = HOME_CONFIG_DEFAULTS.roundIntervalMin): HomeStatsState {
    const [probe, setProbe] = useState<HomeProbeStatus>('checking');
    const [detail, setDetail] = useState('探测中');
    const [counts, setCounts] = useState<HomeStats>({ messages: 0, memories: 0, events: 0 });
    const [recent, setRecent] = useState<HomeRecentItem[]>([]);
    const [checking, setChecking] = useState(false);
    const mounted = useRef(true);

    const refresh = useCallback(async () => {
        setChecking(true);
        try {
            const apiConfig = {
                agentUrl: localStorage.getItem('os_agent_url') ?? undefined,
                agentToken: localStorage.getItem('os_api_token') ?? undefined,
            };
            const r = await probeHome(apiConfig);
            if (!mounted.current) return;
            setProbe(r.status as HomeProbeStatus);
            setDetail(r.detail ?? '');
            if (r.status === 'ok') {
                try {
                    const s = await fetchHome('/home/stats') as Partial<HomeStats>;
                    if (!mounted.current) return;
                    setCounts({
                        messages: Number(s.messages) || 0,
                        memories: Number(s.memories) || 0,
                        events: Number(s.events) || 0,
                    });
                } catch { /* 条数拉不到就留 0，不影响在线态 */ }
                try {
                    const msgs = await fetchHomeMessages(charId) as any[];
                    if (!mounted.current) return;
                    const list = Array.isArray(msgs) ? msgs : [];
                    setRecent(list.slice(0, 20).map((m: any, i: number) => ({
                        id: String(m.id ?? `m_${i}`),
                        role: String(m.role ?? 'ta'),
                        content: String(m.content ?? m.summary ?? ''),
                        createdAt: Number(m.created_at ?? m.createdAt ?? Date.now()),
                    })));
                } catch { /* 动静拉不到就留空列表 */ }
            } else {
                setRecent([]);
            }
        } catch {
            if (!mounted.current) return;
            setProbe('err');
            setDetail('离线');
            setRecent([]);
        } finally {
            if (mounted.current) setChecking(false);
        }
    }, [charId]);

    useEffect(() => {
        mounted.current = true;
        refresh();
        // 60 秒静默刷新：卡片常驻时自动保持新鲜，手感同 StatusBadge。
        const timer = setInterval(() => { refresh(); }, 60 * 1000);
        return () => { mounted.current = false; clearInterval(timer); };
    }, [refresh]);

    const nextAnchor = (() => {
        const t = new Date(Date.now() + Math.max(1, intervalMin) * 60000);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        return `约 ${hh}:${mm}`;
    })();

    return { probe, detail, counts, recent, nextAnchor, checking, refresh };
}

const BADGE_STYLE: Record<HomeProbeStatus, { dot: string; text: string; bg: string; label: string }> = {
    ok: { dot: 'bg-emerald-400', text: 'text-emerald-200', bg: 'bg-emerald-400/15 border-emerald-300/20', label: '在线' },
    warn: { dot: 'bg-amber-400', text: 'text-amber-200', bg: 'bg-amber-400/15 border-amber-300/20', label: '将就' },
    err: { dot: 'bg-rose-400', text: 'text-rose-200', bg: 'bg-rose-400/15 border-rose-300/20', label: '离线' },
    off: { dot: 'bg-white/40', text: 'text-white/60', bg: 'bg-white/[0.06] border-white/10', label: '没配' },
    checking: { dot: 'bg-white/50 animate-pulse', text: 'text-white/60', bg: 'bg-white/[0.06] border-white/10', label: '瞅一眼' },
};

const fmtClock = (ts: number) => {
    const t = new Date(ts);
    if (Number.isNaN(t.getTime())) return '';
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};

const roleName = (role: string) => (role === 'user' ? '你' : role === 'assistant' ? 'TA' : role || 'TA');

export default function CheckPhoneHomeCard({ charId }: { charId: string }) {
    const { config, setConfig, resetConfig } = useHomeConfig(charId);
    const { probe, detail, counts, recent, nextAnchor, checking, refresh } =
        useHomeStats(charId, config.roundIntervalMin);
    const [expanded, setExpanded] = useState(false);
    const [source, setSource] = useState<'vps' | 'local'>(() => getHomeSource());
    const [confirmSwitch, setConfirmSwitch] = useState(false);
    const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
    }, []);

    const st = BADGE_STYLE[probe] ?? BADGE_STYLE.checking;
    const offline = probe === 'err';
    const shown = expanded ? recent : recent.slice(0, 5);
    const target = source === 'vps' ? '本机' : 'VPS';

    const onSourceClick = () => {
        if (!confirmSwitch) {
            setConfirmSwitch(true);
            if (confirmTimer.current) clearTimeout(confirmTimer.current);
            confirmTimer.current = setTimeout(() => setConfirmSwitch(false), 6000);
            return;
        }
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        const next = source === 'vps' ? 'local' : 'vps';
        setHomeSource(next);
        setSource(next);
        setConfirmSwitch(false);
        // 切源后立刻重探，徽章马上反映新去向。
        refresh();
    };

    return (
        <div className="rounded-[24px] p-4 border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl overflow-hidden relative">
            <div
                className="absolute -top-10 -right-10 w-36 h-36 rounded-full blur-2xl pointer-events-none opacity-50"
                style={{ background: `radial-gradient(circle, ${HOME_ACCENT}, transparent 70%)` }}
            />
            {/* 头：标题 + 在线徽章（点按强刷） */}
            <div className="flex items-center justify-between relative z-10">
                <div>
                    <div className="text-[12px] font-semibold tracking-[0.12em] text-white uppercase">家</div>
                    <div className="text-[10px] mt-0.5" style={{ color: HOME_ACCENT }}>小屋 · TA 在 VPS 那头过日子</div>
                </div>
                <button
                    type="button"
                    data-testid="home-badge"
                    onClick={() => refresh()}
                    title={`小屋：${detail}（点我重新探一下）`}
                    className={`inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold border active:scale-95 transition-all duration-200 ${st.bg} ${st.text}`}
                >
                    <span className={`w-1.5 h-1.5 rounded-full ${st.dot} ${checking ? 'animate-pulse' : ''}`} />
                    <span>{checking ? '瞅一眼…' : detail || st.label}</span>
                </button>
            </div>
            <div className="h-[3px] w-9 rounded-full mt-2.5 relative z-10" style={{ background: `linear-gradient(90deg, ${HOME_ACCENT}, transparent)` }} />

            {/* 状态区：条数 + 下次锚点；挂了就摆明离线 */}
            {offline ? (
                <div data-testid="home-offline" className="mt-3 rounded-2xl p-3.5 border border-rose-300/20 bg-rose-400/10 relative z-10">
                    <div className="text-[13px] font-semibold text-rose-200">VPS 连不上了</div>
                    <div className="text-[11px] text-rose-200/70 mt-1 leading-relaxed">先用本机顶着，旧记录都在，丢不了。网络好了点下面重连。</div>
                    <button
                        type="button"
                        onClick={() => refresh()}
                        className="mt-2.5 px-4 py-1.5 rounded-full text-[11px] font-bold text-white active:scale-95 transition border border-white/10"
                        style={{ background: `linear-gradient(135deg, ${HOME_ACCENT}, ${HOME_ACCENT}cc)` }}
                    >
                        {checking ? '连着呢…' : '点我重连'}
                    </button>
                </div>
            ) : (
                <div className="mt-3 relative z-10">
                    <div data-testid="home-counts" className="flex items-center gap-4 text-[12px] text-white/80">
                        <span>消息 <b className="tabular-nums text-white">{counts.messages}</b></span>
                        <span>记忆 <b className="tabular-nums text-white">{counts.memories}</b></span>
                        <span>事件 <b className="tabular-nums text-white">{counts.events}</b></span>
                    </div>
                    <div data-testid="home-next" className="text-[10.5px] text-white/45 mt-1.5">下次去看看 TA：{nextAnchor}</div>
                </div>
            )}

            {/* 数据区：最近动静 */}
            <div className="mt-4 relative z-10">
                <div className="flex items-center justify-between px-1">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35">最近动静</div>
                    {recent.length > 5 && (
                        <button
                            type="button"
                            data-testid="home-expand"
                            onClick={() => setExpanded((v) => !v)}
                            className="text-[10px] text-white/50 active:scale-95 transition"
                            style={{ color: HOME_ACCENT }}
                        >
                            {expanded ? '收起来' : `全 ${recent.length} 条 →`}
                        </button>
                    )}
                </div>
                <div className="mt-2 space-y-2">
                    {shown.length === 0 && (
                        <div data-testid="home-empty" className="rounded-2xl p-3 bg-white/[0.03] border border-white/[0.06] text-[11px] text-white/40">
                            {offline ? '离线时先不打扰，等连上了动静会回来。' : '这边还没动静，TA 大概在发呆。'}
                        </div>
                    )}
                    {shown.map((m) => (
                        <div key={m.id} className="rounded-2xl p-3 bg-white/[0.035] border border-white/[0.06]">
                            <div className="flex items-center gap-2 text-[10px] text-white/40">
                                <span className="font-bold" style={{ color: HOME_ACCENT }}>{roleName(m.role)}</span>
                                <span className="tabular-nums">{fmtClock(m.createdAt)}</span>
                            </div>
                            <div className="text-[12.5px] text-white/85 leading-relaxed mt-1 whitespace-pre-wrap">{m.content || '（空消息）'}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* 行为区：四组参数 + 恢复默认 + 切源 */}
            <div className="mt-4 relative z-10 rounded-2xl p-3 border border-white/[0.06]" style={{ background: `linear-gradient(120deg, ${HOME_ACCENT}1f, ${HOME_ACCENT}08)` }}>
                <div className="flex items-center justify-between">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35">管一管 TA</div>
                    <button
                        type="button"
                        data-testid="home-reset"
                        onClick={resetConfig}
                        className="text-[10px] px-2.5 py-1 rounded-full bg-white/[0.07] text-white/60 border border-white/10 active:scale-95 transition"
                    >
                        恢复默认
                    </button>
                </div>
                <div className="mt-2 space-y-3">
                    {HOME_CONFIG_META.map((meta) => (
                        <div key={meta.key}>
                            <div className="flex items-baseline justify-between">
                                <div className="text-[12px] text-white/85">{meta.label}<span className="text-[10px] text-white/40 ml-1.5">{meta.hint}</span></div>
                                <div className="flex items-center gap-1 text-[12px] text-white tabular-nums">
                                    <input
                                        type="number"
                                        data-testid={`home-cfg-${meta.key}`}
                                        aria-label={meta.label}
                                        value={config[meta.key]}
                                        min={HOME_CONFIG_LIMITS[meta.key].min}
                                        max={HOME_CONFIG_LIMITS[meta.key].max}
                                        onChange={(e) => setConfig({ [meta.key]: Number(e.target.value) } as Partial<HomeConfig>)}
                                        className="w-14 bg-white/[0.06] border border-white/10 rounded-lg px-1.5 py-0.5 text-right text-[12px] text-white tabular-nums focus:outline-none"
                                    />
                                    <span className="text-[10px] text-white/40 w-6">{meta.unit}</span>
                                </div>
                            </div>
                            <input
                                type="range"
                                data-testid={`home-cfg-${meta.key}-slider`}
                                aria-label={`${meta.label}滑杆`}
                                value={config[meta.key]}
                                min={HOME_CONFIG_LIMITS[meta.key].min}
                                max={HOME_CONFIG_LIMITS[meta.key].max}
                                onChange={(e) => setConfig({ [meta.key]: Number(e.target.value) } as Partial<HomeConfig>)}
                                className="w-full mt-1 accent-amber-500"
                            />
                        </div>
                    ))}
                </div>
                <div className="mt-3 pt-3 border-t border-white/[0.06]">
                    <div className="flex items-center justify-between">
                        <div className="text-[12px] text-white/85">数据走哪边<span className="text-[10px] text-white/40 ml-1.5">当前：{source === 'vps' ? 'VPS' : '本机'}</span></div>
                        <button
                            type="button"
                            data-testid="home-source"
                            onClick={onSourceClick}
                            className="text-[10px] px-2.5 py-1 rounded-full bg-white/[0.07] text-white/70 border border-white/10 active:scale-95 transition"
                        >
                            {confirmSwitch ? `再点切${target}` : `切到${target}`}
                        </button>
                    </div>
                    {confirmSwitch && (
                        <div data-testid="home-source-confirm" className="text-[10.5px] text-amber-200/90 mt-1.5">
                            真的要切到{target}吗？再点一次按钮才算数，旧数据不会动。
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
