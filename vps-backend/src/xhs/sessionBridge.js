// vps-backend/src/xhs/sessionBridge.js
// XHS 会话桥:token 鉴权 + 服务器内解密会话 + 转发中心 CF Worker。
// 红线:cookie 原值不进日志、不进响应;响应一律 no-store。
import http from 'node:http';
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

const sessionTagOf = async (cookieStr) => {
    const a1 = (cookieStr.match(/(?:^|;\s*)a1=([^;]+)/) || [])[1] || '';
    if (!a1) return '';
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(a1));
    return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
};

const sanitize = (text) => String(text ?? '')
    .replace(/a1=[^;\s"']+/g, 'a1=[REDACTED]')
    .replace(/web_session=[^;\s"']+/g, 'web_session=[REDACTED]');

const DEFAULT_CORS_HEADERS = 'Content-Type, X-Bridge-Token, X-Xhs-Platform, X-Rnote-API-Key';

export function startSessionBridge({ port, host = '127.0.0.1', token, store, upstream, collector = null }) {
    if (!token) throw new Error('XHS_BRIDGE_TOKEN is required');

    const server = http.createServer(async (req, res) => {
        const startedAt = Date.now();
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const method = (req.method || 'GET').toUpperCase();

        const finish = (status, body, extraHeaders = {}) => {
            const payload = body === null ? '' : JSON.stringify(body);
            res.writeHead(status, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                ...extraHeaders,
            });
            res.end(payload);
            console.log(`[xhs-bridge] ${method} ${path} -> ${status} (${Date.now() - startedAt}ms)`);
        };

        // CORS 预检:照抄 2026-09-11 契约(净化回显请求头/方法 + 204 + 鉴权前)。
        if (method === 'OPTIONS') {
            const origin = req.headers.origin || '*';
            const requestedHeaders = String(req.headers['access-control-request-headers'] || DEFAULT_CORS_HEADERS)
                .split(',').map((s) => s.trim()).filter((h) => /^[\w-]+$/.test(h));
            return finish(204, null, {
                'access-control-allow-origin': origin,
                'access-control-allow-methods': 'GET, POST, OPTIONS',
                'access-control-allow-headers': requestedHeaders.length ? requestedHeaders.join(', ') : DEFAULT_CORS_HEADERS,
                'access-control-max-age': '86400',
            });
        }

        if (path === '/api/health' && method === 'GET') {
            return finish(200, { status: 'ok', backend: 'xhs-session-bridge' });
        }

        // 鉴权:除 health 外全部要求 X-Bridge-Token 精确相等。
        const provided = String(req.headers['x-bridge-token'] || '');
        if (!provided || provided !== token) {
            return finish(401, { error: 'unauthorized' });
        }

        try {
            if (path === '/api/session/status' && method === 'GET') {
                return finish(200, { ...store.status(), bridge: 'up' });
            }
            if (path === '/api/session/refresh' && method === 'POST') {
                if (collector?.collect) {
                    try { await collector.collect(); } catch { console.warn('[xhs-bridge] refresh via collector failed'); }
                }
                return finish(200, { ...store.status(), bridge: 'up' });
            }
            if (path === '/api/session/invalidate' && method === 'POST') {
                store.wipe();
                return finish(200, { ok: true });
            }

            const command = path.match(/^\/api\/([a-z0-9-]+)$/)?.[1];
            if (!command) return finish(404, { error: 'unknown route' });

            const { cookieStr, version } = await store.get();
            const chunks = [];
            for await (const c of req) chunks.push(c);
            const bodyRaw = Buffer.concat(chunks).toString('utf8') || '{}';

            let upstreamResp;
            try {
                upstreamResp = await fetch(`${upstream}/api/${command}`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-xhs-cookie': cookieStr,
                        'x-xhs-platform': String(req.headers['x-xhs-platform'] || 'auto'),
                        ...(req.headers['x-rnote-api-key'] ? { 'x-rnote-api-key': String(req.headers['x-rnote-api-key']) } : {}),
                    },
                    body: bodyRaw,
                });
            } catch {
                return finish(502, { error: '上游不可达' });
            }

            let data = null;
            try { data = await upstreamResp.json(); } catch {
                data = { error: `HTTP ${upstreamResp.status}` };
            }
            if (data && typeof data === 'object' && typeof data.error === 'string') {
                data.error = sanitize(data.error);
            }
            const tag = await sessionTagOf(cookieStr);
            return finish(upstreamResp.status, { ...data, ...(tag ? { xhs_session_tag: tag } : {}), xhs_session_version: version });
        } catch (e) {
            const msg = String(e?.message ?? e);
            if (msg === 'STORE_EMPTY') return finish(503, { error: '会话未配置：请先在服务器浏览器完成登录' });
            if (msg === 'STORE_DECRYPT_FAILED') return finish(500, { error: '会话存储解密失败（密钥不匹配或密文损坏）' });
            console.error(`[xhs-bridge] ${method} ${path} error: ${sanitize(msg).slice(0, 120)}`);
            return finish(500, { error: 'bridge internal error' });
        }
    });

    const ready = new Promise((resolve) => server.listen(port, host, resolve));
    const close = () => new Promise((resolve) => server.close(resolve));
    return { server, ready, close };
}
