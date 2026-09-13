/**
 * perspective — 「透视窗」数据层（char 查看用户应用使用记录的云端会话日志）
 *
 * 数据面：用户自建 Cloudflare Worker + D1（pv_devices / pv_role_tokens /
 *         pv_sessions / pv_summaries）。旧 Supabase 直连已移除。
 * 上报侧：utils/perspectiveTelemetry.ts 经本地离线队列批量上传。
 * 消费侧：agenticTools 的 runPerspectiveQuery（聊天工具），二段总结在
 *         applyAssistantPostProcessing 的 [[PERSPECTIVE_QUERY]] 块里用主聊天 API 完成。
 *
 * 本文件必须环境无关（会被 amsg worker bundle 原样打包跑在服务端）：
 * - 顶层不碰 window / document / localStorage / IndexedDB
 * - 令牌经 PerspectiveRuntimeAuth 参数传入，不读任何全局存储
 *
 * 只记录「应用身份 + 会话时长」：appKey / appLabel / startedAt / endedAt /
 * durationMs。不设窗口标题 / URL / 正文 / 消息列。
 */

import type { RealtimeConfig } from '../types';
import type { AppActivitySession } from './platform/appActivity/types';

// ─── 配置解析 ──────────────────────────────────────────────────────────────

export interface PerspectiveRuntimeAuth {
    /** 设备 pvd_ 令牌或角色 pvc_ 只读令牌（存 SecureStore，不进 RealtimeConfig）。 */
    token?: string;
    deviceId?: string;
}

export interface PerspectiveEndpoint {
    workerUrl: string; // https://xxx.workers.dev（无尾斜杠）
    authToken: string;
    deviceId?: string;
}

/** 从 RealtimeConfig + 运行时令牌取透视窗端点；null = 未配置全。 */
export function resolvePerspectiveEndpoint(
    rc?: Partial<RealtimeConfig> | null,
    auth?: PerspectiveRuntimeAuth | null,
): PerspectiveEndpoint | null {
    const workerUrl = ((rc as Record<string, unknown> | null | undefined)?.['perspectiveWorkerUrl'] as string || '')
        .trim()
        .replace(/\/+$/, '');
    const token = (auth?.token || '').trim();
    if (!workerUrl || !token) return null;
    if (!/^https?:\/\//.test(workerUrl)) return null;
    return { workerUrl, authToken: token, deviceId: auth?.deviceId };
}

/** 全局开关 + 端点齐备才算启用。 */
export function isPerspectiveEnabled(
    rc?: Partial<RealtimeConfig> | null,
    auth?: PerspectiveRuntimeAuth | null,
): boolean {
    return !!(rc?.perspectiveEnabled && resolvePerspectiveEndpoint(rc, auth));
}

function authHeaders(ep: PerspectiveEndpoint): Record<string, string> {
    return {
        Authorization: `Bearer ${ep.authToken}`,
        'Content-Type': 'application/json',
    };
}

// ─── type 规范化（保留：查询 appKey 过滤与旧数据兼容）────────────────────────

const TYPE_RE = /^[a-z0-9]+(\.[a-z0-9]+)*$/;

/** 任意输入 → 合法 type（小写、非法字符转点、去首尾点）；整不成返回 null。 */
export function normalizePerspectiveType(raw: string): string | null {
    const t = (raw || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '.')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+|\.+$/g, '');
    return TYPE_RE.test(t) ? t : null;
}

// ─── 批量上传 ──────────────────────────────────────────────────────────────

export interface PerspectiveUploadBatch {
    deviceId: string;
    batchId: string;
    events: AppActivitySession[];
}

export type PerspectiveUploadResult =
    | { ok: true; accepted: number; duplicates: number }
    | {
        ok: false;
        reason: 'not_configured' | 'unauthorized' | 'rate_limited' | 'http' | 'network';
        status?: number;
        message?: string;
    };

/** 批量上传应用会话（幂等：服务端按 id 去重，重试保持同一 batchId 与 ids）。 */
export async function uploadPerspectiveSessions(
    rc: Partial<RealtimeConfig> | null | undefined,
    auth: PerspectiveRuntimeAuth | null | undefined,
    batch: PerspectiveUploadBatch,
): Promise<PerspectiveUploadResult> {
    const ep = resolvePerspectiveEndpoint(rc, auth);
    if (!ep) return { ok: false, reason: 'not_configured' };
    try {
        const res = await fetch(`${ep.workerUrl}/sessions`, {
            method: 'POST',
            headers: authHeaders(ep),
            body: JSON.stringify({ sessions: batch.events }),
        });
        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'unauthorized', status: res.status };
        }
        if (res.status === 429) return { ok: false, reason: 'rate_limited', status: 429 };
        if (!res.ok) {
            let message = '';
            try {
                message = ((await res.json()) as { error?: string })?.error || '';
            } catch { /* body 可能不是 JSON */ }
            return { ok: false, reason: 'http', status: res.status, message };
        }
        const body = (await res.json()) as { accepted?: number; duplicates?: number };
        return { ok: true, accepted: body.accepted ?? 0, duplicates: body.duplicates ?? 0 };
    } catch (e: any) {
        return { ok: false, reason: 'network', message: e?.message };
    }
}

// ─── 查询 ──────────────────────────────────────────────────────────────────

export const PERSPECTIVE_MAX_DAYS = 30;
export const PERSPECTIVE_MAX_LIMIT = 500;
export const PERSPECTIVE_DEFAULT_LIMIT = 100;

export interface PerspectiveSessionRow {
    id: string;
    device_id: string;
    platform: string;
    source: string;
    app_key: string;
    app_label: string;
    started_at: number;
    ended_at: number;
    duration_ms: number;
}

export interface QuerySessionsArgs {
    /** 近 N 天（默认 7，封顶 30）。since 给出时忽略。 */
    days?: number;
    since?: number;
    until?: number;
    /** 按 appKey 子串过滤（本地过滤，不区分大小写）。 */
    appKey?: string;
    limit?: number;
}

export type QuerySessionsResult =
    | {
        ok: true;
        since: number;
        until: number;
        total: number;
        sessions: PerspectiveSessionRow[];
        /** 给 char 直读的人话时间线（含按应用聚合尾注）。 */
        sessionsText: string;
        appCounts: Array<{ appKey: string; appLabel: string; count: number; totalDurationMs: number }>;
    }
    | { ok: false; reason: 'not_configured' | 'unauthorized' | 'http' | 'network' | 'empty'; status?: number; message?: string };

export async function queryPerspectiveSessions(
    rc: Partial<RealtimeConfig> | null | undefined,
    auth: PerspectiveRuntimeAuth | null | undefined,
    args: QuerySessionsArgs,
): Promise<QuerySessionsResult> {
    const ep = resolvePerspectiveEndpoint(rc, auth);
    if (!ep) return { ok: false, reason: 'not_configured' };

    const days = Math.min(Math.max(args.days ?? 7, 0.001), PERSPECTIVE_MAX_DAYS);
    const until = args.until ?? Date.now();
    const since = args.since ?? until - days * 86400_000;
    const limit = Math.min(Math.max(args.limit ?? PERSPECTIVE_DEFAULT_LIMIT, 1), PERSPECTIVE_MAX_LIMIT);

    const params = new URLSearchParams();
    params.set('since', String(Math.floor(since)));
    params.set('until', String(Math.floor(until)));
    params.set('limit', String(limit));

    try {
        const res = await fetch(`${ep.workerUrl}/sessions?${params.toString()}`, {
            method: 'GET',
            headers: authHeaders(ep),
        });
        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'unauthorized', status: res.status };
        }
        if (!res.ok) {
            let message = '';
            try {
                message = ((await res.json()) as { error?: string })?.error || '';
            } catch { /* noop */ }
            return { ok: false, reason: 'http', status: res.status, message };
        }
        const body = (await res.json()) as { sessions?: PerspectiveSessionRow[] };
        let rows = Array.isArray(body.sessions) ? body.sessions : [];
        const keyFilter = (args.appKey || '').trim().toLowerCase();
        if (keyFilter) {
            rows = rows.filter(
                (r) =>
                    r.app_key.toLowerCase().includes(keyFilter) ||
                    r.app_label.toLowerCase().includes(keyFilter),
            );
        }
        if (rows.length === 0) {
            return { ok: false, reason: 'empty', message: '窗口内没有应用使用记录' };
        }
        const byApp = new Map<string, { appKey: string; appLabel: string; count: number; totalDurationMs: number }>();
        for (const r of rows) {
            const cur = byApp.get(r.app_key) || {
                appKey: r.app_key,
                appLabel: r.app_label,
                count: 0,
                totalDurationMs: 0,
            };
            cur.count += 1;
            cur.totalDurationMs += r.duration_ms;
            byApp.set(r.app_key, cur);
        }
        const appCounts = Array.from(byApp.values()).sort((a, b) => b.totalDurationMs - a.totalDurationMs);
        return {
            ok: true,
            since,
            until,
            total: rows.length,
            sessions: rows,
            sessionsText: buildSessionsText(rows, appCounts),
            appCounts,
        };
    } catch (e: any) {
        return { ok: false, reason: 'network', message: e?.message };
    }
}

/** 本地时间「M月d日 HH:mm」——不引依赖，够 char 读。 */
function fmtLocal(ts: number): string {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtMinutes(ms: number): string {
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return `约${m}分钟`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `约${h}小时${rest}分钟` : `约${h}小时`;
}

export function buildSessionsText(
    rows: PerspectiveSessionRow[],
    appCounts: Array<{ appKey: string; appLabel: string; count: number; totalDurationMs: number }>,
): string {
    const lines = rows.map((r) => `[${fmtLocal(r.started_at)}] ${r.app_label}（${fmtMinutes(r.duration_ms)}）`);
    const summary = appCounts.map((t) => `${t.appLabel}${fmtMinutes(t.totalDurationMs)}`).join('、');
    return `${lines.join('\n')}\n\n（共 ${rows.length} 段：${summary}）`;
}

// ─── 总结缓存 ──────────────────────────────────────────────────────────────

export interface PerspectiveSummaryRow {
    id: string;
    device_id: string;
    window_start: number;
    window_end: number;
    session_count: number;
    total_duration_ms: number;
    summary: string;
    model: string;
    created_at: number;
}

/** 窗口内会话总数（服务端按时间窗计数，不拉行）。 */
export async function countPerspectiveSessions(
    rc: Partial<RealtimeConfig> | null | undefined,
    auth: PerspectiveRuntimeAuth | null | undefined,
    args: { since: number; until: number },
): Promise<{ ok: true; count: number } | { ok: false; reason: 'not_configured' | 'unauthorized' | 'http' | 'network'; status?: number; message?: string }> {
    const ep = resolvePerspectiveEndpoint(rc, auth);
    if (!ep) return { ok: false, reason: 'not_configured' };
    const params = new URLSearchParams();
    params.set('since', String(Math.floor(args.since)));
    params.set('until', String(Math.floor(args.until)));
    params.set('limit', '1');
    try {
        const res = await fetch(`${ep.workerUrl}/sessions?${params.toString()}`, {
            method: 'GET',
            headers: authHeaders(ep),
        });
        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'unauthorized', status: res.status };
        }
        if (!res.ok) return { ok: false, reason: 'http', status: res.status };
        const body = (await res.json()) as { sessions?: unknown[] };
        return { ok: true, count: Array.isArray(body.sessions) ? body.sessions.length : 0 };
    } catch (e: any) {
        return { ok: false, reason: 'network', message: e?.message };
    }
}

/** 窗口结束时间早于 until 的最近一条总结（可复用即命中）。 */
export async function getLatestPerspectiveSummary(
    rc: Partial<RealtimeConfig> | null | undefined,
    auth: PerspectiveRuntimeAuth | null | undefined,
    args: { until?: number },
): Promise<{ ok: true; summary: PerspectiveSummaryRow | null } | { ok: false; reason: 'not_configured' | 'unauthorized' | 'http' | 'network'; status?: number; message?: string }> {
    const ep = resolvePerspectiveEndpoint(rc, auth);
    if (!ep) return { ok: false, reason: 'not_configured' };
    const params = new URLSearchParams();
    if (args.until != null) params.set('until', String(Math.floor(args.until)));
    try {
        const res = await fetch(`${ep.workerUrl}/summaries?${params.toString()}`, {
            method: 'GET',
            headers: authHeaders(ep),
        });
        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'unauthorized', status: res.status };
        }
        if (!res.ok) return { ok: false, reason: 'http', status: res.status };
        const body = (await res.json()) as { summary?: PerspectiveSummaryRow | null };
        return { ok: true, summary: body.summary ?? null };
    } catch (e: any) {
        return { ok: false, reason: 'network', message: e?.message };
    }
}

export async function savePerspectiveSummary(
    rc: Partial<RealtimeConfig> | null | undefined,
    auth: PerspectiveRuntimeAuth | null | undefined,
    args: { windowStart: number; windowEnd: number; sessionCount: number; totalDurationMs: number; summary: string; model: string },
): Promise<{ ok: true } | { ok: false; reason: 'not_configured' | 'unauthorized' | 'http' | 'network'; status?: number; message?: string }> {
    const ep = resolvePerspectiveEndpoint(rc, auth);
    if (!ep) return { ok: false, reason: 'not_configured' };
    try {
        const res = await fetch(`${ep.workerUrl}/summaries`, {
            method: 'POST',
            headers: authHeaders(ep),
            body: JSON.stringify({
                windowStart: args.windowStart,
                windowEnd: args.windowEnd,
                sessionCount: args.sessionCount,
                totalDurationMs: args.totalDurationMs,
                summary: args.summary,
                model: args.model,
            }),
        });
        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'unauthorized', status: res.status };
        }
        if (!res.ok) {
            let message = '';
            try {
                message = ((await res.json()) as { error?: string })?.error || '';
            } catch { /* noop */ }
            return { ok: false, reason: 'http', status: res.status, message };
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, reason: 'network', message: e?.message };
    }
}

// ─── 窗口工具（epoch ms；调用方传 days，until 缺省 = now）────────────────────

export function perspectiveWindow(days: number, until?: number): { since: number; until: number } {
    const untilMs = until ?? Date.now();
    const since = untilMs - Math.max(days, 0.001) * 86400_000;
    return { since, until: untilMs };
}

// ─── 查询侧冷却（模块级状态；浏览器与 worker 各自持有，语义均为「同实例内的节流」）───

let lastPerspectiveQueryAt = 0;

/** 距上次调用是否已满 minIntervalSec；未满返回还需等待的秒数。 */
export function checkPerspectiveInterval(minIntervalSec: number): { allowed: boolean; waitSec: number } {
    const min = Math.max(minIntervalSec || 0, 0) * 1000;
    if (min <= 0) return { allowed: true, waitSec: 0 };
    const waitMs = lastPerspectiveQueryAt + min - Date.now();
    return waitMs > 0 ? { allowed: false, waitSec: Math.ceil(waitMs / 1000) } : { allowed: true, waitSec: 0 };
}

/** 记录一次调用时刻（在通过冷却检查后调用）。 */
export function markPerspectiveCalled(): void {
    lastPerspectiveQueryAt = Date.now();
}

/** 测试用：清空冷却状态。 */
export function resetPerspectiveInterval(): void {
    lastPerspectiveQueryAt = 0;
}

/** 清空本设备会话（设置页「清空记录」按钮用）。beforeDays 缺省 = 清全部。 */
export async function clearPerspectiveSessions(
    rc: Partial<RealtimeConfig> | null | undefined,
    auth: PerspectiveRuntimeAuth | null | undefined,
    args: { beforeDays?: number },
): Promise<{ ok: true; deleted: number } | { ok: false; reason: 'not_configured' | 'unauthorized' | 'http' | 'network'; status?: number; message?: string }> {
    const ep = resolvePerspectiveEndpoint(rc, auth);
    if (!ep) return { ok: false, reason: 'not_configured' };
    const params = new URLSearchParams();
    if (args.beforeDays && args.beforeDays > 0) params.set('beforeDays', String(args.beforeDays));
    const qs = params.toString();
    try {
        const res = await fetch(`${ep.workerUrl}/sessions${qs ? `?${qs}` : ''}`, {
            method: 'DELETE',
            headers: authHeaders(ep),
        });
        if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'unauthorized', status: res.status };
        }
        if (!res.ok) return { ok: false, reason: 'http', status: res.status };
        const body = (await res.json()) as { deleted?: number };
        return { ok: true, deleted: body.deleted ?? 0 };
    } catch (e: any) {
        return { ok: false, reason: 'network', message: e?.message };
    }
}

// ─── 摘要统计（供工具层直接给 char 或经副 API 总结）─────────────────────────

export interface PerspectiveDigest {
    text: string;
    specialties: string[];
}

/**
 * 从应用会话提炼「特殊情况」：深夜活跃、最高频应用、单日峰值、分时直方图。
 * 小时数取运行环境本地时区（展示口径，不影响存储）。
 */
export function buildPerspectiveDigest(rows: PerspectiveSessionRow[], windowDays: number): PerspectiveDigest {
    if (!rows.length) return { text: '', specialties: [] };
    const specialties: string[] = [];
    const byApp = new Map<string, { label: string; ms: number; count: number }>();
    const hourBuckets: number[] = new Array(24).fill(0);
    const dayBuckets = new Map<string, number>();
    let totalMs = 0;
    for (const r of rows) {
        totalMs += r.duration_ms;
        const cur = byApp.get(r.app_key) || { label: r.app_label, ms: 0, count: 0 };
        cur.ms += r.duration_ms;
        cur.count += 1;
        byApp.set(r.app_key, cur);
        const d = new Date(r.started_at);
        if (!Number.isNaN(d.getTime())) {
            hourBuckets[d.getHours()]++;
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            dayBuckets.set(key, (dayBuckets.get(key) || 0) + 1);
        }
    }
    const total = rows.length;
    // 深夜活跃（0-5 点占比 > 15% 且至少 3 段）
    const nightCount = hourBuckets.slice(0, 6).reduce((a, b) => a + b, 0);
    if (nightCount >= 3 && nightCount / total > 0.15) {
        specialties.push(`深夜时段（0-5点）有 ${nightCount} 段使用，占 ${Math.round((nightCount / total) * 100)}%`);
    }
    // 最高频应用（按时长）
    const topApp = Array.from(byApp.values()).sort((a, b) => b.ms - a.ms)[0];
    if (topApp && topApp.count >= 2) {
        specialties.push(`使用最久的是「${topApp.label}」（${topApp.count} 段，${fmtMinutes(topApp.ms)}）`);
    }
    // 单日峰值
    let peakDay = '';
    let peakCount = 0;
    for (const [k, v] of dayBuckets) {
        if (v > peakCount) { peakCount = v; peakDay = k; }
    }
    if (peakDay && peakCount >= 5) specialties.push(`单日峰值在 ${peakDay}（${peakCount} 段）`);
    // 分时直方图（紧凑：只列有活动的时段）
    const histMax = Math.max(...hourBuckets, 1);
    const hist = hourBuckets
        .map((c, h) => (c ? `${String(h).padStart(2, '0')}时${'#'.repeat(Math.max(1, Math.round((c / histMax) * 8)))}(${c})` : ''))
        .filter(Boolean)
        .join(' ');
    const lines = [
        `统计窗口：近 ${windowDays} 天，共 ${total} 段使用，总计${fmtMinutes(totalMs)}`,
        ...specialties.map((s) => `· ${s}`),
        hist ? `分时分布：${hist}` : '',
    ].filter(Boolean);
    return { text: lines.join('\n'), specialties };
}
