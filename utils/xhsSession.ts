// utils/xhsSession.ts
/**
 * XHS 会话状态与失败分类 —— 纯函数,无环境依赖。
 *
 * 分类依据是 bridgePost 能观察到的形态:
 * - HTTP 401:中心 worker 对「无 cookie」(worker/index.js /api 路由)。
 * - HTTP 200 + error 含「没有通过登录校验」:登录失效(worker/index.js:2364 既有文案)。
 * - check-login 成功响应但 logged_in:false。
 * - 超时/网络:不是过期(禁止误判成 cookie 过期触发无谓刷新)。
 * - 406/461/471:受保护接口拒绝(Spider v3 电路/风控),不是过期。
 */
export type XhsSessionSource = 'manual' | 'vps-bridge';

export type XhsSessionStatus =
    | 'unconfigured'
    | 'valid'
    | 'relogin_required'
    | 'bridge_unavailable';

export type XhsSessionFailureCode =
    | 'NO_SESSION'
    | 'SESSION_EXPIRED'
    | 'BRIDGE_UNAVAILABLE'
    | 'NETWORK_FAILURE'
    | 'UPSTREAM_REJECTED'
    | 'RATE_LIMITED'
    | 'UNKNOWN';

export interface XhsSessionDescriptor {
    source: XhsSessionSource;
    status: XhsSessionStatus;
    updatedAt?: number;
    nickname?: string;
    platform?: 'xhs' | 'rednote';
}

/** 只读命令才允许「刷新后重试一次」。写命令(点赞/收藏/评论/发布)结果未知,重放可能重复执行。 */
export const RETRYABLE_COMMANDS = new Set([
    'check-login', 'list-feeds', 'search', 'get-feed-detail', 'user-profile',
]);

export const classifyXhsBridgeFailure = (obs: {
    httpStatus?: number;
    errorText?: string;
    endpoint?: string;
    body?: any;
}): XhsSessionFailureCode => {
    const { httpStatus, errorText = '', endpoint, body } = obs;
    if (httpStatus === 401) return 'NO_SESSION';
    if (httpStatus === 429) return 'RATE_LIMITED';
    if (httpStatus === 406 || httpStatus === 461 || httpStatus === 471) return 'UPSTREAM_REJECTED';
    if (errorText.includes('没有通过登录校验')) return 'SESSION_EXPIRED';
    if (endpoint === 'check-login' && body && (body as any).logged_in === false) return 'SESSION_EXPIRED';
    if (errorText.includes('XHS_REQUEST_TIMEOUT')) return 'NETWORK_FAILURE';
    return 'UNKNOWN';
};

export const isSessionExpiry = (code: XhsSessionFailureCode): boolean => code === 'SESSION_EXPIRED';

/**
 * 断言序列化后不含敏感字段(cookie 键名 / a1= / web_session= 特征)。
 * amsg 上云前与 session descriptor 构造后的最后防线。
 */
export const assertNoCookieLeak = (obj: any): void => {
    const s = JSON.stringify(obj || {});
    if (/"cookie"/i.test(s) || /a1=/.test(s) || /web_session=/.test(s)) {
        throw new Error('SESSION_DESCRIPTOR_LEAK');
    }
};
