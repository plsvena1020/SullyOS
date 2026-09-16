# XHS VPS Session Bridge 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **执行者警告:** 本计划按「弱执行模型」标准编写,每步自带文件路径 + 行号锚点 + 完整代码 + 验收命令。**遇到行号偏差超过 ±5 行、代码形态明显不符、或本计划未覆盖的歧义时,立即停下询问用户,不要自行猜测。** 禁止计划之外的「顺手改进」,禁止 `git add -A`。

**Goal:** VPS 常驻 camofox 浏览器维护小红书登录态,cookie 加密留在 VPS;前端/amsg 零 cookie 调用 XHS Lite;失效时只需扫一次码。

**Architecture:** 中心 CF Worker(`/api/*`,唯一业务真源,零改动);VPS 上 camofox 经 storage_state 采集 cookie → AES-256-GCM 加密落盘 sessionStore → sessionBridge(127.0.0.1:8836,token 鉴权)解密注入 `X-Xhs-Cookie` 转发中心 Worker;前端新 `mode:'vps'` 带 `X-Bridge-Token` 走 Caddy `ethernet-vps.bot.cd/xhs-api/*`;amsg worker 同口径,tool_config 不再上传 cookie。

**Tech Stack:** React+TS 前端 / vitest / Node 22 原生服务(零依赖,node:crypto + 全局 fetch)/ camofox-browser 容器(Docker)/ systemd / Caddy

**Spec:** `docs/superpowers/specs/2026-09-15-xhs-vps-session-bridge-design.md`

---

## Global Constraints(每个任务默认遵守)

- **改码工作流**:仓库代码只在本机 `D:\sullyos` 修改;git 身份只有 plasma953(`plasma953@users.noreply.github.com`);push `origin/ethernet` 后 VPS `git pull` 才生效。VPS 上只允许改运行时文件(`/opt/sullyos/.env`、systemd unit、`/etc/caddy/Caddyfile`、数据目录)。
- **Cookie 红线**:cookie 原值不得出现在日志、HTTP 响应、URL、错误消息、前端 localStorage(vps 模式)、amsg tool_config、仓库文件。文档中 token 一律写 `<XHS_BRIDGE_TOKEN>` 占位。
- **写操作永不自动重试**(like/favorite/comment/reply/publish——重放可能重复评论、点赞翻转)。
- **命令统一** `corepack pnpm@9.15.9`(pnpm 不在 PATH;`.npmrc` 腾讯镜像常 502,装依赖加 `--registry=https://registry.npmjs.org/`)。
- **编码护栏**:含中文文件改完必跑 `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`;写文件只用 Write/Edit 工具;bash 命令参数避免中文;commit message 英文;绝不在工具参数里放 U+FFFD 字符本身。
- **提交节奏**:每任务一个 commit;提交前 `git diff --stat` 逐 hunk 确认归属(工作区几百个 CRLF 噪音文件,只 add 本任务动过的文件)。
- **tsc 判据**:触碰文件在 `corepack pnpm@9.15.9 tsc --noEmit` 输出里零新增命中(仓库存量约 45 个错误不算)。
- **UI 红线**:Settings 小红书卡片沿用既有 rose 配色/圆角/字号档(`bg-rose-50`/`border-rose-200`/`rounded-xl`/`text-[10px]` 等,见同卡既有写法);lite 模式现有交互与文案零变化;动 UI 前对照 `docs/design-system.md`。

## 锚点事实(执行者直接信任,不要重新考证)

**worker/index.js(中心 CF Worker,本方案零改动):**
- `/api/<command>` 路由 2471-2509;`health` 免鉴权;无 cookie→401;缺 a1→400。
- 登录失效文案(2364 行,一字不差): `这串 cookie 在 xiaohongshu.com 和 rednote.com 两套后端都没有通过登录校验。请从当前实际登录的网站重新复制完整请求 Cookie。`

**utils/xhsMcpClient.ts(1059 行):**
- 模块变量 `liteCookie`/`litePlatform`:41-42;`resolveLiteCookie`:47-54;`resolvePersistedLitePlatform`:56-64;`spiderCookieTag`:96-101;`trySpiderV3CommentPatch`:115-190(a1Tag 取用 131-132,fetch headers 149-156);`bridgePost` 原始实现:194-241(401 映射 217-219,error 判定 227-229,Spider 补丁 234-236);`XhsMcpClient` 对象:567 起;`resetSession` 569、`setCookie` 577-581、`testConnection` 584-627(health 10s 超时先例 593-594)、`checkLogin` 682、`search` 688、`getRecommend` 696、`getNoteDetail` 702、`publishNote` 725、`likeFeed` 771、`favoriteFeed` 778、`replyComment` 785(签名 `(serverUrl, feedId, xsecToken, content, commentId?, userId?, parentCommentId?)`)、`getUserProfile` 798、`login` 807、`getQrcode` 812、`logout` 817。**注意:没有 `postComment` 方法**,写命令测试用 `replyComment`。
- fetch mock 形态先例(`utils/xhsMcpClient.test.ts` 96-124):`vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { ... return new Response(JSON.stringify(...), { headers: { 'content-type': 'application/json' } }); })`。

**apps/Settings.tsx(4879 行):**
- `XHS_LITE_URL`:845;state 区 863-871(`rtXhsMode` 在 864,类型 `useState<'lite' | 'local'>`);保存块 `xhsMcpConfig` 1806-1815;`testXhsMcp` 1928-1979(url/cookie 行 1929-1930,cookie 必填校验 1935-1938,xhsUpdates 1958-1969);UI 卡片 4575-4618(toggle 4580-4582,面板条件 4588,cookie textarea 4592,测试按钮 4594,昵称/ID 4595-4604,教程折叠 4605-4613,说明 4614-4616)。

**types.ts:** `XhsMcpConfig` 接口 4616-4626(`mode` 在 4618,`userXsecToken` 在 4625)。

**utils/xhsMcpConfig.ts:** `resolveXhsDeploymentMode` 16-26;`utils/xhsMcpConfig.test.ts` 已存在。

**utils/realtimeContext.ts:** `defaultRealtimeConfig` 60-89,xhsMcpConfig 默认块 76-86。

**utils/backupSecrets.ts:** xhs 脱敏清单 47-51(`['cookie', 'rnoteApiKey', 'userXsecToken']`);`utils/backupSecrets.test.ts` 已存在。

**utils/amsgToolPack.ts:** `AmsgToolConfig.xhsMcpConfig` 74-82;`buildToolConfig` xhs 分支 210-222;`isWorkerReachableUrl` 115-131。

**worker/amsg/src/index.ts:** `import { XhsMcpClient }` 131;`FireStash` 345-384(`xhsCookie: string` 在 349);`buildToolCtx` 474-509(返回 `xhsCookie: config.xhsMcpConfig?.cookie ?? ''` 在 507);executeToolCalls cookie 注入 2432-2433(前方注释块 2422-2431)。

**utils/amsgBundleVersion.ts:** 当前 `'2026-09-13'`,amsg bundle 行为变化时必须更新并跑 `build:workers`,产物随 commit 提交。

**VPS 事实(2026-09-15 已核实):** Ubuntu 26.04,Node v22.23.2,Docker 已装,内存余 6.6G,磁盘余 35G,端口 8836/9377/6080 空闲,无浏览器无桌面;Caddy 线上 `/etc/caddy/Caddyfile` 已有 `ethernet-vps.bot.cd` 块(heartbeat 段在 8835 反代后追加新段);仓库 canonical 模板 `vps-backend/deploy/caddy/SullyOS.Caddyfile`(71 行,`${SULLYOS_DOMAIN}` 占位)——**两处都要加**;`/opt/xhs-mcp`(disabled 旧 Python MCP,`.env.cookie` 含明文 cookie)批次四删除;root 密码曾在对话中暴露,需提醒轮换。

**前端 URL 三层拼接(已走查,勿改):** `detectMode`(35 行 `includes('/api')`)对 vps URL `https://ethernet-vps.bot.cd/xhs-api/api` 命中 bridge;`bridgePost` 里 `.replace(/\/+$/, '').replace(/\/api$/, '')` 把它剥成 `https://ethernet-vps.bot.cd/xhs-api`,再拼 `${base}/api/${cmd}` = `/xhs-api/api/...`;Caddy `handle_path /xhs-api*` 剥前缀 → bridge 收到 `/api/...`。health 探测(`${base}/api/health`)同理 → `/xhs-api/api/health` → bridge `/api/health`。✓

---

# 批次一:前端 Cookie 生命周期修复(纯本地)

## 任务 1:会话状态与错误分类纯函数

**Files:**
- Create: `utils/xhsSession.ts`
- Create: `utils/xhsSession.test.ts`

**Interfaces(Produces):** `classifyXhsBridgeFailure` / `RETRYABLE_COMMANDS` / `isSessionExpiry` / `assertNoCookieLeak`,签名见实现。

- [ ] **Step 1:写测试 `utils/xhsSession.test.ts`**

```ts
// utils/xhsSession.test.ts
import { describe, it, expect } from 'vitest';
import {
    classifyXhsBridgeFailure, RETRYABLE_COMMANDS, isSessionExpiry, assertNoCookieLeak,
} from './xhsSession';

const EXPIRY_TEXT = '这串 cookie 在 xiaohongshu.com 和 rednote.com 两套后端都没有通过登录校验。请从当前实际登录的网站重新复制完整请求 Cookie。';

describe('classifyXhsBridgeFailure', () => {
    it('maps 401 to NO_SESSION', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 401 })).toBe('NO_SESSION');
    });
    it('maps 429 to RATE_LIMITED', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 429 })).toBe('RATE_LIMITED');
    });
    it('maps 406/461/471 to UPSTREAM_REJECTED (protected endpoints are not expiry)', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 406 })).toBe('UPSTREAM_REJECTED');
        expect(classifyXhsBridgeFailure({ httpStatus: 461 })).toBe('UPSTREAM_REJECTED');
        expect(classifyXhsBridgeFailure({ httpStatus: 471 })).toBe('UPSTREAM_REJECTED');
    });
    it('maps the worker login-rejection text to SESSION_EXPIRED', () => {
        expect(classifyXhsBridgeFailure({ errorText: EXPIRY_TEXT })).toBe('SESSION_EXPIRED');
    });
    it('maps check-login logged_in:false to SESSION_EXPIRED', () => {
        expect(classifyXhsBridgeFailure({ endpoint: 'check-login', body: { logged_in: false } })).toBe('SESSION_EXPIRED');
    });
    it('maps timeout to NETWORK_FAILURE', () => {
        expect(classifyXhsBridgeFailure({ errorText: 'XHS_REQUEST_TIMEOUT' })).toBe('NETWORK_FAILURE');
    });
    it('maps unknown shapes to UNKNOWN', () => {
        expect(classifyXhsBridgeFailure({ httpStatus: 500, errorText: 'boom' })).toBe('UNKNOWN');
    });
});

describe('RETRYABLE_COMMANDS', () => {
    it('contains read-only commands only', () => {
        expect(RETRYABLE_COMMANDS.has('search')).toBe(true);
        expect(RETRYABLE_COMMANDS.has('check-login')).toBe(true);
        expect(RETRYABLE_COMMANDS.has('get-feed-detail')).toBe(true);
        expect(RETRYABLE_COMMANDS.has('reply-comment')).toBe(false);
        expect(RETRYABLE_COMMANDS.has('like-feed')).toBe(false);
        expect(RETRYABLE_COMMANDS.has('publish')).toBe(false);
    });
});

describe('isSessionExpiry and assertNoCookieLeak', () => {
    it('isSessionExpiry only true for SESSION_EXPIRED', () => {
        expect(isSessionExpiry('SESSION_EXPIRED')).toBe(true);
        expect(isSessionExpiry('NO_SESSION')).toBe(false);
    });
    it('descriptor without cookie passes the leak check', () => {
        expect(() => assertNoCookieLeak({ nickname: 'x', platform: 'xhs' })).not.toThrow();
    });
    it('cookie key or a1=/web_session= values trip the leak check', () => {
        expect(() => assertNoCookieLeak({ cookie: 'a1=abc' })).toThrow('SESSION_DESCRIPTOR_LEAK');
        expect(() => assertNoCookieLeak({ note: 'a1=secret; web_session=zzz' })).toThrow('SESSION_DESCRIPTOR_LEAK');
    });
});
```

- [ ] **Step 2:确认失败**

```bash
corepack pnpm@9.15.9 vitest run utils/xhsSession.test.ts
```
Expected: FAIL(模块不存在)。

- [ ] **Step 3:写实现 `utils/xhsSession.ts`**

```ts
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
```

- [ ] **Step 4:确认通过**

```bash
corepack pnpm@9.15.9 vitest run utils/xhsSession.test.ts
```
Expected: 全 PASS。

- [ ] **Step 5:Commit**

```bash
git add utils/xhsSession.ts utils/xhsSession.test.ts
git commit -m "feat(xhs): session status model and failure classification"
```

---

## 任务 2:cookie 单一真源 + 请求超时 + 单飞刷新重试

**Files:**
- Modify: `utils/xhsMcpClient.ts`(锚点 41-42、115-190、194-241、577-581)
- Modify: `utils/xhsMcpClient.test.ts`

**Interfaces:**
- Consumes: 任务 1 的 `classifyXhsBridgeFailure`、`RETRYABLE_COMMANDS`、`isSessionExpiry`
- Produces: `XhsMcpClient.setBridgeToken(token?: string)`(模块级 `liteBridgeToken`);bridgePost 行为(20s 超时、X-Bridge-Token 头、只读命令失效后单飞 check-login 确认再重试一次);`trySpiderV3CommentPatch` 支持 bridge 会话标签

- [ ] **Step 1:import 追加(xhsMcpClient.ts 顶部,`./networkFailureDiagnosis` import 之后)**

```ts
import { classifyXhsBridgeFailure, RETRYABLE_COMMANDS, isSessionExpiry } from './xhsSession';
```

- [ ] **Step 2:模块变量(42 行 `let litePlatform...` 后追加)**

```ts
// vps-bridge 模式鉴权头(服务器托管会话);手工 lite 模式恒为空。
let liteBridgeToken = '';
// vps 模式下 bridge 在响应里带的不透明会话标签(sha256(a1) 前 16 位),Spider v3 断路器键。
let lastSessionTag = '';
// 单飞的「重验登录」:多个请求同时发现失效时只发一次 check-login,等待者共享同一 Promise。
let inflightLoginCheck: Promise<boolean> | null = null;
```

- [ ] **Step 3:整函数替换 bridgePost(194-241)——拆成 rawBridgePost(无重试内核)+ bridgePost(重试外壳)**

整段删除原 194-241(`const bridgePost = async (...)` 到它的 `};`),替换为:

```ts
/** bridgePost 的无重试内核(单飞刷新与主路径共用,防止刷新自身触发嵌套重试)。 */
const rawBridgePost = async (
    serverUrl: string,
    endpoint: string,
    body: Record<string, any> = {},
): Promise<McpToolResult> => {
    const baseUrl = serverUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    const url = `${baseUrl}/api/${endpoint}`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const ck = resolveLiteCookie();
    if (ck) headers['x-xhs-cookie'] = ck;
    if (liteBridgeToken) headers['x-bridge-token'] = liteBridgeToken;
    const requestPlatform = endpoint === 'check-login'
        ? litePlatform
        : (litePlatform === 'auto' ? resolvePersistedLitePlatform() : litePlatform);
    if (requestPlatform !== 'auto') headers['x-xhs-platform'] = requestPlatform;

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
                ? AbortSignal.timeout(20_000)
                : undefined,
        });

        if (resp.status === 401) {
            return { success: false, error: '未登录，请先登录小红书' };
        }

        if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            return { success: false, error: (errData as any).error || `HTTP ${resp.status}` };
        }

        let data = await resp.json();
        if (data?.xhs_session_tag) lastSessionTag = String(data.xhs_session_tag);
        if (data.error) {
            return { success: false, error: data.error };
        }
        const detectedPlatform = data?.platform || data?.data?.platform;
        if (detectedPlatform === 'xhs' || detectedPlatform === 'rednote') {
            litePlatform = detectedPlatform;
        }
        if (endpoint === 'get-feed-detail' && ck) {
            data = await trySpiderV3CommentPatch(baseUrl, body, ck, data);
        }
        return { success: true, data };
    } catch (e: any) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            return { success: false, error: '请求超时，请检查网络后重试' };
        }
        return { success: false, error: e?.message };
    }
};

/** 单飞 check-login:确认当前 cookie/token 是否真的失效(手工 lite 模式的「假失效」防护)。 */
const refreshSessionProbe = async (serverUrl: string): Promise<boolean> => {
    if (inflightLoginCheck) return inflightLoginCheck;
    inflightLoginCheck = (async () => {
        try {
            const probe = await rawBridgePost(serverUrl, 'check-login');
            return !!(probe.success && (probe.data as any)?.logged_in);
        } catch {
            return false;
        }
    })();
    try { return await inflightLoginCheck; } finally { inflightLoginCheck = null; }
};

const bridgePost = async (
    serverUrl: string,
    endpoint: string,
    body: Record<string, any> = {},
): Promise<McpToolResult> => {
    const first = await rawBridgePost(serverUrl, endpoint, body);
    if (first.success) return first;

    // 会话失效分类:只有明确过期 + 只读命令才走刷新重试;写命令永不重试。
    const failureCode = classifyXhsBridgeFailure({ errorText: first.error, endpoint });
    if (!isSessionExpiry(failureCode) || !RETRYABLE_COMMANDS.has(endpoint)) return first;
    if (endpoint === 'check-login') return first; // 探针命令直接透传,避免自旋

    const ck = resolveLiteCookie();
    if (!ck && !liteBridgeToken) return first;
    if (ck) {
        // 手工 lite 模式:先确认 cookie 真失效了(网络抖动也可能产出类似文案)。
        const stillValid = await refreshSessionProbe(serverUrl);
        if (!stillValid) return first;
    }
    // vps-bridge 模式:bridge 自动使用服务器最新会话,直接重试一次。
    return rawBridgePost(serverUrl, endpoint, body);
};
```

- [ ] **Step 4:Spider v3 断路器键双源(131-132 与 149-156)**

131-132 行原文:
```ts
    const a1Tag = await spiderCookieTag(cookie);
    if (!a1Tag) return detail;
```
替换为:
```ts
    // vps 模式下客户端没有 cookie,a1Tag 回退到 bridge 下发的会话标签(同为 a1 哈希口径)。
    const a1Tag = (await spiderCookieTag(cookie)) || lastSessionTag;
    if (!a1Tag) return detail;
```
149-156 行 fetch headers 对象(`'x-xhs-experiment-ack': ...` 行后)追加:
```ts
                ...(liteBridgeToken ? { 'x-bridge-token': liteBridgeToken } : {}),
```

- [ ] **Step 5:setBridgeToken(581 行 setCookie 的 `},` 后追加)**

```ts
    // vps-bridge 模式鉴权:bridge 对除 health 外的端点校验 X-Bridge-Token。
    setBridgeToken: (token?: string) => {
        liteBridgeToken = (token || '').trim();
    },
```

- [ ] **Step 6:测试追加到 `utils/xhsMcpClient.test.ts`(文件尾部,mock 形态照抄 96-124 先例)**

```ts
describe('bridgePost timeout / refresh single-flight (session hardening)', () => {
    const EXPIRY_ERROR = '这串 cookie 在 xiaohongshu.com 和 rednote.com 两套后端都没有通过登录校验。请从当前实际登录的网站重新复制完整请求 Cookie。';

    afterEach(() => {
        XhsMcpClient.setCookie('');
        XhsMcpClient.setBridgeToken('');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('confirms expiry once then retries a read command exactly once', async () => {
        XhsMcpClient.setCookie(`a1=${'a'.repeat(52)}; web_session=stale`);
        const fetchSpy = vi.fn(async (input: any) => {
            const url = String(input);
            if (url.endsWith('/api/check-login')) {
                return new Response(JSON.stringify({ logged_in: true, user_id: 'u1' }), { headers: { 'content-type': 'application/json' } });
            }
            const searchCalls = fetchSpy.mock.calls.filter((c: any) => String(c[0]).endsWith('/api/search')).length;
            if (url.endsWith('/api/search') && searchCalls === 1) {
                return new Response(JSON.stringify({ error: EXPIRY_ERROR }), { headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ success: true, feeds: [] }), { headers: { 'content-type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const result = await XhsMcpClient.search('https://worker.test/api', 'cat');
        expect(result.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(3); // search 失败 + check-login 确认 + search 重试
    });

    it('NEVER retries write commands after expiry', async () => {
        XhsMcpClient.setCookie(`a1=${'a'.repeat(52)}; web_session=stale`);
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: EXPIRY_ERROR }), { headers: { 'content-type': 'application/json' } }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await XhsMcpClient.replyComment('https://worker.test/api', 'feed1', 'tok', 'hi');
        expect(result.success).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps timeout to a friendly error instead of hanging', async () => {
        XhsMcpClient.setCookie(`a1=${'a'.repeat(52)}; web_session=stale`);
        vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
            Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
        const result = await XhsMcpClient.search('https://worker.test/api', 'cat');
        expect(result.success).toBe(false);
        expect(result.error).toContain('请求超时');
    });

    it('sends X-Bridge-Token and captures xhs_session_tag (vps mode)', async () => {
        XhsMcpClient.setBridgeToken('bridge-tok');
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init?: any) => {
            expect(new Headers(init?.headers).get('x-bridge-token')).toBe('bridge-tok');
            return new Response(JSON.stringify({ logged_in: true, xhs_session_tag: 'deadbeefdeadbeef' }), { headers: { 'content-type': 'application/json' } });
        });
        const result = await XhsMcpClient.checkLogin('https://bridge.test/api');
        expect(result.success).toBe(true);
    });

    it('vps mode retries read commands once without a local cookie', async () => {
        XhsMcpClient.setBridgeToken('bridge-tok');
        const fetchSpy = vi.fn(async (input: any) => {
            const url = String(input);
            const searchCalls = fetchSpy.mock.calls.filter((c: any) => String(c[0]).endsWith('/api/search')).length;
            if (url.endsWith('/api/search') && searchCalls === 1) {
                return new Response(JSON.stringify({ error: EXPIRY_ERROR }), { headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ success: true, feeds: [] }), { headers: { 'content-type': 'application/json' } });
        });
        vi.stubGlobal('fetch', fetchSpy);
        const result = await XhsMcpClient.search('https://bridge.test/api', 'cat');
        expect(result.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2); // search 失败 + search 重试(无 check-login)
    });
});
```

- [ ] **Step 7:跑测试**

```bash
corepack pnpm@9.15.9 vitest run utils/xhsMcpClient.test.ts utils/xhsMcpClient.concurrency.test.ts
```
Expected: 全 PASS,存量用例零回归(特别关注 `XHS Lite platform affinity`:check-login 成功响应不含 error 字段,不会进重试路径)。

- [ ] **Step 8:tsc + mojibake**

```bash
corepack pnpm@9.15.9 tsc --noEmit
corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts
```
Expected: 触碰文件零新增 tsc 命中;mojibake 绿。

- [ ] **Step 9:Commit**

```bash
git add utils/xhsMcpClient.ts utils/xhsMcpClient.test.ts
git commit -m "fix(xhs): request timeout, single-flight relogin probe, bridge token transport"
```

---

## 任务 3:类型与配置扩展 mode:'vps' + bridgeToken

**Files:**
- Modify: `types.ts`(4616-4626)
- Modify: `utils/xhsMcpConfig.ts`
- Modify: `utils/backupSecrets.ts`(47-51)
- Modify: `utils/backupSecrets.test.ts`
- Modify: `utils/xhsMcpConfig.test.ts`

**Interfaces(Produces):** `XhsMcpConfig.mode: 'local' | 'lite' | 'vps'`、`XhsMcpConfig.bridgeToken?: string`

- [ ] **Step 1:types.ts 两处**

4618 行原文:
```ts
    mode?: 'local' | 'lite'; // 部署模式；不要再用 /api 路径推断（本地 Skills 与 Lite 都使用 /api）
```
替换为:
```ts
    mode?: 'local' | 'lite' | 'vps'; // 部署模式；不要再用 /api 路径推断（本地 Skills 与 Lite 都使用 /api）
```
4625 行 `userXsecToken?: string;` 后追加:
```ts
    bridgeToken?: string;  // vps 模式：VPS session bridge 鉴权 token（随机值而非 cookie；随 tool_config 加密上云）
```

- [ ] **Step 2:xhsMcpConfig.ts 两处**

第 3 行原文 `export type XhsDeploymentMode = 'local' | 'lite';` 替换为:
```ts
export type XhsDeploymentMode = 'local' | 'lite' | 'vps';
```
第 20 行原文 `if (config?.mode === 'local' || config?.mode === 'lite') return config.mode;` 替换为:
```ts
    if (config?.mode === 'local' || config?.mode === 'lite' || config?.mode === 'vps') return config.mode;
```
(第 24 行 `if (config?.cookie?.trim()) return 'lite';` 旧配置迁移逻辑不动。)

- [ ] **Step 3:backupSecrets.ts**

47-51 行原文:
```ts
  const xhs = cfg.xhsMcpConfig;
  if (xhs && typeof xhs === 'object') {
    for (const f of ['cookie', 'rnoteApiKey', 'userXsecToken']) blankField(hit, xhs, f);
  }
```
替换为:
```ts
  const xhs = cfg.xhsMcpConfig;
  if (xhs && typeof xhs === 'object') {
    for (const f of ['cookie', 'rnoteApiKey', 'userXsecToken', 'bridgeToken']) blankField(hit, xhs, f);
  }
```

- [ ] **Step 4:测试追加**

`utils/backupSecrets.test.ts` 追加(风格以该文件既有用例为准微调):
```ts
it('redacts the xhs bridge token', () => {
    const data = { realtimeConfig: { xhsMcpConfig: { bridgeToken: 'bridge-tok', cookie: '', rnoteApiKey: '', userXsecToken: '' } } };
    expect(stripBackupSecrets(JSON.parse(JSON.stringify(data)))).toBe(true);
    expect((data.realtimeConfig.xhsMcpConfig as any).bridgeToken).toBe('');
});
```
`utils/xhsMcpConfig.test.ts` 追加(以既有用例风格微调):
```ts
it('returns the explicit vps mode', () => {
    expect(resolveXhsDeploymentMode({ mode: 'vps', serverUrl: 'https://ethernet-vps.bot.cd/xhs-api/api' }, 'https://default/api')).toBe('vps');
});
```

- [ ] **Step 5:跑测试 + tsc**

```bash
corepack pnpm@9.15.9 vitest run utils/backupSecrets.test.ts utils/xhsMcpConfig.test.ts
corepack pnpm@9.15.9 tsc --noEmit
```
Expected: 全 PASS + 触碰文件零新增 tsc 命中。

- [ ] **Step 6:Commit**

```bash
git add types.ts utils/xhsMcpConfig.ts utils/backupSecrets.ts utils/backupSecrets.test.ts utils/xhsMcpConfig.test.ts
git commit -m "feat(xhs): add vps deployment mode and bridgeToken config field"
```

---

## 任务 4:Settings 三态模式(vps UI 骨架)

**Files:**
- Modify: `apps/Settings.tsx`(锚点 845、863-871、1806-1815、1928-1979、4575-4618)

**Interfaces:**
- Consumes: 任务 3 三态 mode;`XhsMcpClient.setBridgeToken`
- Produces: `XHS_VPS_URL` 常量、vps 模式的保存/测试连接/UI 骨架

**规则:lite 模式现有交互与文案零变化;local 模式 UI 不动(本卡片区只覆盖 lite,local 另有入口)。改动全部是「追加分支/行级替换」而非重构。**

- [ ] **Step 1:常量(845 行 XHS_LITE_URL 定义后追加)**

```ts
  // vps 托管会话:VPS session bridge 经 Caddy 暴露的公网入口(见 docs/xhs-vps-session.md)。
  const XHS_VPS_URL = 'https://ethernet-vps.bot.cd/xhs-api/api';
```

- [ ] **Step 2:state 区两处**

864 行原文:
```ts
  const [rtXhsMode, setRtXhsMode] = useState<'lite' | 'local'>(_xhsIsLocal ? 'local' : 'lite');
```
替换为:
```ts
  const [rtXhsMode, setRtXhsMode] = useState<'lite' | 'local' | 'vps'>(_xhsStoredMode === 'local' ? 'local' : (_xhsStoredMode === 'vps' ? 'vps' : 'lite'));
```
868 行 `const [rtXhsCookie, ...]` 行后追加:
```ts
  const [rtXhsBridgeToken, setRtXhsBridgeToken] = useState(realtimeConfig.xhsMcpConfig?.bridgeToken || '');
```

- [ ] **Step 3:保存块(1806-1815)行级替换,只动三行、插入一行,其余原样**

```
serverUrl: rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl,
```
→
```ts
              serverUrl: rtXhsMode === 'lite' ? XHS_LITE_URL : (rtXhsMode === 'vps' ? XHS_VPS_URL : rtXhsLocalUrl),
```
`cookie:` 行后插入一行:
```ts
              bridgeToken: rtXhsMode === 'vps' ? (rtXhsBridgeToken.trim() || undefined) : undefined,
```
```
platform: rtXhsMode === 'lite' ? rtXhsPlatform : undefined,
```
→
```ts
              platform: rtXhsMode === 'local' ? undefined : rtXhsPlatform,
```
(loggedInNickname / loggedInUserId / userXsecToken 行原样保留。)

- [ ] **Step 4:testXhsMcp(1928-1979)三处**

1929 行原文:
```ts
      const urlToUse = rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl;
```
替换为:
```ts
      const urlToUse = rtXhsMode === 'lite' ? XHS_LITE_URL : (rtXhsMode === 'vps' ? XHS_VPS_URL : rtXhsLocalUrl);
```
1939 行 `setRtTestStatus('正在连接...');` 后追加:
```ts
      if (rtXhsMode === 'vps') XhsMcpClient.setBridgeToken(rtXhsBridgeToken.trim());
```
xhsUpdates 块(1958-1969)的 `cookie: cookieToUse,` 行后追加:
```ts
                      bridgeToken: rtXhsMode === 'vps' ? (rtXhsBridgeToken.trim() || undefined) : undefined,
```
(1930 与 1935-1938 的 cookie 逻辑本来就只对 lite 生效,不动。)

- [ ] **Step 5:UI 块(4575-4618)**

4580 行 toggle 的 `checked={rtXhsMcpEnabled && rtXhsMode === 'lite'}` 改为 `checked={rtXhsMcpEnabled && rtXhsMode !== 'local'}`;同一行 onChange 里 `setRtXhsMode('lite')` 改为 `setRtXhsMode(m => (m === 'local' ? 'lite' : m))`。

4588 行面板条件:
```tsx
                    {rtXhsMcpEnabled && rtXhsMode === 'lite' && (
```
改为:
```tsx
                    {rtXhsMcpEnabled && rtXhsMode !== 'local' && (
```
面板内(4589 行 `<div className="space-y-2">` 之后、cookie 框之前)插入模式切换:
```tsx
                            <div className="flex gap-1">
                                <button type="button" onClick={() => setRtXhsMode('lite')} className={`flex-1 py-1.5 text-[11px] font-bold rounded-xl transition-colors ${rtXhsMode === 'lite' ? 'bg-rose-500 text-white' : 'bg-rose-50 text-rose-500'}`}>云端 Lite</button>
                                <button type="button" onClick={() => setRtXhsMode('vps')} className={`flex-1 py-1.5 text-[11px] font-bold rounded-xl transition-colors ${rtXhsMode === 'vps' ? 'bg-rose-500 text-white' : 'bg-rose-50 text-rose-500'}`}>VPS 托管</button>
                            </div>
```
cookie 框区(4590-4593 `小红书 Cookie` label+textarea 的 div,与 4605-4613 教程折叠 div)分别外包 `{rtXhsMode === 'lite' && (`...`)}`;新增 vps 分支:
```tsx
                            {rtXhsMode === 'vps' && (
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Bridge Token</label>
                                    <input type="password" value={rtXhsBridgeToken} onChange={e => setRtXhsBridgeToken(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="XHS_BRIDGE_TOKEN（见 docs/xhs-vps-session.md）" />
                                </div>
                            )}
```
(「测试连接」按钮 4594 与昵称/ID grid 4595-4604 两模式共用,保持原位;4614-4616 说明 `<p>` 末尾以 JSX 条件追加:`{rtXhsMode === 'vps' && 'VPS 模式：登录态由服务器浏览器维护，失效时去服务器扫码即可，无需复制 cookie。'}`)

- [ ] **Step 6:验证**

```bash
corepack pnpm@9.15.9 tsc --noEmit
corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts
corepack pnpm@9.15.9 vitest run utils/xhsMcpClient.test.ts utils/backupSecrets.test.ts
```
Expected: 触碰文件零新增 tsc 命中;mojibake 绿;相关测试零回归。

- [ ] **Step 7:Commit**

```bash
git add apps/Settings.tsx
git commit -m "feat(settings): xhs vps-bridge session mode skeleton"
```

---

# 批次二:VPS 浏览器与 Session Bridge(先过可行性门)

## 任务 5:camofox 落地 + 24h 可行性试验(止损门)

**不碰仓库。全部在 VPS 执行。**

- [ ] **Step 1:目录 + 拉取 camofox(钉版本)**

```bash
mkdir -p /var/lib/sullyos-xhs/camofox/profiles /var/lib/sullyos-xhs/camofox/cookies /var/lib/sullyos-xhs/session
chmod 700 /var/lib/sullyos-xhs
git clone https://github.com/jo-inc/camofox-browser /opt/camofox-browser
cd /opt/camofox-browser && git rev-parse HEAD   # 记录此 hash(写进 docs/xhs-vps-session.md,钉版本)
```

- [ ] **Step 2:密钥进 .env(不与既有键复用)**

```bash
XHS_BRIDGE_TOKEN=$(openssl rand -hex 24); XHS_SESSION_KEY=$(openssl rand -hex 32)
printf 'XHS_BRIDGE_TOKEN=%s\nXHS_SESSION_KEY=%s\n' "$XHS_BRIDGE_TOKEN" "$XHS_SESSION_KEY" >> /opt/sullyos/.env
CAMOFOX_API_KEY=$(openssl rand -hex 24); XHS_CAMOFOX_VNC_PASSWORD=$(openssl rand -hex 8)
printf 'CAMOFOX_API_KEY=%s\nXHS_CAMOFOX_VNC_PASSWORD=%s\n' "$CAMOFOX_API_KEY" "$XHS_CAMOFOX_VNC_PASSWORD" >> /opt/sullyos/.env
chmod 600 /opt/sullyos/.env
```
把 XHS_BRIDGE_TOKEN 与 XHS_CAMOFOX_VNC_PASSWORD 的值回传给用户(Settings 用 token、扫码时用 VNC 密码);不进仓库。

- [ ] **Step 3:构建镜像(用 Dockerfile.ci,自包含下载,无需 make/dist)**

```bash
cd /opt/camofox-browser
docker build -f Dockerfile.ci \
  --build-arg CAMOUFOX_VERSION=152.0.4 --build-arg CAMOUFOX_RELEASE=beta.28 \
  -t camofox-browser:152.0.4-beta.28 .
```
(Dockerfile.ci 内含 xvfb、x11vnc、novnc、websockify 等插件依赖;`NODE_ENV=production`,storage_state 端点必须带 Bearer key。)

- [ ] **Step 4:启动容器(关键配置全量,缺一不可)**

```bash
docker run -d --restart unless-stopped --name camofox-browser --shm-size=2g \
  -p 127.0.0.1:9377:9377 -p 127.0.0.1:6080:6080 \
  -e CAMOFOX_API_KEY=$CAMOFOX_API_KEY \
  -e ENABLE_VNC=1 -e VNC_PASSWORD=$XHS_CAMOFOX_VNC_PASSWORD -e NOVNC_PORT=6080 \
  -e CAMOFOX_CRASH_REPORT_ENABLED=false \
  -e SESSION_TIMEOUT_MS=0 -e BROWSER_IDLE_TIMEOUT_MS=0 -e TAB_INACTIVITY_MS=0 \
  -e CAMOFOX_PROFILE_DIR=/data/profiles -e CAMOFOX_COOKIES_DIR=/data/cookies \
  -v /var/lib/sullyos-xhs/camofox/profiles:/data/profiles \
  -v /var/lib/sullyos-xhs/camofox/cookies:/data/cookies \
  camofox-browser:152.0.4-beta.28
```
三个 timeout 必须为 0(默认 5-10 分钟会杀浏览器/标签页,采集器将拿到 404);遥测必须关。
Step 2 与 Step 4 必须在同一 shell 会话执行(或从 /opt/sullyos/.env 重读变量)。

- [ ] **Step 5:建登录会话 + 扫码(用户操作)**

```bash
curl -s http://127.0.0.1:9377/health
curl -s -X POST http://127.0.0.1:9377/tabs -H 'content-type: application/json' \
  -d '{"userId":"sullyos-xhs","sessionKey":"main","url":"https://www.xiaohongshu.com"}'
```
本机(用户操作):`ssh -L 6080:127.0.0.1:6080 root@156.238.248.237`,浏览器打开 `http://localhost:6080/vnc.html`,输入 XHS_CAMOFOX_VNC_PASSWORD,画面里点「登录」→「扫码登录」,手机小红书 App 扫码确认(用测试账号)。
此步同时验证关键兼容性:小红书登录页在 Camoufox(Firefox)下能否正常扫码。

- [ ] **Step 6:导出验证 + 生产路径验证**

用 Write 工具在本机临时目录创建 `xhs-trial-check.mjs`(内容如下),用 vps upload 上传到 `/tmp/xhs-trial-check.mjs`,VPS 执行 `node /tmp/xhs-trial-check.mjs`:

```js
// /tmp/xhs-trial-check.mjs — 试验期临时脚本(任务收尾删除)
// storage_state → 拼 cookie → 中心 CF Worker check-login(真实生产路径验证)
import { readFileSync } from 'node:fs';

for (const line of readFileSync('/opt/sullyos/.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const CAMOFOX = 'http://127.0.0.1:9377';
const USER_ID = 'sullyos-xhs';

async function createSession() {
    const resp = await fetch(`${CAMOFOX}/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, sessionKey: 'main', url: 'https://www.xiaohongshu.com' }),
    });
    if (!resp.ok) throw new Error(`create tab http ${resp.status}`);
    await new Promise((r) => setTimeout(r, 3000));
}
async function exportState() {
    const resp = await fetch(`${CAMOFOX}/sessions/${USER_ID}/storage_state`, {
        headers: { authorization: `Bearer ${process.env.CAMOFOX_API_KEY}` },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`storage_state http ${resp.status}`);
    return resp.json();
}

let state = await exportState();
if (!state) { await createSession(); state = await exportState(); }
if (!state) throw new Error('no storage state after session create');

const cookies = state.cookies || [];
const has = (n) => cookies.some((c) => c.name === n);
console.log('cookies:', cookies.length, '| a1:', has('a1'), '| web_session:', has('web_session'));
if (!has('a1') || !has('web_session')) { console.log('VERDICT: NOT_LOGGED_IN'); process.exit(1); }

const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
const resp = await fetch('https://sully-proxy.plasmavendorlia.workers.dev/api/check-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xhs-cookie': cookieHeader },
    body: '{}',
});
const data = await resp.json();
console.log('worker check-login → logged_in:', data.logged_in, '| nickname:', data.nickname || '', '| platform:', data.platform || '');
console.log(data.logged_in ? 'VERDICT: OK' : 'VERDICT: FAILED');
process.exit(data.logged_in ? 0 : 1);
```
(脚本只打印布尔与计数,不打印任何 cookie 片段。)

- [ ] **Step 7:24h 三检 + 重启存活(第 1/8/24 小时)**

每检运行 `node /tmp/xhs-trial-check.mjs`,全部期望 `VERDICT: OK`(含 nickname)。附加一次:`docker restart camofox-browser` → 等 15 秒 → 重跑脚本仍 OK(验证「容器重启不需要重新登录」,采集器会自动重建会话并恢复 storageState)。

- [ ] **Step 8:止损线**

任一时点:`VERDICT: FAILED` / 持续验证码 / 扫码页在 Firefox 下无法使用 → **停止整个批次二**,回报用户,回落 Chrome 方案(本计划 Task 5/8/9 的 Chrome 版,见 git 历史)。

---

## 任务 6:sessionStore(加密存储 + 版本单调)

**Files:**
- Create: `vps-backend/src/xhs/sessionStore.js`
- Create: `vps-backend/src/xhs/sessionStore.test.ts`

**Interfaces(Produces):**
```js
createSessionStore({ sessionKeyHex, filePath })  // → { save, get, status, wipe }
// save(playwrightCookies: Array<{name, value, domain}>) → {version, skipped?}   域过滤+必备校验+版本单调+原子写
// get() → { cookieStr, version, updatedAt }                              解密;密钥错/密文坏 → throw
// status() → { configured, version, updatedAt, cookieNames, hasRequired } 不含 cookieStr
// wipe() → void                                                          删文件清内存
```

- [ ] **Step 1:写测试 `vps-backend/src/xhs/sessionStore.test.ts`(先红)**

```ts
// vps-backend/src/xhs/sessionStore.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionStore } from './sessionStore.js';

const KEY = '0'.repeat(64); // 32 bytes hex
const mkCookies = (a1 = 'a'.repeat(52), session = 'sess-1') => [
    { name: 'a1', value: a1, domain: '.xiaohongshu.com' },
    { name: 'web_session', value: session, domain: '.xiaohongshu.com' },
    { name: 'tracker', value: 'evil', domain: '.evil.com' }, // 域白名单外,必须被过滤
];

const mk = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xhs-store-'));
    return { dir, store: createSessionStore({ sessionKeyHex: KEY, filePath: path.join(dir, 'session.json') }) };
};

describe('xhs sessionStore', () => {
    it('round-trips allowed cookies and never writes plaintext to disk', async () => {
        const { dir, store } = mk();
        const saved = await store.save(mkCookies());
        expect(saved.version).toBeTruthy();
        const got = await store.get();
        expect(got.cookieStr).toContain('a1=');
        expect(got.cookieStr).toContain('web_session=');
        expect(got.cookieStr).not.toContain('tracker');
        const raw = readFileSync(path.join(dir, 'session.json'), 'utf8');
        expect(raw).not.toContain('web_session=');
        expect(raw).not.toContain('sess-1');
        rmSync(dir, { recursive: true, force: true });
    });

    it('rejects cookie sets missing required names', async () => {
        const { dir, store } = mk();
        await expect(store.save([{ name: 'a1', value: 'x', domain: '.xiaohongshu.com' }]))
            .rejects.toThrow('MISSING_REQUIRED_COOKIE');
        rmSync(dir, { recursive: true, force: true });
    });

    it('is idempotent for identical content and refuses stale overwrite', async () => {
        const { dir, store } = mk();
        await store.save(mkCookies('a'.repeat(52), 'v1'));
        expect((await store.save(mkCookies('a'.repeat(52), 'v1'))).skipped).toBe(true);
        await store.save(mkCookies('b'.repeat(52), 'v2'));
        expect((await store.get()).cookieStr).toContain('b'.repeat(52));
        // 旧版本回归 → 拒写(防采集任务把好会话覆盖回空/旧)
        expect((await store.save(mkCookies('a'.repeat(52), 'v1'))).skipped).toBe(true);
        expect((await store.get()).cookieStr).toContain('b'.repeat(52));
        rmSync(dir, { recursive: true, force: true });
    });

    it('fails deterministically on tampered ciphertext or wrong key', async () => {
        const { dir, store } = mk();
        await store.save(mkCookies());
        const file = path.join(dir, 'session.json');
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        parsed.encryptedCookie = parsed.encryptedCookie.slice(0, -4) + 'AAAA';
        writeFileSync(file, JSON.stringify(parsed));
        await expect(store.get()).rejects.toThrow('STORE_DECRYPT_FAILED');
        const wrongKey = createSessionStore({ sessionKeyHex: 'f'.repeat(64), filePath: file });
        await expect(wrongKey.get()).rejects.toThrow('STORE_DECRYPT_FAILED');
        rmSync(dir, { recursive: true, force: true });
    });

    it('status() never exposes the cookie string', async () => {
        const { dir, store } = mk();
        await store.save(mkCookies());
        const st = store.status();
        expect(st).toHaveProperty('version');
        expect(st).toHaveProperty('cookieNames');
        expect((st as any).cookieStr).toBeUndefined();
        expect(JSON.stringify(st)).not.toContain('sess-1');
        rmSync(dir, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2:确认红**

```bash
corepack pnpm@9.15.9 vitest run vps-backend/src/xhs/sessionStore.test.ts
```
Expected: FAIL(模块不存在)。

- [ ] **Step 3:实现 `vps-backend/src/xhs/sessionStore.js`**

```js
// vps-backend/src/xhs/sessionStore.js
// XHS 会话存储:storage_state cookie → 域白名单过滤 → AES-256-GCM 加密落盘。
// 零依赖(Node 22 自带 webcrypto);磁盘上永远没有 cookie 明文。
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// endsWith 同时兼容 xiaohongshu.com / .xiaohongshu.com / edith.xiaohongshu.com(Playwright 两形态都会出现)
const ALLOWED_COOKIE_DOMAINS = ['xiaohongshu.com', 'rednote.com'];
const REQUIRED_COOKIE_NAMES = ['a1', 'web_session']; // 中心 worker /api 硬校验项

const subtle = webcrypto.subtle;

const importKey = (keyHex) =>
    subtle.importKey('raw', Buffer.from(keyHex, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);

const encrypt = async (key, plaintext) => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const buf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    return Buffer.concat([iv, new Uint8Array(buf)]).toString('base64');
};

const decrypt = async (key, b64) => {
    const raw = Buffer.from(b64, 'base64');
    const iv = raw.subarray(0, 12);
    const out = await subtle.decrypt({ name: 'AES-GCM', iv }, key, raw.subarray(12));
    return new TextDecoder().decode(out);
};

const versionOf = async (cookieStr) => {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(cookieStr));
    return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
};

export function createSessionStore({ sessionKeyHex, filePath }) {
    if (!sessionKeyHex || sessionKeyHex.length !== 64) {
        throw new Error('XHS_SESSION_KEY must be 64 hex chars (32 bytes)');
    }
    const keyPromise = importKey(sessionKeyHex);
    // 内存态:最近一次写入的 version(版本单调的参照)。历史版本记录(最近 8 个)用于拒写回归。
    const seenVersions = [];

    const loadDisk = () => {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return null;
        }
    };

    return {
        async save(playwrightCookies) {
            const names = [];
            const parts = [];
            for (const c of playwrightCookies || []) {
                if (!ALLOWED_COOKIE_DOMAINS.some((d) => (c.domain || '').endsWith(d))) continue;
                if (names.includes(c.name)) continue; // 同名去重(取先到的)
                names.push(c.name);
                parts.push(`${c.name}=${c.value}`);
            }
            for (const required of REQUIRED_COOKIE_NAMES) {
                if (!names.includes(required)) throw new Error(`MISSING_REQUIRED_COOKIE:${required}`);
            }
            const cookieStr = parts.join('; ');
            const version = await versionOf(cookieStr);

            const disk = loadDisk();
            if (disk && disk.version === version) {
                return { version, skipped: true };
            }
            // 版本单调:该内容此前写过(是更早的一代) → 拒写,防回退覆盖。
            if (seenVersions.includes(version)) {
                return { version: disk?.version || version, skipped: true };
            }
            const updatedAt = Date.now();
            const encryptedCookie = await encrypt(await keyPromise, cookieStr);
            const payload = { version, updatedAt, cookieNames: names, encryptedCookie };
            const tmp = `${filePath}.tmp`;
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
            fs.renameSync(tmp, filePath);
            if (disk?.version && !seenVersions.includes(disk.version)) seenVersions.push(disk.version);
            seenVersions.push(version);
            if (seenVersions.length > 16) seenVersions.splice(0, seenVersions.length - 16);
            return { version };
        },

        async get() {
            const disk = loadDisk();
            if (!disk || !disk.encryptedCookie) throw new Error('STORE_EMPTY');
            try {
                const cookieStr = await decrypt(await keyPromise, disk.encryptedCookie);
                return { cookieStr, version: disk.version, updatedAt: disk.updatedAt };
            } catch {
                throw new Error('STORE_DECRYPT_FAILED');
            }
        },

        status() {
            const disk = loadDisk();
            if (!disk) return { configured: false, hasRequired: false };
            const fromDisk = disk.cookieNames || [];
            return {
                configured: true,
                version: disk.version,
                updatedAt: disk.updatedAt,
                cookieNames: fromDisk,
                hasRequired: REQUIRED_COOKIE_NAMES.every((n) => fromDisk.includes(n)),
                // 注意:永远不返回 cookieStr / encryptedCookie
            };
        },

        wipe() {
            try { fs.unlinkSync(filePath); } catch { /* 不存在即已清 */ }
            seenVersions.length = 0;
        },
    };
}
```

- [ ] **Step 4:绿 + Commit**

```bash
corepack pnpm@9.15.9 vitest run vps-backend/src/xhs/sessionStore.test.ts
```
Expected: 全 PASS。

```bash
git add vps-backend/src/xhs/sessionStore.js vps-backend/src/xhs/sessionStore.test.ts
git commit -m "feat(vps-backend): encrypted xhs session store with monotonic version"
```

---

## 任务 7:sessionBridge(HTTP + 鉴权 + 转发 + CORS + 脱敏)

**Files:**
- Create: `vps-backend/src/xhs/sessionBridge.js`
- Create: `vps-backend/src/xhs/sessionBridge.test.ts`

**Interfaces(Produces):** `startSessionBridge({ port, host, token, store, upstream, collector })` → `{ server, ready, close }`;端点 `GET /api/health`(免鉴权)、`GET /api/session/status`、`POST /api/session/refresh`、`POST /api/session/invalidate`、`POST /api/:command`(转发)。

- [ ] **Step 1:测试 `vps-backend/src/xhs/sessionBridge.test.ts`(先红)**

```ts
// vps-backend/src/xhs/sessionBridge.test.ts
import { describe, it, expect } from 'vitest';
import { startSessionBridge } from './sessionBridge.js';

const TOKEN = 'test-token';

const mkStore = (cookieStr = 'a1=' + 'a'.repeat(52) + '; web_session=s1') => ({
    async get() { return { cookieStr, version: 'v1', updatedAt: 1 }; },
    status: () => ({ configured: true, version: 'v1', updatedAt: 1, cookieNames: ['a1', 'web_session'], hasRequired: true }),
    async wipe() {},
});

const start = async (store: any, upstreamMock?: any) => {
    if (upstreamMock) {
        // 注入 upstream fetch 替身:通过 global fetch 拦截 https://upstream.test
        const realFetch = globalThis.fetch;
        (globalThis as any).__realFetchForBridgeTest = realFetch;
        vi_fetch_intercept = upstreamMock;
    }
    const br = startSessionBridge({
        port: 0, host: '127.0.0.1', token: TOKEN, store,
        upstream: 'https://upstream.test',
    });
    await br.ready;
    return br;
};

// 拦截器:bridge 内部 fetch(upstream.test)走 mock,其余(测试自身的 127.0.0.1 请求)走真 fetch。
let vi_fetch_intercept: any = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes('upstream.test') && vi_fetch_intercept) {
        const json = await vi_fetch_intercept(url, init);
        return new Response(JSON.stringify(json.body), {
            status: json.status || 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    return realFetch(input, init);
}) as any;

const port = (br: any) => br.server.address().port;

describe('xhs sessionBridge', () => {
    it('health is open without token', async () => {
        const br = await start(mkStore());
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/health`);
        expect(resp.status).toBe(200);
        expect(await resp.json()).toMatchObject({ status: 'ok' });
        await br.close();
    });

    it('rejects missing/incorrect token with 401', async () => {
        const br = await start(mkStore());
        const miss = await fetch(`http://127.0.0.1:${port(br)}/api/session/status`);
        expect(miss.status).toBe(401);
        const wrong = await fetch(`http://127.0.0.1:${port(br)}/api/session/status`, { headers: { 'x-bridge-token': 'nope' } });
        expect(wrong.status).toBe(401);
        await br.close();
    });

    it('status never includes the cookie string', async () => {
        const br = await start(mkStore());
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/session/status`, { headers: { 'x-bridge-token': TOKEN } });
        const body = await resp.text();
        expect(body).not.toContain('web_session=');
        expect(body).not.toContain('a1=');
        await br.close();
    });

    it('forwards commands with decrypted cookie + session tag; no-store', async () => {
        const br = await start(mkStore(), async (url: string, init: any) => {
            expect(url).toBe('https://upstream.test/api/search');
            expect(init.headers['x-xhs-cookie']).toContain('web_session=');
            return { body: { success: true, feeds: [], platform: 'xhs' } };
        });
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
            body: JSON.stringify({ keyword: 'cat' }),
        });
        const data = await resp.json();
        expect(data.success).toBe(true);
        expect(data.xhs_session_tag).toBeTruthy();
        expect(resp.headers.get('cache-control')).toBe('no-store');
        await br.close();
    });

    it('OPTIONS preflight returns 204 with echoed headers (CORS contract)', async () => {
        const br = await start(mkStore());
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Headers': 'content-type,x-bridge-token' },
        });
        expect(resp.status).toBe(204);
        expect(resp.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
        expect(resp.headers.get('access-control-allow-headers')).toContain('x-bridge-token');
        await br.close();
    });

    it('redacts leaked cookie fragments from upstream errors', async () => {
        const br = await start(mkStore(), async () => ({ body: { error: 'bad header a1=SECRET; web_session=LEAK' } }));
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
            body: '{}',
        });
        const text = JSON.stringify(await resp.json());
        expect(text).not.toContain('SECRET');
        expect(text).not.toContain('LEAK');
        expect(text).toContain('[REDACTED]');
        await br.close();
    });

    it('503 when the store is empty', async () => {
        const emptyStore = { async get() { throw new Error('STORE_EMPTY'); }, status: () => ({ configured: false }), async wipe() {} };
        const br = await start(emptyStore as any);
        const resp = await fetch(`http://127.0.0.1:${port(br)}/api/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-bridge-token': TOKEN },
            body: '{}',
        });
        expect(resp.status).toBe(503);
        await br.close();
    });
});
```
> 说明:测试顶部对 `globalThis.fetch` 的包装是为了让 bridge 内部的 upstream 调用可被替换、同时不干扰测试自身访问 127.0.0.1。若 vitest 环境下该包装影响其它用例(独立文件运行,无影响),保持此写法即可。

- [ ] **Step 2:确认红**

```bash
corepack pnpm@9.15.9 vitest run vps-backend/src/xhs/sessionBridge.test.ts
```

- [ ] **Step 3:实现 `vps-backend/src/xhs/sessionBridge.js`**

```js
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
```

- [ ] **Step 4:绿 + Commit**

```bash
corepack pnpm@9.15.9 vitest run vps-backend/src/xhs/sessionBridge.test.ts
```
Expected: 全 PASS。

```bash
git add vps-backend/src/xhs/sessionBridge.js vps-backend/src/xhs/sessionBridge.test.ts
git commit -m "feat(vps-backend): xhs session bridge (token auth, cookie injection, redaction)"
```

---

## 任务 8:camofox 采集器 + 联合入口 run.js

**Files:**
- Create: `vps-backend/src/xhs/camofoxCollector.js`
- Create: `vps-backend/src/xhs/run.js`

- [ ] **Step 1:实现 `vps-backend/src/xhs/camofoxCollector.js`**

```js
// vps-backend/src/xhs/camofoxCollector.js
// camofox storage_state 采集:GET /sessions/:userId/storage_state → 域过滤 → sessionStore.save。
// 404(无活动会话,如容器重启后)→ 自动建会话(持久化插件会恢复 storageState)→ 重试一次。
// 失败只 warn,永不 crash 常驻进程;对外接口(startCollector → {collect, stop})与 bridge 的 collector.collect() 契约不变。
const CAMOFOX_BASE = process.env.CAMOFOX_BASE || 'http://127.0.0.1:9377';
const CAMOFOX_API_KEY = process.env.CAMOFOX_API_KEY || '';
const USER_ID = process.env.XHS_CAMOFOX_USER || 'sullyos-xhs';
const SESSION_KEY = process.env.XHS_CAMOFOX_SESSION || 'main';
const START_URL = 'https://www.xiaohongshu.com';
const POLL_MS = Number(process.env.XHS_COLLECT_INTERVAL_MS || 10 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createSession() {
    const resp = await fetch(`${CAMOFOX_BASE}/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, sessionKey: SESSION_KEY, url: START_URL }),
    });
    if (!resp.ok) throw new Error(`create tab http ${resp.status}`);
    await sleep(3000); // 等页面加载(持久化恢复发生在上下文创建时)
}

async function exportStorageState() {
    const resp = await fetch(`${CAMOFOX_BASE}/sessions/${USER_ID}/storage_state`, {
        headers: { authorization: `Bearer ${CAMOFOX_API_KEY}` },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`storage_state http ${resp.status}`);
    return resp.json();
}

async function collectOnce(store) {
    let state = await exportStorageState();
    if (!state) {
        await createSession();
        state = await exportStorageState();
        if (!state) throw new Error('no storage state after session create');
    }
    const cookies = state.cookies || [];
    const saved = await store.save(cookies);
    console.log(`[xhs-collector] collected ${cookies.length} cookies -> version ${saved.version}${saved.skipped ? ' (unchanged)' : ''}`);
}

export function startCollector(store) {
    let running = false;
    const loop = async () => {
        if (running) return;
        running = true;
        try {
            await collectOnce(store);
        } catch (e) {
            const msg = String(e?.message ?? e);
            if (msg.startsWith('MISSING_REQUIRED_COOKIE')) {
                console.warn('[xhs-collector] camofox session logged out (required cookie missing) — keeping last good session');
            } else {
                console.warn(`[xhs-collector] collect failed: ${msg}`);
            }
        } finally {
            running = false;
        }
    };
    loop(); // 启动即采
    const timer = setInterval(loop, POLL_MS);
    return { collect: loop, stop: () => clearInterval(timer) };
}
```

- [ ] **Step 2:实现 `vps-backend/src/xhs/run.js`**

```js
// vps-backend/src/xhs/run.js
// systemd xhs-session.service 入口:读 /opt/sullyos/.env 的配置,起 bridge + collector。
import { readFileSync } from 'node:fs';
import { createSessionStore } from './sessionStore.js';
import { startSessionBridge } from './sessionBridge.js';
import { startCollector } from './camofoxCollector.js';

// 简易 .env 解析(只兜底;systemd 缺省不注入时也能跑)
const envFile = process.env.XHS_ENV_FILE || '/opt/sullyos/.env';
try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch { /* env 由 systemd 注入时无需文件 */ }

const store = createSessionStore({
    sessionKeyHex: process.env.XHS_SESSION_KEY,
    filePath: process.env.XHS_SESSION_FILE || '/var/lib/sullyos-xhs/session/session.json',
});
const collector = startCollector(store);
const bridge = startSessionBridge({
    port: Number(process.env.XHS_BRIDGE_PORT || 8836),
    host: '127.0.0.1',
    token: process.env.XHS_BRIDGE_TOKEN,
    store,
    upstream: process.env.XHS_LITE_UPSTREAM || 'https://sully-proxy.plasmavendorlia.workers.dev',
    collector,
});
await bridge.ready;
console.log('[xhs-run] session bridge + collector started');

const shutdown = () => {
    collector.stop();
    bridge.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 3:Commit**

```bash
git add vps-backend/src/xhs/camofoxCollector.js vps-backend/src/xhs/run.js
git commit -m "feat(vps-backend): camofox storage_state collector and combined runner"
```

---

## 任务 9:camofox 常驻部署 + bridge systemd + Caddy 挂载

**Files:**
- Create: `vps-backend/deploy/xhs-camofox-run.sh`
- Create: `vps-backend/deploy/xhs-session.service`
- Create: `vps-backend/deploy/xhs-login.sh`
- Modify: `vps-backend/deploy/caddy/SullyOS.Caddyfile`(仓库模板)
- VPS 运行时:`/etc/caddy/Caddyfile`、`/etc/systemd/system/*`
- **不再创建**:`xhs-browser.service`(Chrome+Xvfb)(camofox 容器替代,自带 `--restart unless-stopped`)

- [ ] **Step 1:`vps-backend/deploy/xhs-camofox-run.sh`(幂等重建容器)**

```bash
#!/usr/bin/env bash
# 重新部署 camofox-browser 容器(幂等):读 /opt/sullyos/.env,重建容器。
# 用法: bash vps-backend/deploy/xhs-camofox-run.sh
set -euo pipefail
set -a; . /opt/sullyos/.env; set +a

: "${CAMOFOX_API_KEY:?missing in /opt/sullyos/.env}"
: "${XHS_CAMOFOX_VNC_PASSWORD:?missing in /opt/sullyos/.env}"

IMAGE_TAG="${CAMOFOX_IMAGE_TAG:-camofox-browser:152.0.4-beta.28}"
mkdir -p /var/lib/sullyos-xhs/camofox/profiles /var/lib/sullyos-xhs/camofox/cookies

docker rm -f camofox-browser 2>/dev/null || true
docker run -d --restart unless-stopped --name camofox-browser --shm-size=2g \
  -p 127.0.0.1:9377:9377 -p 127.0.0.1:6080:6080 \
  -e CAMOFOX_API_KEY="$CAMOFOX_API_KEY" \
  -e ENABLE_VNC=1 -e VNC_PASSWORD="$XHS_CAMOFOX_VNC_PASSWORD" -e NOVNC_PORT=6080 \
  -e CAMOFOX_CRASH_REPORT_ENABLED=false \
  -e SESSION_TIMEOUT_MS=0 -e BROWSER_IDLE_TIMEOUT_MS=0 -e TAB_INACTIVITY_MS=0 \
  -e CAMOFOX_PROFILE_DIR=/data/profiles -e CAMOFOX_COOKIES_DIR=/data/cookies \
  -v /var/lib/sullyos-xhs/camofox/profiles:/data/profiles \
  -v /var/lib/sullyos-xhs/camofox/cookies:/data/cookies \
  "$IMAGE_TAG"

echo "camofox-browser restarted ($IMAGE_TAG)"
curl -fsS http://127.0.0.1:9377/health && echo
```

- [ ] **Step 2:`vps-backend/deploy/xhs-session.service`**

```ini
[Unit]
Description=SullyOS XHS Session Bridge (collector + http bridge on 127.0.0.1:8836)
After=network.target docker.service

[Service]
WorkingDirectory=/opt/sullyos/sullyos-repo/vps-backend/src/xhs
ExecStart=/usr/bin/node run.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3:`vps-backend/deploy/xhs-login.sh`(登录入口说明,VNC 在容器内)**

```bash
#!/usr/bin/env bash
# 登录入口说明(容器内 VNC)。VNC/6080 只绑 127.0.0.1,无公网暴露。
cat <<'EOF'
1) 本机执行:  ssh -L 6080:127.0.0.1:6080 root@<vps-ip>
2) 浏览器打开: http://localhost:6080/vnc.html  (密码 = /opt/sullyos/.env 的 XHS_CAMOFOX_VNC_PASSWORD)
3) 若无 xiaohongshu 标签页,在 VPS 执行:
   curl -s -X POST http://127.0.0.1:9377/tabs -H 'content-type: application/json' \
     -d '{"userId":"sullyos-xhs","sessionKey":"main","url":"https://www.xiaohongshu.com"}'
4) noVNC 画面内点「登录」→「扫码登录」,手机小红书 App 扫码确认。
EOF
```

- [ ] **Step 4:仓库 Caddy 模板追加(`handle_path /heartbeat/*` 块后)**

```
	# xhs session bridge (token-gated, cookie stays on VPS)
	handle_path /xhs-api* {
		reverse_proxy 127.0.0.1:8836
	}
```

- [ ] **Step 5:Commit + push + VPS 部署**

```bash
git add vps-backend/deploy/xhs-camofox-run.sh vps-backend/deploy/xhs-session.service vps-backend/deploy/xhs-login.sh vps-backend/deploy/caddy/SullyOS.Caddyfile
git commit -m "feat(vps-backend): camofox run script and session service unit"
git push origin ethernet
```
VPS 上:
```bash
cd /opt/sullyos/sullyos-repo && git pull
cp vps-backend/deploy/xhs-session.service /etc/systemd/system/
chmod +x vps-backend/deploy/xhs-login.sh vps-backend/deploy/xhs-camofox-run.sh
bash vps-backend/deploy/xhs-camofox-run.sh
# /etc/caddy/Caddyfile 的 ethernet-vps.bot.cd 块内(heartbeat 段后)手工加同样三行 handle_path /xhs-api* 段
systemctl daemon-reload && systemctl enable --now xhs-session
systemctl reload caddy
```

- [ ] **Step 6:验收(全过才算批次二完成,阶段门)**

```bash
docker inspect camofox-browser --format '{{.State.Status}}'                        # running
docker inspect camofox-browser --format '{{json .HostConfig.PortBindings}}'        # 两项均只绑 127.0.0.1
systemctl is-active xhs-session                                                    # active
ss -lntp | grep -E '8836|9377|6080'                                                # 三行,均仅 127.0.0.1
curl -fsS https://ethernet-vps.bot.cd/xhs-api/api/health
# → {"status":"ok","backend":"xhs-session-bridge"}
curl -fsS -H "X-Bridge-Token: <XHS_BRIDGE_TOKEN>" https://ethernet-vps.bot.cd/xhs-api/api/session/status
# → 含 version 与 cookieNames;不含任何 cookie 片段
curl -fsS -X POST -H "X-Bridge-Token: <XHS_BRIDGE_TOKEN>" -H 'content-type: application/json' \
  -d '{}' https://ethernet-vps.bot.cd/xhs-api/api/check-login
# → logged_in:true + nickname（阶段门:这条不过,批次三不开始）
journalctl -u xhs-session -n 50 --no-pager        # 确认日志无 a1= / web_session
```

---

# 批次三:SullyOS 接线

## 任务 10:前端 vps 传输模式测试覆盖

**Files:**
- Modify: `utils/xhsMcpClient.test.ts`(核心传输已在任务 2 落地;本任务补 testConnection 的 vps 探活用例)

- [ ] **Step 1:测试追加**

```ts
describe('vps bridge transport', () => {
    afterEach(() => { XhsMcpClient.setCookie(''); XhsMcpClient.setBridgeToken(''); vi.restoreAllMocks(); });

    it('testConnection probes health then check-login on the vps bridge URL', async () => {
        XhsMcpClient.setBridgeToken('bridge-tok');
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
            const url = String(input);
            if (url.endsWith('/api/health')) {
                return new Response(JSON.stringify({ status: 'ok', backend: 'xhs-session-bridge' }), { headers: { 'content-type': 'application/json' } });
            }
            if (url.endsWith('/api/check-login')) {
                return new Response(JSON.stringify({ logged_in: true, nickname: '喵', user_id: 'u9', platform: 'xhs', xhs_session_tag: 'deadbeef' }), { headers: { 'content-type': 'application/json' } });
            }
            if (url.endsWith('/api/list-feeds')) {
                return new Response(JSON.stringify({ success: true, feeds: [] }), { headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected url: ${url}`);
        });
        const result = await XhsMcpClient.testConnection('https://ethernet-vps.bot.cd/xhs-api/api', undefined);
        expect(result.connected).toBe(true);
        expect(result.loggedIn).toBe(true);
        expect(result.nickname).toBe('喵');
        expect(String(fetchSpy.mock.calls[0][0])).toContain('/xhs-api/api/health');
    });
});
```

- [ ] **Step 2:跑测试 + Commit**

```bash
corepack pnpm@9.15.9 vitest run utils/xhsMcpClient.test.ts
corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts
```

```bash
git add utils/xhsMcpClient.test.ts
git commit -m "test(xhs): vps bridge transport coverage"
```

- [ ] **Step 3:真机冒烟(用户参与,依赖批次二已部署)**

Settings → 小红书 → VPS 托管模式 → 填 `<XHS_BRIDGE_TOKEN>` → 测试连接。预期:显示账号昵称/平台。

---

## 任务 11:Settings 会话状态卡(刷新按钮 + 失效引导)

**Files:**
- Modify: `apps/Settings.tsx`(在任务 4 骨架上继续)

- [ ] **Step 1:vps 面板(bridgeToken input 之后)追加「立即同步」与状态说明**

```tsx
                            <div>
                                <button type="button" onClick={async () => {
                                    setRtTestStatus('正在同步...');
                                    try {
                                        const base = XHS_VPS_URL.replace(/\/+$/, '').replace(/\/api$/, '');
                                        const resp = await fetch(`${base}/api/session/refresh`, {
                                            method: 'POST',
                                            headers: { 'x-bridge-token': rtXhsBridgeToken.trim() },
                                        });
                                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                                        const st = await resp.json();
                                        setRtTestStatus(st.configured
                                            ? `会话已同步（版本 ${String(st.version).slice(0, 8)}，更新于 ${new Date(st.updatedAt).toLocaleString()}）`
                                            : '服务器上还没有登录会话：请在服务器浏览器完成扫码登录');
                                    } catch (e: any) {
                                        setRtTestStatus(`同步失败: ${e.message}`);
                                    }
                                }} className="w-full py-1.5 bg-rose-50 text-rose-500 text-[11px] font-bold rounded-xl active:scale-95 transition-transform">立即同步</button>
                            </div>
                            <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-100/60 rounded-lg px-2 py-1.5">
                                {rtTestStatus?.includes('未登录') || rtTestStatus?.includes('登录已失效') || rtTestStatus?.includes('重新登录')
                                    ? '登录已失效：请在服务器浏览器里重新扫码（运行 vps-backend/deploy/xhs-login.sh 后经 SSH 隧道访问）。'
                                    : '登录态由服务器浏览器维护；失效时去服务器扫码即可，无需复制 cookie。'}
                            </p>
```

- [ ] **Step 2:验证 + Commit**

```bash
corepack pnpm@9.15.9 tsc --noEmit
corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts
```

```bash
git add apps/Settings.tsx
git commit -m "feat(settings): vps session refresh button and relogin guidance"
```

---

## 任务 12:amsg 上云改造(cookie 不再上云)

**Files:**
- Modify: `utils/amsgToolPack.ts`(74-82、210-222)
- Modify: `worker/amsg/src/index.ts`(345-349、474-509、2422-2433)
- Modify: `utils/amsgBundleVersion.ts`
- Create: `utils/xhsVpsToolConfig.test.ts`

- [ ] **Step 1:amsgToolPack.ts 接口(74-82)加字段**

```ts
  xhsMcpConfig?: {
    enabled: boolean;
    serverUrl: string;
    cookie?: string;
    bridgeToken?: string;
    platform?: 'xhs' | 'rednote';
    loggedInUserId?: string;
    loggedInNickname?: string;
    userXsecToken?: string;
  };
```

- [ ] **Step 2:buildToolConfig xhs 分支(210-222)**

`...(xhs.cookie ? { cookie: xhs.cookie } : {}),` 行替换为:
```ts
            // vps 模式:cookie 永不上云(服务器托管会话);manual/lite 模式行为不变。
            ...((xhs as any).mode === 'vps' ? {} : (xhs.cookie ? { cookie: xhs.cookie } : {})),
            ...((xhs as any).mode === 'vps' && xhs.bridgeToken ? { bridgeToken: xhs.bridgeToken } : {}),
```

- [ ] **Step 3:worker/amsg/src/index.ts 三处**

349 行 `xhsCookie: string;` 后追加:
```ts
  /** vps 模式的 bridge 鉴权 token(cookie 留在 VPS,不在云端)。 */
  xhsBridgeToken: string;
```
507 行 `xhsCookie: config.xhsMcpConfig?.cookie ?? '',` 后追加:
```ts
    xhsBridgeToken: ((config.xhsMcpConfig as any)?.bridgeToken as string) ?? '',
```
2433 行 `if (stash.xhsCookie) XhsMcpClient.setCookie(stash.xhsCookie);` 后追加:
```ts
    if (stash.xhsBridgeToken) XhsMcpClient.setBridgeToken(stash.xhsBridgeToken);
```

- [ ] **Step 4:`utils/amsgBundleVersion.ts`** → `export const AMSG_BUNDLE_VERSION = '2026-09-15';`

- [ ] **Step 5:测试 `utils/xhsVpsToolConfig.test.ts`**

```ts
// utils/xhsVpsToolConfig.test.ts
import { describe, it, expect } from 'vitest';
import { buildToolConfig } from './amsgToolPack';
import type { RealtimeConfig } from '../types';

const baseRc = (xhs: any): RealtimeConfig => ({ xhsMcpConfig: xhs } as unknown as RealtimeConfig);

describe('buildToolConfig xhs modes', () => {
    it('vps mode uploads bridgeToken and never a cookie', () => {
        const cfg = JSON.parse(JSON.stringify(buildToolConfig(baseRc({
            enabled: true, mode: 'vps', serverUrl: 'https://ethernet-vps.bot.cd/xhs-api/api',
            bridgeToken: 'tok-1', cookie: 'a1=SHOULD_NOT_UPLOAD', platform: 'xhs',
        }))!));
        expect(cfg.xhsMcpConfig.bridgeToken).toBe('tok-1');
        expect(JSON.stringify(cfg)).not.toContain('SHOULD_NOT_UPLOAD');
    });
    it('manual lite mode keeps uploading the cookie unchanged', () => {
        const cfg = JSON.parse(JSON.stringify(buildToolConfig(baseRc({
            enabled: true, mode: 'lite', serverUrl: 'https://worker.test/api',
            cookie: 'a1=abc; web_session=s',
        }))!));
        expect(cfg.xhsMcpConfig.cookie).toBe('a1=abc; web_session=s');
        expect(cfg.xhsMcpConfig.bridgeToken).toBeUndefined();
    });
});
```

- [ ] **Step 6:跑测试 + 构建**

```bash
corepack pnpm@9.15.9 vitest run utils/xhsVpsToolConfig.test.ts
corepack pnpm@9.15.9 run build:workers
corepack pnpm@9.15.9 tsc --noEmit
```
Expected: 测试全 PASS;amsg bundle 变化(产物随 commit)。

- [ ] **Step 7:Commit + push + VPS 更新**

```bash
git add utils/amsgToolPack.ts worker/amsg/src/index.ts utils/amsgBundleVersion.ts utils/xhsVpsToolConfig.test.ts worker/amsg/worker.bundle.js
git commit -m "feat(amsg): vps-bridge session for proactive messages (no cookie upload)"
git push origin ethernet
```
VPS:`cd /opt/sullyos/sullyos-repo && git pull && systemctl restart sullyos.service`。

---

# 批次四:安全收口与验收

## 任务 13:安全审计(全过才进 14)

- [ ] VPS 执行并确认:
```bash
ss -lntup | grep -E '8836|9377|6080|5900'     # 全部仅 127.0.0.1(5900 不应出现,未发布)
docker inspect camofox-browser --format '{{json .HostConfig.PortBindings}}'  # 9377/6080 均 127.0.0.1
stat -c '%a %U' /var/lib/sullyos-xhs          # 700
grep -r 'web_session=' /var/lib/sullyos-xhs/session/ 2>/dev/null | wc -l   # 0
journalctl -u xhs-session -n 200 --no-pager | grep -E 'a1=|web_session' | wc -l  # 0
docker logs camofox-browser 2>&1 | grep -cE 'a1=|web_session' # 0
grep -n '9377\|6080' /etc/caddy/Caddyfile | wc -l            # 0(Caddy 不反代 camofox)
systemctl is-active xhs-mcp 2>/dev/null || true                # inactive
rm -rf /opt/xhs-mcp && systemctl disable xhs-mcp 2>/dev/null; echo cleaned
```
- [ ] 仓库:`rg -n 'XHS_BRIDGE_TOKEN|XHS_SESSION_KEY' --glob '!docs/**'` 只允许 vps 代码读取处出现变量名,值不落仓库。
- [ ] 提醒用户:root 密码已在对话中暴露,建议轮换并改 SSH key 登录(人工动作,报告即可)。

## 任务 14:端到端验收(六场景,真机)

逐条执行记录:
- [ ] **A 首次登录**:SSH 隧道 + noVNC(xhs-login.sh 说明)扫码 → Settings vps 模式测试连接 → 显示昵称;list/search/detail 各一次只读调用成功。
- [ ] **B 浏览器重启**:`docker restart camofox-browser` → 等 15 秒 → `node /tmp/xhs-trial-check.mjs` 仍 `VERDICT: OK`(会话经持久化恢复,无需重新登录)。
- [ ] **C VPS 重启**:`reboot` → 容器 restart policy 自启(`docker inspect` = running)+ xhs-session 自启 → 手机端执行搜索成功(个人电脑全程不开机)。
- [ ] **D Cookie 自然刷新**:VPS 浏览器触发一次页面访问(或等 10 分钟采集)→ `session/status` 的 version 变化 → 下一次调用自动用新版本。
- [ ] **E 服务端注销**:VPS 浏览器里退出登录 → 手机只读调用 → 返回「登录已失效」类提示(SESSION_EXPIRED 路径,不误报网络错误)→ 重新扫码 → 自动恢复。
- [ ] **F 写操作保护**:模拟 bridge 断网场景发一条评论 → 请求只发出一次、结果为失败/超时文案,绝不自动重放。

任一条不过 → 停,`journalctl -u xhs-session -n 200 --no-pager` 取证再报告。

## 任务 15:全量门禁

```bash
corepack pnpm@9.15.9 vitest run          # 全绿(storageOptimize 4 项为已知并发抖动,单跑 84/84)
corepack pnpm@9.15.9 run build:workers   # amsg bundle 最终版
corepack pnpm@9.15.9 tsc --noEmit        # 触碰文件零新增(存量约 45 不计)
corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts
```

## 任务 16:文档

- [ ] 改 `worker/xhs-lite/README.md`:补「vps 托管模式」一段(bridge 转发、cookie 留 VPS、回退手工路径)。
- [ ] 重写 `notes/xhs-debug-guide.md`:删除废弃的 CDP:9222/Python CLI 描述,改为现状(lite cookie 模式 + vps 托管模式两条路径与排障)。
- [ ] 新建 `docs/xhs-vps-session.md`:部署步骤(camofox 构建`docker build -f Dockerfile.ci`+`xhs-camofox-run.sh`、记录 camofox git HEAD 与镜像 tag)、`<XHS_BRIDGE_TOKEN>`/`<CAMOFOX_API_KEY>`/VNC 密码从哪拿、扫码流程(noVNC + SSH 隧道)、token/密钥轮换流程、常见问题(bridge 503 = 未登录;502 = 中心 worker 不可达;storage_state 404 = 容器重启后等采集器重建会话)、回退手工 cookie 模式与回退 Chrome 方案的方法、明确「浏览器会话 ≠ cookie 永久有效」。
- [ ] `notes/ethernet-features.md` 补记新功能;`notes/ethernet-branch-context.md` 加 ✅ 条目(含验证结论与未实测项)。
- [ ] Commit:`docs(xhs): vps session bridge documentation`,push。

---

## 排程与回退

- **批次一**可独立发布(即使批次二止步于可行性门,前端的超时/单飞/状态展示仍是净收益)。
- **批次二止损门**:任务 5 的 24h 三检挂 → 整个批次二停,不写 bridge 代码。
- **批次三阶段门**:任务 9 Step 6 的 check-login `logged_in:true`。
- **回退**:Settings 切回「云端 Lite」即恢复现有手工 cookie 路径;VPS 组件全部是增量(`docker rm -f camofox-browser` + `systemctl disable --now xhs-session` + 注释 Caddy 追加块)即整体下线,不影响既有 7 个服务;浏览器层回退 Chrome 方案见本文件 git 历史(Task 5/8/9 旧版)。

## 已识别的执行陷阱(执行者必读)

1. Settings.tsx 保存块改动**只做行级替换**,禁止整块重写(保 loggedInNickname/loggedInUserId/userXsecToken 原行不动)。
2. `XhsMcpClient` 没有 `postComment` 方法;写命令测试一律用 `replyComment(serverUrl, feedId, xsecToken, content)`。
3. amsg bundle 每次改 `worker/amsg/src/*` 后必须 `build:workers` 并把 `worker/amsg/worker.bundle.js` 加进 commit。
4. camofox 三个 idle 超时(SESSION/BROWSER_IDLE/TAB_INACTIVITY)必须为 0,否则采集器拿到 404;遥测 `CAMOFOX_CRASH_REPORT_ENABLED=false` 必须显式设置(默认开)。
5. 测试里 mock `new Response(...)` 必须带 `headers: { 'content-type': 'application/json' }`,照抄既有先例。
6. 命令一律 `corepack pnpm@9.15.9`;pnpm 裸命令不存在。
7. 提交前 `git status` 确认只有本任务文件;CRLF 噪音文件绝不进 commit。
8. `vps-backend/src/xhs/*.js` 为 ESM(与 vps-backend 既有 .js 一致);测试文件 import 时带 `.js` 后缀。
