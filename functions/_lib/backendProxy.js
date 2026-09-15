/**
 * 同源后端中转（Cloudflare Pages Function 版）。
 *
 * 背景：某些网络直连后端 TLS 会被 RST，而托管域名本身可达。前端把后端绝对地址
 * 映射成同源 `/agent/*`、`/amsg/*`（见 utils/networkFailureDiagnosis.ts），
 * `functions/agent/[[path]].js` 与 `functions/amsg/[[path]].js` 两个路由把请求
 * 交给本模块转发，浏览器不直连后端。
 *
 * 后端地址来自 Pages 项目的环境变量 BACKEND_HOST（只填 host，如 backend.example.com，
 * 可带端口），绝不写进仓库——写进仓库等于把后端域名公开。
 *
 * 透明转发：method/headers/body 原样透传（流式，不断 SSE）；CORS 头由上游决定。
 * 这是 Vercel 版 api/backend-proxy.ts 的等价实现，两边保持同一行为。
 */

const NS_PREFIX = {
  agent: "/agent/",
  amsg: "/amsg/",
};

// hop-by-hop + 由运行时/边缘自己算的，透传时去掉
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-proto",
  "x-real-ip",
]);

// 上游响应里由运行时自己编码/计算的字段，不原样透传，避免双重压缩
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function resolveBackendHost(env) {
  const raw = String((env && env.BACKEND_HOST) || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!raw || !/^[a-z0-9.-]+(:\d+)?$/i.test(raw)) return null;
  return raw;
}

export async function backendProxy(context, ns) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const prefix = NS_PREFIX[ns];
  if (!prefix) {
    return jsonResponse(400, { error: "Unknown proxy namespace." });
  }

  const host = resolveBackendHost(env);
  if (!host) {
    return jsonResponse(500, {
      error: "Backend not configured. Set BACKEND_HOST env var on the Pages project (bare host, e.g. backend.example.com).",
    });
  }

  const url = new URL(request.url);
  const targetUrl = `https://${host}${url.pathname}${url.search}`;

  const fwdHeaders = new Headers();
  request.headers.forEach((value, key) => {
    if (!DROP_REQUEST_HEADERS.has(key.toLowerCase())) fwdHeaders.set(key, value);
  });

  const init = { method: request.method, headers: fwdHeaders, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (e) {
    return jsonResponse(502, { error: `Backend unreachable: ${(e && e.message) || e}` });
  }

  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
