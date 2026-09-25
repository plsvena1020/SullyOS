/**
 * 模块级状态徽章 —— 挂在各功能模块卡片（SettingsSection）标题栏的小圆签。
 *
 * 统一「系统状态」面板拆除后，模块状态看这里：绿=已配置且就绪，琥珀=已配置·未
 * 验证/配置缺项，红=配了但不可达，灰=未配置。探测逻辑见 utils/statusPanel.ts；
 * 结果按 badgeKey 缓存 localStorage（60 秒内复用，跨区块切换不闪灰），点徽章强刷。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { StatusEntry, BridgeProbeStatus } from '../utils/statusPanel';

const CACHE_KEY = 'status_badge_cache_v1';
const CACHE_TTL_MS = 60 * 1000;

const STATUS_STYLES: Record<BridgeProbeStatus, { dot: string; text: string; bg: string }> = {
    ok: { dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-50' },
    warn: { dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50' },
    err: { dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50' },
    off: { dot: 'bg-slate-300', text: 'text-slate-400', bg: 'bg-slate-100' },
    checking: { dot: 'bg-slate-400 animate-pulse', text: 'text-slate-400', bg: 'bg-slate-100' },
};

const readCache = (): Record<string, { at: number; entry: StatusEntry }> => {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return {};
        return JSON.parse(raw) || {};
    } catch {
        return {};
    }
};

const writeCache = (key: string, entry: StatusEntry) => {
    try {
        const cache = readCache();
        cache[key] = { at: Date.now(), entry };
        // 顺手清掉过期条目，缓存不会越积越多。
        for (const k of Object.keys(cache)) {
            if (Date.now() - cache[k].at > CACHE_TTL_MS * 10) delete cache[k];
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch { /* 存储满就算了 */ }
};

/** 清掉指定徽章的缓存，下一次渲染立即重探（保存设置后调用）。 */
export const invalidateBadge = (key: string) => {
    try {
        const cache = readCache();
        delete cache[key];
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch { /* ignore */ }
};

interface StatusBadgeProps {
    /** 缓存键，同模块各处共用一份探测结果。 */
    badgeKey: string;
    /** 该模块的探针（见 utils/statusPanel.ts）。 */
    probe: () => Promise<StatusEntry>;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ badgeKey, probe }) => {
    const [entry, setEntry] = useState<StatusEntry | null>(null);
    const [checking, setChecking] = useState(false);
    const mounted = useRef(true);

    const runProbe = useCallback(async (force: boolean) => {
        if (!force) {
            const cached = readCache()[badgeKey];
            if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
                setEntry(cached.entry);
                return;
            }
        }
        setChecking(true);
        try {
            const result = await probe();
            if (!mounted.current) return;
            setEntry(result);
            writeCache(badgeKey, result);
        } catch {
            if (mounted.current) setEntry({ key: badgeKey, label: badgeKey, status: 'err', detail: '探测失败' });
        } finally {
            if (mounted.current) setChecking(false);
        }
    }, [badgeKey, probe]);

    useEffect(() => {
        mounted.current = true;
        runProbe(false);
        // 60 秒静默刷新：卡片常驻时自动保持新鲜。
        const timer = setInterval(() => { runProbe(true); }, CACHE_TTL_MS);
        return () => { mounted.current = false; clearInterval(timer); };
    }, [runProbe]);

    const st = STATUS_STYLES[(checking ? 'checking' : entry?.status) || 'checking'];
    const label = entry?.label ?? '…';
    const detail = checking ? '探测中' : entry?.detail;
    return (
        <button
            type="button"
            onClick={(e) => { e.stopPropagation(); runProbe(true); }}
            title={`${label}：${detail ?? '未探测'}（点击重新探测）`}
            className={`inline-flex items-center gap-1.5 shrink-0 px-2 py-1 rounded-full text-[9px] font-bold ${st.bg} ${st.text} active:scale-95 transition-all duration-200`}
        >
            <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />
            <span className="max-w-[9rem] truncate">{detail ?? label}</span>
        </button>
    );
};

export default StatusBadge;
