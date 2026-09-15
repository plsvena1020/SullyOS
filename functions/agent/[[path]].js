/**
 * 同源后端中转路由：/agent/*（Cloudflare Pages Function）。
 * 实现见 functions/_lib/backendProxy.js，与 Vercel 版 api/backend-proxy.ts 等价。
 */
import { backendProxy } from "../_lib/backendProxy.js";

export const onRequest = (context) => backendProxy(context, "agent");
