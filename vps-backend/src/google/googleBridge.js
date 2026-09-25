// vps-backend/src/google/googleBridge.js
// Google 桥:bridge token 鉴权 + 服务器内换 access token + 透传 Calendar/Tasks 只读接口。
// 红线:refresh/access token 原值不进日志、不进响应;响应一律 no-store。归一化不在桥内做。
import http from 'node:http';

const sanitize = (text) => String(text ?? '')
    .replace(/refresh_token=[^&\s"']+/g, 'refresh_token=[REDACTED]')
    .replace(/access_token=[^&\s"']+/g, 'access_token=[REDACTED]')
    .replace(/("refresh_token"\s*:\s*")[^"]*(")/g, '$1[REDACTED]$2')
    .replace(/("access_token"\s*:\s*")[^"]*(")/g, '$1[REDACTED]$2');

const DEFAULT_CORS_HEADERS = 'Content-Type, X-Bridge-Token, X-Xhs-Platform, X-Rnote-API-Key, X-Google-Bridge-Token, X-Google-Account';

// 全局统一时区：Google 账号自身可能设在 America/New_York 等，但用户在中国，
// 所有拉取/写入都用 Asia/Shanghai，前端再按本地钟点显示，不必逐条换算。
const DISPLAY_TIME_ZONE = 'Asia/Shanghai';

export function startGoogleBridge({ port, host = '127.0.0.1', token, store, clientId, clientSecret, redirectUri }) {
    if (!token) throw new Error('GOOGLE_BRIDGE_TOKEN is required');

    // access token 内存缓存:Map<accountId, { token, expiresAtMs }>。
    const accessCache = new Map();

    const server = http.createServer(async (req, res) => {
        const startedAt = Date.now();
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const method = (req.method || 'GET').toUpperCase();

        // 浏览器跨域调用要求「预检」与「实际响应」都带 Access-Control-Allow-Origin，
        // 只在 OPTIONS 回显会让真实请求被浏览器拦成 Failed to fetch。业务响应一律带上。
        const corsOrigin = req.headers.origin || '*';
        const finish = (status, body, extraHeaders = {}) => {
            const payload = body === null ? '' : JSON.stringify(body);
            res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'access-control-allow-origin': corsOrigin,
                'vary': 'Origin',
                ...extraHeaders,
            });
            res.end(payload);
            console.log(`[google-bridge] ${method} ${path} -> ${status} (${Date.now() - startedAt}ms)`);
        };

        // CORS 预检:照抄 xhs 契约(净化回显请求头 + 204 + 鉴权前)。
        if (method === 'OPTIONS') {
            const origin = req.headers.origin || '*';
            const requestedHeaders = String(req.headers['access-control-request-headers'] || DEFAULT_CORS_HEADERS)
                .split(',').map((s) => s.trim()).filter((h) => /^[\w-]+$/.test(h));
            return finish(204, null, {
                'access-control-allow-origin': origin,
                'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
                'access-control-allow-headers': requestedHeaders.length ? requestedHeaders.join(', ') : DEFAULT_CORS_HEADERS,
                'access-control-max-age': '86400',
            });
        }

        if (path === '/api/health' && method === 'GET') {
            return finish(200, { status: 'ok', backend: 'google-bridge' });
        }

        // 鉴权:除 health 外全部要求 x-google-bridge-token 精确相等。
        const provided = String(req.headers['x-google-bridge-token'] || '');
        if (!provided || provided !== token) {
            return finish(401, { error: 'unauthorized' });
        }

        const readJsonBody = async () => {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const raw = Buffer.concat(chunks).toString('utf8') || '{}';
            try { return JSON.parse(raw); } catch { return {}; }
        };

        const postTokenEndpoint = async (params) => {
            let upstream;
            try {
                upstream = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: params.toString(),
                });
            } catch {
                throw new Error('UPSTREAM_UNREACHABLE');
            }
            let data = {};
            try { data = await upstream.json(); } catch { data = {}; }
            return { upstream, data };
        };

        const getAccessToken = async (accountId) => {
            const cached = accessCache.get(accountId);
            if (cached && Date.now() < cached.expiresAtMs - 60_000) return cached.token;
            const refreshToken = await store.loadRefresh(accountId);
            if (!refreshToken) throw new Error('REAUTH_REQUIRED');
            const params = new URLSearchParams({
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
            });
            const { upstream, data } = await postTokenEndpoint(params);
            if (!upstream.ok) {
                if (upstream.status === 400 || upstream.status === 401) {
                    accessCache.delete(accountId);
                    throw new Error('REAUTH_REQUIRED');
                }
                throw new Error('UPSTREAM_TOKEN_ERROR');
            }
            accessCache.set(accountId, {
                token: data.access_token,
                expiresAtMs: Date.now() + Number(data.expires_in ?? 3600) * 1000,
            });
            return data.access_token;
        };

        const googleGet = async (accountId, upstreamUrl) => {
            const access = await getAccessToken(accountId);
            let upstream;
            try {
                upstream = await fetch(upstreamUrl, { headers: { authorization: `Bearer ${access}` } });
            } catch {
                throw new Error('UPSTREAM_UNREACHABLE');
            }
            let data = {};
            try { data = await upstream.json(); } catch { data = {}; }
            if (!upstream.ok) {
                if (upstream.status === 401) {
                    accessCache.delete(accountId);
                    throw new Error('REAUTH_REQUIRED');
                }
                // 带上 Google 的真实原因（invalid_scope / forbidden / notFound…），否则前端只看到
                // 笼统的 bridge internal error，无法定位。日志与响应都不含 token。
                const reason = String((data && (data.error?.message || data.error_description || data.error)) || `HTTP ${upstream.status}`).slice(0, 300);
                throw new Error(`UPSTREAM_API_ERROR: ${reason}`);
            }
            return data;
        };

        const googlePost = async (accountId, upstreamUrl, payload) => {
            const access = await getAccessToken(accountId);
            let upstream;
            try {
                upstream = await fetch(upstreamUrl, {
                    method: 'POST',
                    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
                    body: JSON.stringify(payload ?? {}),
                });
            } catch {
                throw new Error('UPSTREAM_UNREACHABLE');
            }
            let data = {};
            try { data = await upstream.json(); } catch { data = {}; }
            if (!upstream.ok) {
                if (upstream.status === 401) {
                    accessCache.delete(accountId);
                    throw new Error('REAUTH_REQUIRED');
                }
                const err = new Error('UPSTREAM_API_ERROR');
                err.status = upstream.status;
                err.data = data;
                throw err;
            }
            return data;
        };

        const requireAccountId = () => {
            const accountId = String(req.headers['x-google-account'] || '');
            if (!accountId) {
                finish(400, { error: 'missing x-google-account' });
                return null;
            }
            return accountId;
        };

        try {
            if (path === '/api/accounts/exchange' && method === 'POST') {
                const body = await readJsonBody();
                if (!body.code) return finish(400, { error: 'missing code' });
                const params = new URLSearchParams({
                    code: String(body.code),
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code',
                });
                const { upstream, data } = await postTokenEndpoint(params);
                if (!upstream.ok) {
                    // Google 的错误体（invalid_grant / redirect_uri_mismatch / invalid_client…）
                    // 原样带回，日志只记 error 字段不含 code/token，前端才能给出可读原因。
                    const detail = (data && (data.error_description || data.error)) || `HTTP ${upstream.status}`;
                    return finish(502, { error: 'exchange failed', reason: String(detail).slice(0, 300) });
                }
                // 拿邮箱只为了设置页显示"已连接 xxx@gmail.com"。userinfo 端点要额外的
                // userinfo.email scope；拿不到不该让整个授权失败——退化成用 refresh token
                // 的哈希前 8 位当 accountId，账号仍能正常读日历与待办。
                let accountId = '';
                let email = '';
                try {
                    const userinfo = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                        headers: { authorization: `Bearer ${data.access_token}` },
                    });
                    if (userinfo.ok) {
                        const profile = await userinfo.json();
                        accountId = String(profile?.id || '');
                        email = String(profile?.email || '');
                    }
                } catch { /* 走下面的兜底 */ }
                if (!accountId) {
                    const { createHash } = await import('node:crypto');
                    accountId = createHash('sha256').update(String(data.refresh_token || '')).digest('hex').slice(0, 12);
                }
                await store.save({ accountId, email, refreshToken: data.refresh_token, scope: data.scope ?? '' });
                return finish(200, { accountId, email });
            }
            if (path === '/api/accounts' && method === 'GET') {
                return finish(200, await store.listAccounts());
            }
            const deleteMatch = path.match(/^\/api\/accounts\/([^/]+)$/);
            if (deleteMatch && method === 'DELETE') {
                await store.remove(decodeURIComponent(deleteMatch[1]));
                return finish(200, { ok: true });
            }
            if (path === '/api/calendars' && method === 'GET') {
                const accountId = requireAccountId();
                if (!accountId) return;
                const data = await googleGet(accountId, 'https://www.googleapis.com/calendar/v3/users/me/calendarList');
                return finish(200, { items: data.items ?? [] });
            }
            if (path === '/api/events' && method === 'GET') {
                const accountId = requireAccountId();
                if (!accountId) return;
                const calendarId = url.searchParams.get('calendarId') || '';
                if (!calendarId) return finish(400, { error: 'missing calendarId' });
                const qs = new URLSearchParams();
                const timeMin = url.searchParams.get('timeMin');
                const timeMax = url.searchParams.get('timeMax');
                if (timeMin) qs.set('timeMin', timeMin);
                if (timeMax) qs.set('timeMax', timeMax);
                // 统一按中国时区解释与呈现：Google 账号自身时区可能是 America/New_York，
                // 但用户在中国，统一用 Asia/Shanghai 归日与显示，免得每条都要手动换算。
                qs.set('timeZone', DISPLAY_TIME_ZONE);
                const upstreamUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${qs.toString() ? `?${qs}` : ''}`;
                const data = await googleGet(accountId, upstreamUrl);
                // calendarId 调用方已知，直接加盖，不依赖 Google payload。
                const items = Array.isArray(data.items) ? data.items.map((item) => ({ ...item, calendarId })) : [];
                return finish(200, { items });
            }
            if (path === '/api/tasks' && method === 'GET') {
                const accountId = requireAccountId();
                if (!accountId) return;
                const tasklist = url.searchParams.get('tasklist') || '@default';
                const data = await googleGet(accountId, `https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks`);
                return finish(200, { items: data.items ?? [] });
            }
            if (path === '/api/events' && method === 'POST') {
                const payload = await readJsonBody();
                // body 里的 accountId 仅作兜底:与 x-google-account 头不一致时以头为准。
                const accountId = String(req.headers['x-google-account'] || payload.accountId || '');
                if (!accountId) return finish(400, { error: 'missing x-google-account' });
                const calendarId = String(payload.calendarId || '');
                if (!calendarId) return finish(400, { error: 'missing calendarId' });
                const upstreamUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
                try {
                    // 写入时钉死中国时区：char 说「明天上午 9 点」就是北京时间 9 点，
                    // 不会因为 Google 账号时区是美东而存成别的时间。
                    const event = { ...(payload.event ?? {}) };
                    if (event.start?.dateTime && !event.start.timeZone) event.start = { ...event.start, timeZone: DISPLAY_TIME_ZONE };
                    if (event.end?.dateTime && !event.end.timeZone) event.end = { ...event.end, timeZone: DISPLAY_TIME_ZONE };
                    const data = await googlePost(accountId, upstreamUrl, event);
                    return finish(200, data);
                } catch (e) {
                    if (e?.message === 'UPSTREAM_API_ERROR' && Number.isInteger(e?.status)) return finish(e.status, e.data ?? {});
                    throw e;
                }
            }
            if (path === '/api/tasks' && method === 'POST') {
                const payload = await readJsonBody();
                const accountId = String(req.headers['x-google-account'] || payload.accountId || '');
                if (!accountId) return finish(400, { error: 'missing x-google-account' });
                const tasklist = String(payload.tasklist || '@default');
                const upstreamUrl = `https://tasks.googleapis.com/tasks/v1/lists/${tasklist}/tasks`;
                try {
                    const data = await googlePost(accountId, upstreamUrl, payload.task ?? {});
                    return finish(200, data);
                } catch (e) {
                    if (e?.message === 'UPSTREAM_API_ERROR' && Number.isInteger(e?.status)) return finish(e.status, e.data ?? {});
                    throw e;
                }
            }
            return finish(404, { error: 'unknown route' });
        } catch (e) {
            const msg = String(e?.message ?? e);
            if (msg === 'REAUTH_REQUIRED') return finish(401, { error: 'REAUTH_REQUIRED' });
            if (msg === 'STORE_DECRYPT_FAILED') return finish(500, { error: 'store decrypt failed' });
            if (msg === 'UPSTREAM_UNREACHABLE') return finish(502, { error: 'upstream unreachable' });
            console.error(`[google-bridge] ${method} ${path} error: ${sanitize(msg).slice(0, 200)}`);
            const isUpstreamApi = msg.startsWith('UPSTREAM_API_ERROR:');
            return finish(502, isUpstreamApi
                ? { error: 'upstream api error', reason: sanitize(msg.slice('UPSTREAM_API_ERROR:'.length)).slice(0, 300) }
                : { error: 'bridge internal error' });
        }
    });

    const ready = new Promise((resolve) => server.listen(port, host, resolve));
    const close = () => new Promise((resolve) => server.close(resolve));
    return {
        ready,
        close,
        get port() {
            const addr = server.address();
            return typeof addr === 'object' && addr ? addr.port : port;
        },
    };
}
