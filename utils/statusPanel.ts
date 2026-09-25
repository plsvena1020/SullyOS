/**
 * 模块级状态探测层。
 *
 * 设置页已没有统一「系统状态」面板：各功能模块的卡片标题栏各挂一枚 StatusBadge
 * （components/StatusBadge.tsx），这里按模块 key 提供独立探针。全部探针独立
 * try/catch + 超时控制，单个模块挂了不拖累别的模块；结果由 StatusBadge 缓存
 * （60 秒内复用，跨区块切换不闪灰）。
 *
 * 状态口径：
 *   ok      绿 —— 配置齐且连通 / 就绪
 *   warn    琥珀 —— 配了但未验证 / 配置不完整
 *   err     红 —— 配了但不可达
 *   off     灰 —— 未配置（合法状态，不是错误）
 *   checking 脉冲 —— 探测中
 */
import type { APIConfig, RealtimeConfig } from '../types';
import { queryPerspectiveEvents } from './perspective';
import { getEffectiveBridges } from './bridgeRegistry';
import { ActiveMsgStore } from './activeMsgStore';
import { loadMcpServers } from './mcpClient';
import { classifyFetchFailure, probeOriginReachability, toSameOriginProxyUrl } from './networkFailureDiagnosis';
import { PERCEPTION_CAPABILITIES } from './perceptionRegistry';

export type BridgeProbeStatus = 'ok' | 'warn' | 'err' | 'off' | 'checking';

export interface StatusEntry {
    key: string;
    label: string;
    status: BridgeProbeStatus;
    /** 一句话说明（如「47ms」「HTTP 403」「未配置」），徽章直接显示它。 */
    detail?: string;
}

/** 带超时的 fetch（AbortController）。 */
const fetchWithTimeout = async (url: string, ms: number, init?: RequestInit): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { signal: ctrl.signal, ...init });
    } finally {
        clearTimeout(timer);
    }
};

/** 毫秒数 → 「xxx ms」，探测耗时展示。 */
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

const shortNetworkFailureDetail = async (url: string, err: any): Promise<string> => {
    try {
        const nm = (err as any)?.name;
        if (nm === 'AbortError' || nm === 'TimeoutError') return '超时';
        const kind = classifyFetchFailure({ url, error: err });
        if (kind === 'offline') return '离线';
        if (kind === 'mixed-content') return '混合内容';
        if (kind === 'bad-url') return '地址有误';
        try {
            const verdict = await probeOriginReachability(url, fetch, { timeoutMs: 6000 });
            if (verdict === 'unreachable') return '不可达·查分流/DNS';
            if (verdict === 'timeout') return '超时·换节点试';
            if (verdict === 'reachable') return '拦截·查扩展/CORS';
            return '不可达';
        } catch {
            return '不可达';
        }
    } catch {
        return '不可达';
    }
};

/** 提取 JSON 错误体里的 message 字段（主代理 /agent/v1 的 4xx 都带）。 */
const errMessage = (body: unknown): string | undefined => {
    if (!body || typeof body !== 'object') return undefined;
    const m = (body as Record<string, unknown>).message;
    return typeof m === 'string' ? m : undefined;
};

/**
 * API 配置：三件套（地址/密钥/模型）齐全即绿，缺项按缺几样报灰/黄。零网络依赖 ——
 * 「配置完备」和「服务可达」分开说：可达性由聊天本身与「测试连接」按钮负责。
 */
export const probeApiConfig = async (apiConfig: APIConfig): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'api', label: 'API 配置', status: 'off', detail: '未配置' };
    const hasUrl = !!apiConfig.baseUrl?.trim();
    const hasKey = !!apiConfig.apiKey?.trim();
    const hasModel = !!apiConfig.model?.trim();
    const filled = [hasUrl, hasKey, hasModel].filter(Boolean).length;
    if (filled === 0) return entry;
    if (filled === 3) return { ...entry, status: 'ok', detail: '配置齐全' };
    const missing = [
        !hasUrl ? '地址' : '',
        !hasKey ? '密钥' : '',
        !hasModel ? '模型' : '',
    ].filter(Boolean).join('、');
    return { ...entry, status: 'warn', detail: `缺${missing}` };
};

/**
 * 主代理中转：`GET {agentUrl}/agent/health`（后端免鉴权健康端点，服务活着即 200）。
 * 注意：不能用 `/agent/v1/health`——经 Caddy 剥 `/agent` 前缀后落到后端 `/v1/health`，
 * 该路径命中 checkAuth（未带 X-Client-Token 时返回 403），与「测试中转连接」按钮口径
 * （先探 /agent/health 再带 token 探 /agent/v1/tools）不一致，导致徽章恒显 403。
 * 这里对齐按钮：先探免鉴权 /health 判可达；若填了 token 则顺带带 X-Client-Token，
 * 让「服务在但 token 口径不对」也能被识别出来。
 * 留空 = 直连模式（合法状态，灰）。
 */
export const probeAgent = async (apiConfig: APIConfig): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'agent-relay', label: '主代理中转', status: 'off', detail: '直连' };
    const base = (apiConfig.agentUrl || '').replace(/\/+$/, '');
    if (!base) return entry;
    const t0 = performance.now();
    try {
        const token = String(apiConfig.agentToken || '').trim();
        const headers: Record<string, string> = {};
        if (token) headers['X-Client-Token'] = token;
        const res = await fetchWithTimeout(`${base}/agent/health`, 5000, { headers });
        const ms = fmtMs(performance.now() - t0);
        if (res.ok) {
            return { ...entry, status: 'ok', detail: ms };
        }
        if (res.status < 500) {
            let body: unknown = null;
            try { body = await res.json(); } catch { /* body 可能不是 JSON */ }
            const msg = errMessage(body);
            return { ...entry, status: 'warn', detail: `HTTP ${res.status}${msg ? ' · ' + msg : ''}` };
        }
        return { ...entry, status: 'err', detail: `HTTP ${res.status}` };
    } catch (e: any) {
        const proxyAgentUrl = toSameOriginProxyUrl(`${base}/agent/health`, base);
        if (proxyAgentUrl) {
            try {
                const proxyRes = await fetchWithTimeout(proxyAgentUrl, 6000);
                if (proxyRes.ok) return { ...entry, status: 'warn', detail: '直连不通·中转可用' };
            } catch { /* proxy path unavailable, fall through */ }
        }
        return { ...entry, status: 'err', detail: await shortNetworkFailureDetail(`${base}/agent/health`, e) };
    }
};

/**
 * 外部连接桥：探第一座启用桥的 `GET {url}{healthPath}`，3 秒超时。
 * 多桥清单见 bridgeRegistry（bridges 数组优先，兼容旧 bridge 单桥）。
 * 默认 path 是 `/`：只要域名活着就算连通；对方有专用健康端点时用户自填。
 */
export const probeBridge = async (apiConfig: APIConfig): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'bridge', label: '外部连接桥', status: 'off', detail: '未启用' };
    const bridges = getEffectiveBridges(apiConfig);
    const bridge = bridges.find((b) => b.enabled && b.url);
    if (!bridge) return entry;
    const total = bridges.filter((b) => b.enabled).length;
    const label = total > 1 ? `外部连接桥(${total})` : '外部连接桥';
    const base = bridge.url.replace(/\/+$/, '');
    const path = bridge.healthPath || '/';
    const t0 = performance.now();
    try {
        const headers: Record<string, string> = {};
        if (bridge.token) headers['Authorization'] = `Bearer ${bridge.token}`;
        const res = await fetchWithTimeout(`${base}${path.startsWith('/') ? path : '/' + path}`, 3000, { headers });
        const ms = fmtMs(performance.now() - t0);
        if (res.ok) return { ...entry, label, status: 'ok', detail: ms };
        if (res.status < 500) return { ...entry, label, status: 'warn', detail: `HTTP ${res.status}` };
        return { ...entry, label, status: 'err', detail: `HTTP ${res.status}` };
    } catch (e: any) {
        return { ...entry, label, status: 'err', detail: e?.name === 'AbortError' ? '超时' : '不可达' };
    }
};

/**
 * 主动消息 2.0（AMSG worker）：`GET {workerUrl}/health` 探活。
 * 老 bundle 没有 /health 路由（404），此时回退 /config-check：能答上来说明服务
 * 本身在跑，只是探活端点缺席 —— 报 warn「已配置·未验证」而不是红的「不可达」。
 */
export const probeAmsgWorker = async (): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'amsg', label: '主动消息', status: 'off', detail: '未配置' };
    try {
        const cfg = await ActiveMsgStore.getGlobalConfig();
        if (!cfg || !cfg.workerUrl) return entry;
        const base = cfg.workerUrl.replace(/\/+$/, '');
        const t0 = performance.now();
        let res: Response;
        try {
            res = await fetchWithTimeout(`${base}/health`, 5000);
        } catch (e: any) {
            const proxyAmsgUrl = toSameOriginProxyUrl(`${base}/health`, base);
            try {
                if (proxyAmsgUrl) {
                    const proxyRes = await fetchWithTimeout(proxyAmsgUrl, 6000);
                    if (proxyRes.ok) return { ...entry, status: 'warn', detail: '直连不通·中转可用' };
                }
            } catch { /* proxy path unavailable, fall through */ }
            return { ...entry, status: 'err', detail: await shortNetworkFailureDetail(`${base}/health`, e) };
        }
        const ms = fmtMs(performance.now() - t0);
        if (res.ok) return { ...entry, status: 'ok', detail: ms };
        if (res.status === 404) {
            // 老 bundle：没有探活路由。拿 config-check 再确认一次服务在不在。
            try {
                const r2 = await fetchWithTimeout(`${base}/config-check`, 5000);
                if (r2.ok) return { ...entry, status: 'warn', detail: '已配置·未验证' };
            } catch { /* config-check 也挂 → 走下面的 err */ }
            return { ...entry, status: 'err', detail: '不可达' };
        }
        if (res.status < 500) return { ...entry, status: 'warn', detail: `HTTP ${res.status}` };
        return { ...entry, status: 'err', detail: `HTTP ${res.status}` };
    } catch {
        return { ...entry, status: 'err', detail: '读取失败' };
    }
};

/**
 * 识图 API：开关 + 三件套齐全即绿；开着但缺项报黄缺什么；关着是灰。
 * 可达性不在这里探 —— 识图走聊天内真实调用，配置完备性才是这个徽章的职责。
 */
export const probeVisionApi = async (apiConfig: APIConfig): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'vision-api', label: '识图 API', status: 'off', detail: '未接入' };
    const v = apiConfig.visionApi;
    if (!v?.enabled) return entry;
    const missing = [
        !v.baseUrl?.trim() ? '地址' : '',
        !v.apiKey?.trim() ? '密钥' : '',
        !v.model?.trim() ? '模型' : '',
    ].filter(Boolean);
    if (missing.length === 0) return { ...entry, status: 'ok', detail: '已接入' };
    return { ...entry, status: 'warn', detail: `缺${missing.join('、')}` };
};

/**
 * 云端备份：GitHub 供应商现场验一次令牌（GET api.github.com/user）；
 * WebDAV 只看配置完备性（跨域环境里浏览器侧无中转探测不了，留给真实备份去验）。
 * 都没配是灰。
 */
export const probeCloudBackup = async (apiConfig: APIConfig): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'cloud-backup', label: '云端备份', status: 'off', detail: '未配置' };
    let cfg: any = null;
    try {
        const raw = localStorage.getItem('os_cloud_backup_config');
        if (raw) cfg = JSON.parse(raw);
    } catch { /* 坏 JSON 当没配 */ }
    if (!cfg) return entry;
    const provider = cfg.provider === 'github' ? 'github' : 'webdav';
    if (provider === 'webdav') {
        const ok = !!(cfg.webdavUrl?.trim() && cfg.username?.trim() && cfg.password?.trim());
        return ok ? { ...entry, status: 'ok', detail: 'WebDAV 已配置' } : { ...entry, status: 'warn', detail: 'WebDAV 缺配置' };
    }
    // GitHub：令牌在手里就现场验一遍，4xx = 令牌失效（这是真实会发生的坏法）。
    if (!cfg.githubToken?.trim()) return { ...entry, status: 'warn', detail: 'GitHub 缺令牌' };
    try {
        const res = await fetchWithTimeout('https://api.github.com/user', 5000, {
            headers: { 'Authorization': `Bearer ${cfg.githubToken}`, 'Accept': 'application/vnd.github+json' },
        });
        if (res.ok) return { ...entry, status: 'ok', detail: 'GitHub 已连接' };
        if (res.status === 401 || res.status === 403) return { ...entry, status: 'err', detail: '令牌无效' };
        return { ...entry, status: 'warn', detail: `HTTP ${res.status}` };
    } catch (e: any) {
        return { ...entry, status: 'err', detail: e?.name === 'AbortError' ? '超时' : '不可达' };
    }
};

/**
 * 实时感知：只数“已配置好”的能力（与宫格 on 态同口径）。
 * 未配置的不计数、不列缺项——宫格灰态自带提示，徽章只给数字。
 */
export const probeRealtime = async (realtimeConfig: RealtimeConfig): Promise<StatusEntry> => {
    const done = PERCEPTION_CAPABILITIES.filter((c) => {
        try {
            return c.enabled(realtimeConfig) && c.configured(realtimeConfig);
        } catch {
            return false;
        }
    });
    if (done.length === 0) return { key: 'realtime', label: '实时感知', status: 'off', detail: '未启用' };
    return { key: 'realtime', label: '实时感知', status: 'ok', detail: `${done.length} 项已配置` };
};

/**
 * MCP 工具服务器：本地清单有没有、启没启用。有启用的报工具数；
 * 配了但全关着是 warn（配了不用，多半是忘了）；没配是灰。
 */
export const probeMcpServers = async (): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'mcp-servers', label: 'MCP', status: 'off', detail: '未配置' };
    try {
        const list = loadMcpServers();
        if (!list.length) return entry;
        const on = list.filter((s) => s.enabled && s.tools?.length);
        const toolCount = on.reduce((n, s) => n + (s.tools?.length || 0), 0);
        if (on.length === 0) return { ...entry, status: 'warn', detail: `${list.length} 个配置·0 启用` };
        return { ...entry, status: 'ok', detail: `${on.length} 启用${toolCount ? `·${toolCount} 工具` : ''}` };
    } catch {
        return { ...entry, status: 'err', detail: '读取失败' };
    }
};

/**
 * 透视窗：Supabase 端点配好 + 拉一次空查询即 ok。失败给具体 HTTP 状态。
 * off = 未配置（不是错误）；配了但连不上才是红。
 */
export const probePerspective = async (realtimeConfig: RealtimeConfig): Promise<StatusEntry> => {
    const entry: StatusEntry = { key: 'perspective', label: '透视窗', status: 'off', detail: '未配置' };
    if (!realtimeConfig.perspectiveEnabled) return entry;
    if (!realtimeConfig.perspectiveSupabaseUrl?.trim() || !realtimeConfig.perspectiveSupabaseAnonKey?.trim()) {
        return { ...entry, status: 'warn', detail: '缺 URL 或 anon key' };
    }
    try {
        const r = await queryPerspectiveEvents(realtimeConfig, { days: 1, limit: 1 });
        if (r.ok) return { key: 'perspective', label: '透视窗', status: 'ok', detail: 'Supabase 已连接' };
        if (r.reason === 'empty') return { key: 'perspective', label: '透视窗', status: 'ok', detail: '已连接 · 暂无记录' };
        if (r.reason === 'http' && r.status === 401) return { ...entry, status: 'err', detail: '鉴权失败 (401)' };
        if (r.reason === 'http') return { ...entry, status: 'err', detail: `HTTP ${r.status}` };
        return { ...entry, status: 'err', detail: r.message || '不可达' };
    } catch {
        return { ...entry, status: 'err', detail: '探测失败' };
    }
};

export { probeHome } from '../components/home/HomeBadgeBridge';
