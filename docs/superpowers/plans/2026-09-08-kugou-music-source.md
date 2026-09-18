# 酷狗概念版音乐来源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 音乐 App 新增酷狗概念版来源（默认来源），保留网易云可切换；含搜索/播放/歌词/登录/歌单/我喜欢/最近在听/每日推荐/私人 FM。

**Architecture:** 复刻现有网易链路：浏览器 → 自建 CF Worker 新增 `/kugou/*` 路由（白名单+边缘缓存+多上游）→ 用户自部署的 KuGouMusicApi（Vercel, `platform=lite`）→ 酷狗服务器。前端新增与 `musicApi` 并列的 `kugouApi`，纯函数下沉 `utils/kugouCore.ts`，调用点按 `cfg.source` 分发，不做通用来源抽象。

**Tech Stack:** React + TS + Vite、Cloudflare Worker（单文件 `worker/index.js`）、MakcRe/KuGouMusicApi、vitest。

**Spec:** `docs/superpowers/specs/2026-09-08-kugou-music-source-design.md`（执行前先读，契约与决策以 spec 为准）

## Global Constraints

- 包管理器：`corepack pnpm@9.15.9`（pnpm 不在 PATH）；测试 `corepack pnpm@9.15.9 vitest run`；依赖装不上加 `--registry=https://registry.npmjs.org/`。
- tsc 判据：`corepack pnpm@9.15.9 exec tsc --noEmit` 输出里**本次触碰的文件零命中**（全仓 48 个存量错误是历史遗留，不新增即可）。
- 编码纪律：写/改文件只用 Write/Edit 工具（UTF-8 无 BOM）；含中文的 oldString 只从 Read 工具输出逐字取；bash 参数避免中文；commit message 英文；动过含中文文件后必须跑 `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`。
- git：工作区有 CRLF 噪音，`git add` 只加明确动过的文件路径；提交者身份 plasma953（仓库级已配置，勿动 git config）。
- UI：严格沿用音乐 App 既有玻璃风（`shizuku-glass` / `C` 色板 / MizuHeader / SongRow / MiniPlayer），不引入新视觉语言；改动只发生在音乐 App 内。
- 零新增 LLM 调用（计费红线）。
- 网易云行为零回归：所有既有网易分支、`utils/musicCache.ts`、`utils/musicWorkerUrl.test.ts` 不改逻辑。
- 上游事实（已核实，勿再调研）：KuGouMusicApi 部署时 env `platform=lite`；搜索必须带 cookie（至少 dfid），否则 `error_code: 152`；`/song/url/auth/merge` 不传 dfid 自动生成随机 dfid；歌词两步链 `/search/lyric?hash=` → `/lyric?id&accesskey&fmt=lrc&decode=true` 返回 `body.decodeContent`；二维码状态码 0=过期 1=等待 2=已扫待确认 4=成功返 token；验证码登录请求带 `support_multi:1`（多登录态并存，不会踢掉手机 App）。

---

### Task 0: Phase 0 探针（上游部署 + 响应形态记录）

**Files:** 无代码改动。产出记录到本文件末尾「探针记录」附录（直接编辑本 md）。

**Interfaces:**
- Produces: 探针记录里确认的搜索列表项真实字段名（Task 2 的 fixture 与断言按它校准）、`/song/url/auth/merge` 的 URL 字段路径、`/login/qr/*` 响应字段名。

- [ ] **Step 1（用户手工）: fork + 部署 KuGouMusicApi 到 Vercel**

  1. fork https://github.com/MakcRe/KuGouMusicApi 到 plasma953 账号
  2. vercel.com/new → Import 该仓库 → Framework Preset 选 Other → Environment Variables 加 `platform` = `lite` → Deploy
  3. 记下形如 `https://kugou-music-api-xxx.vercel.app` 的地址

- [ ] **Step 2（agent）: 匿名探针系列**

  PowerShell 执行（把 `<KUGOU_BASE>` 换成 Step 1 的地址）：

  ```powershell
  $b = "<KUGOU_BASE>"
  # 1) 注册 dfid（匿名可用）
  Invoke-RestMethod "$b/register/dev?timestamp=$(Get-Date -UFormat %s)"
  # 2) 带 dfid 搜索（dfid 用上一步响应里的值；若响应结构不同，按实际打印全量 JSON）
  Invoke-RestMethod "$b/search?keywords=%E6%99%B4%E5%A4%A9&pagesize=3&cookie=dfid=<上一步的dfid>&timestamp=$(Get-Date -UFormat %s)" | ConvertTo-Json -Depth 6
  # 3) 二维码 key 响应形态
  Invoke-RestMethod "$b/login/qr/key?timestamp=$(Get-Date -UFormat %s)" | ConvertTo-Json -Depth 6
  ```

  把第 2 步的完整单曲 JSON（一项即可）和第 3 步的完整响应原样抄进本文件「探针记录」附录。若第 2 步返回 `error_code: 152`（dfid-only cookie 不够），记录该结论：搜索形态校准推迟到 Task 7 真机登录后做（Task 7 有校准步骤）。

- [ ] **Step 3: 更新探针记录附录**

  完成判据：附录里有「搜索列表项 JSON 或 152 结论」+「qr/key 响应 JSON」+「使用的 vercel 地址」。把 vercel 地址同步告知用户（Task 8 配 env 要用）。

---

### Task 1: Worker `/kugou` 路由（TDD）

**Files:**
- Modify: `worker/index.js`（插入点见各步骤）
- Test (Create): `worker/kugouProxy.test.ts`

**Interfaces:**
- Consumes: 现有 `shuffleCopy`（index.js:814）、`jsonResponse`、`corsHeaders(origin)`、`caches.default`。
- Produces: `KUGOU_UPSTREAMS`/`KUGOU_CACHE_TTL`/`KUGOU_ACTION_ALLOWED`/`buildKugouUpstream(action, body, cookie): string|null`（经 `__kugouProxyTest` 导出）；`fetchFromAnyUpstream(upstreams, path, timeoutMs?)` 新签名；`buildCacheKey(namespace, action, body, cookieBucket)` 新签名；路由 `POST /kugou/<action>`（Header `X-Kugou-Cookie`，env `KUGOU_UPSTREAMS` 逗号分隔优先于常量）。

- [ ] **Step 1: 写失败测试 `worker/kugouProxy.test.ts`**

```ts
/**
 * 中心 worker 的 /kugou 中转（worker/index.js）。
 * 钉住：action 白名单、song/url→auth/merge 重写、cookie 头→query 参数、
 * 未配上游时的 500 提示、边缘缓存 HIT/MISS。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error 中心 worker 是纯 JS 单文件，仓库没开 allowJs
import worker, { __kugouProxyTest } from './index.js';

const { buildKugouUpstream } = __kugouProxyTest;
const KUGOU_TEST_UPSTREAM = 'https://kugou-test.vercel.app';

/** 假上游 fetch，记录收到的调用 */
const stubUpstream = (status = 200, body = '{"status":1}') => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
};

/** 内存版 Cache API（vitest 的 node 环境没有 caches.default） */
const stubCaches = () => {
  const store = new Map<string, Response>();
  vi.stubGlobal('caches', {
    default: {
      match: vi.fn(async (req: Request) => store.get(req.url)),
      put: vi.fn(async (req: Request, res: Response) => { store.set(req.url, res); }),
    },
  });
  return store;
};

const callKugou = (path: string, body: any, cookie = '', env: any = { KUGOU_UPSTREAMS: KUGOU_TEST_UPSTREAM }) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['X-Kugou-Cookie'] = cookie;
  return worker.fetch(
    new Request(`https://proxy.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    env,
    { waitUntil: () => {} },
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('buildKugouUpstream', () => {
  it('白名单外的 action 返回 null', () => {
    expect(buildKugouUpstream('evil/proxy', { a: 1 }, '')).toBeNull();
  });

  it('search 透传业务参数并带 cookie/timestamp', () => {
    const url = buildKugouUpstream('search', { keywords: '晴天', page: 1, pagesize: 30 }, 'token=abc;userid=1');
    const u = new URL(`https://x${url}`);
    expect(u.pathname).toBe('/search');
    expect(u.searchParams.get('keywords')).toBe('晴天');
    expect(u.searchParams.get('cookie')).toBe('token=abc;userid=1');
    expect(u.searchParams.get('timestamp')).toBeTruthy();
  });

  it('song/url 重写为 /song/url/auth/merge', () => {
    const u = new URL(`https://x${buildKugouUpstream('song/url', { hash: 'h1', album_id: 'a1', quality: '320' }, '')}`);
    expect(u.pathname).toBe('/song/url/auth/merge');
    expect(u.searchParams.get('hash')).toBe('h1');
    expect(u.searchParams.get('quality')).toBe('320');
  });
});

describe('/kugou route', () => {
  it('未配上游时返回 500 + 提示', async () => {
    const res = await callKugou('/kugou/search', { keywords: 'x' }, '', {});
    expect(res.status).toBe(500);
    expect((await res.json() as any).error).toContain('KUGOU_UPSTREAMS');
  });

  it('白名单外 action 返回 404，一次上游都不打', async () => {
    const calls = stubUpstream();
    const res = await callKugou('/kugou/not-allowed', {});
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  it('转发到上游：GET + cookie/timestamp query，回传 JSON + X-Sully-Cache: MISS + CORS 头', async () => {
    const calls = stubUpstream(200, JSON.stringify({ status: 1, data: { lists: [] } }));
    const res = await callKugou('/kugou/search', { keywords: '晴天' }, 'token=abc;userid=1');
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const upstreamUrl = new URL(calls[0].url);
    expect(upstreamUrl.host).toBe('kugou-test.vercel.app');
    expect(upstreamUrl.pathname).toBe('/search');
    expect(upstreamUrl.searchParams.get('keywords')).toBe('晴天');
    expect(upstreamUrl.searchParams.get('cookie')).toBe('token=abc;userid=1');
    expect(calls[0].init.method).toBe('GET');
    expect(res.headers.get('X-Sully-Cache')).toBe('MISS');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy();
  });

  it('缓存 TTL 内的 action 第二次不打上游（X-Sully-Cache: HIT）', async () => {
    stubCaches();
    stubUpstream(200, JSON.stringify({ status: 1, data: {} }));
    await callKugou('/kugou/lyric', { id: '1', accesskey: 'k' });
    const res2 = await callKugou('/kugou/lyric', { id: '1', accesskey: 'k' });
    expect(res2.headers.get('X-Sully-Cache')).toBe('HIT');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm@9.15.9 vitest run worker/kugouProxy.test.ts`
Expected: FAIL（`__kugouProxyTest` 不存在 → import 报错）

- [ ] **Step 3: 实现 worker 改动（4 处编辑 + 1 处导出）**

  3a. 在 `worker/index.js:860`（`fetchFromAnyUpstream` 函数结束的 `}`）之后、XHS Lite 注释块之前插入：

```js
// ================================================================
//  酷狗概念版音乐代理（上游 = 用户自部署的 MakcRe/KuGouMusicApi）
//  上游项目: https://github.com/MakcRe/KuGouMusicApi
//  部署: fork → Vercel, 环境变量 platform=lite（概念版，token 与标准版不通用）
//  契约见 docs/superpowers/specs/2026-09-08-kugou-music-source-design.md
// ================================================================
const KUGOU_UPSTREAMS = [
  // "https://你的KuGouMusicApi.vercel.app",  // ← 粘贴到这里，或在 CF 面板配 env KUGOU_UPSTREAMS（优先）
];

// 边缘缓存 TTL(秒)。不在表内 = 不缓存（登录/验证码/用户实时数据）。
const KUGOU_CACHE_TTL = {
  'lyric':                    7 * 24 * 3600, // 7天 (LRC 歌词几乎不变)
  'search/lyric':             7 * 24 * 3600,
  'search':                           600,   // 10分
  'playlist/track/all':               600,
  'playlist/track/all/new':           600,
  'user/playlist':                    600,
  'song/url':                         180,   // 3分 (酷狗 URL 有效期短, 留余量)
  'everyday/recommend':               300,   // 5分 (每日推荐一天内基本不变)
};

// action → 上游路径特例（其余 action 名 = 上游路径）
const KUGOU_ACTION_REWRITE = {
  "song/url": "/song/url/auth/merge",  // 聚合版: 自动串 /song/auth, 登录后按 VIP 权益出 URL
};

// action 白名单 — 只放行 KuGouMusicApi 已知接口（防止被当开放代理）
const KUGOU_ACTION_ALLOWED = new Set([
  ...Object.keys(KUGOU_ACTION_REWRITE),
  "search", "search/lyric", "lyric",
  "user/verify", "user/detail", "user/vip/detail",
  "user/playlist", "playlist/track/all", "playlist/track/all/new",
  "everyday/recommend", "personal/fm",
  "user/listen", "lastest/songs/listen",
  "register/dev", "refresh/login",
  "login/qr/key", "login/qr/create", "login/qr/check",
  "login/cellphone", "captcha/sent",
]);

function buildKugouUpstream(action, body, cookie) {
  if (!KUGOU_ACTION_ALLOWED.has(action)) return null;

  const p = new URLSearchParams();
  if (cookie && cookie.trim()) p.set("cookie", cookie.trim());
  // KuGouMusicApi 按 URL 做了 2 分钟缓存, timestamp 防止 URL 级缓存（登录态/验证码必须实时）
  p.set("timestamp", Date.now().toString());
  // 通用透传: 全部业务参数进 query
  for (const [k, v] of Object.entries(body || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) p.set(k, v.join(","));
    else p.set(k, String(v));
  }
  const upstream = KUGOU_ACTION_REWRITE[action] || `/${action}`;
  return `${upstream}?${p}`;
}
```

  3b. `buildCacheKey`（794-809 行）：签名改为 `(namespace, action, body, cookieBucket)`，key 模板改为：

```js
function buildCacheKey(namespace, action, body, cookieBucket) {
  // ……函数体其余不变，只改最后的 return：
  return new Request(
    `https://sully-music-cache.internal/${namespace}/${action}/${cookieBucket}?${qs}`,
    { method: 'GET' }
  );
}
```

  3c. `fetchFromAnyUpstream`（823-824 行）：加首个参数：

```js
async function fetchFromAnyUpstream(upstreams, upstreamPath, timeoutMs = 8000) {
  const order = shuffleCopy(upstreams);
```

  3d. 网易两处调用点改传参：4593 行 `buildCacheKey('netease', action, body, cookieBucket)`；4610 行 `fetchFromAnyUpstream(NETEASE_UPSTREAMS, upstreamPath)`。（缓存 key host 变更 → 旧网易缓存条目一次性失效，TTL 最长 30 天，无感。）

  3e. 在 `/netease/` 路由块的结束 `}`（4647 行）之后、`// ========== Brave Search 代理 ==========`（4649 行）之前插入路由：

```js
    // ========== 酷狗概念版音乐代理 (转发到 KuGouMusicApi, 带边缘缓存 + 多上游容灾) ==========
    // 前端 POST /kugou/<action> { ...body }, Header: X-Kugou-Cookie: token=..;userid=..;dfid=..;auth=..
    // Worker 翻译成 KuGouMusicApi 的 GET 参数形式并转发
    if (url.pathname.startsWith('/kugou/')) {
      const kugouUpstreams = (env && env.KUGOU_UPSTREAMS
        ? String(env.KUGOU_UPSTREAMS).split(',').map((s) => s.trim()).filter(Boolean)
        : []).concat(KUGOU_UPSTREAMS);
      if (kugouUpstreams.length === 0) {
        return jsonResponse({
          error: "Worker 里 KUGOU_UPSTREAMS 还没配置",
          hint: "fork MakcRe/KuGouMusicApi 部署到 Vercel(env: platform=lite), 在 CF 面板给本 Worker 配环境变量 KUGOU_UPSTREAMS=你的vercel地址, 或粘贴进 worker/index.js 的 KUGOU_UPSTREAMS 数组后重新部署"
        }, { status: 500, origin });
      }

      const action = url.pathname.replace('/kugou/', '');
      const kugouCookie = request.headers.get("X-Kugou-Cookie") || "";
      let body = {};
      if (request.method === 'POST') {
        body = await request.json().catch(() => ({}));
      } else if (request.method === 'GET') {
        body = Object.fromEntries(url.searchParams.entries());
      }

      const kugouUpstreamPath = buildKugouUpstream(action, body, kugouCookie);
      if (!kugouUpstreamPath) {
        return jsonResponse({
          error: "Unknown or unallowed kugou action",
          hint: "支持: search, search/lyric, lyric, song/url, user/verify, user/detail, user/vip/detail, user/playlist, playlist/track/all, playlist/track/all/new, everyday/recommend, personal/fm, user/listen, lastest/songs/listen, register/dev, refresh/login, login/qr/key, login/qr/create, login/qr/check, login/cellphone, captcha/sent"
        }, { status: 404, origin });
      }

      // ── 边缘缓存: 公共数据命中直接返回; 带 cookie 的请求分 user 桶 ──
      const kgTtl = KUGOU_CACHE_TTL[action] || 0;
      const kgBucket = kugouCookie ? 'user' : 'anon';
      const kgCacheKey = kgTtl > 0 ? buildCacheKey('kugou', action, body, kgBucket) : null;
      if (kgCacheKey) {
        const cached = await caches.default.match(kgCacheKey);
        if (cached) {
          const text = await cached.text();
          return new Response(text, {
            status: cached.status,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'X-Sully-Cache': 'HIT',
              ...corsHeaders(origin),
            }
          });
        }
      }

      // ── 多上游 + 容灾 ──
      const kgRes = await fetchFromAnyUpstream(kugouUpstreams, kugouUpstreamPath);
      if (kgRes.error) {
        return jsonResponse({
          error: "kugou upstream fetch failed (all sources)",
          detail: kgRes.error,
          tried: kugouUpstreams.length,
        }, { status: 502, origin });
      }

      const kgResponse = new Response(kgRes.text, {
        status: kgRes.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Sully-Cache': 'MISS',
          'X-Sully-Upstream': kgRes.upstream,
          ...corsHeaders(origin),
        }
      });

      // ── 写回缓存 (异步, 不阻塞响应) ──
      if (kgCacheKey && kgRes.status >= 200 && kgRes.status < 400) {
        const kgCacheResp = new Response(kgRes.text, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': `public, max-age=${kgTtl}`,
          }
        });
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(caches.default.put(kgCacheKey, kgCacheResp));
        } else {
          caches.default.put(kgCacheKey, kgCacheResp).catch(() => {});
        }
      }

      return kgResponse;
    }
```

  3f. 在 `worker/index.js:2428`（`export const __xhsLiteTest ...`）之后加导出：

```js
export const __kugouProxyTest = { buildKugouUpstream, KUGOU_ACTION_ALLOWED, KUGOU_CACHE_TTL };
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `corepack pnpm@9.15.9 vitest run worker/kugouProxy.test.ts`
Expected: PASS 全部 7 个用例
Run: `corepack pnpm@9.15.9 vitest run worker/`
Expected: 既有 worker 测试无回归

- [ ] **Step 5: 提交（含 spec/plan 文档）**

```bash
git add docs/superpowers/specs/2026-09-08-kugou-music-source-design.md docs/superpowers/plans/2026-09-08-kugou-music-source.md worker/index.js worker/kugouProxy.test.ts
git commit -m "feat(worker): add /kugou proxy route for KuGouMusicApi upstream"
```

---

### Task 2: 纯函数叶子 `utils/kugouCore.ts`（TDD）

**Files:**
- Create: `utils/kugouCore.ts`
- Test (Create): `utils/kugouCore.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖这些确切名字）:
  - `kugouQuality(q: MusicQuality): '128'|'320'|'flac'|'high'`
  - `hashToId(hash: string): number`
  - `mapKugouSearchItem(s: any): Song`
  - `composeKugouCookie(p: { token?: string; userid?: string|number; dfid?: string; auth?: string }): string`
  - `pickKugouField(j: any, ...keys: string[]): string`
- Consumes: `import type { MusicQuality, Song } from '../context/MusicContext'`（**仅 type import**，MusicContext 在 Task 3 会反向 import 本文件运行时函数，type-only 无运行时循环）。

- [ ] **Step 1: 写失败测试 `utils/kugouCore.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { kugouQuality, hashToId, mapKugouSearchItem, composeKugouCookie, pickKugouField } from './kugouCore';

describe('kugouQuality', () => {
  it('五档映射到酷狗 quality 参数', () => {
    expect(kugouQuality('standard')).toBe('128');
    expect(kugouQuality('higher')).toBe('320');
    expect(kugouQuality('exhigh')).toBe('320');
    expect(kugouQuality('lossless')).toBe('flac');
    expect(kugouQuality('hires')).toBe('high');
  });
});

describe('hashToId', () => {
  it('取前 12 位 hex 转数，非法输入返回 0', () => {
    expect(hashToId('0123456789abcdef0123456789abcdef')).toBe(parseInt('0123456789ab', 16));
    expect(hashToId('')).toBe(0);
    expect(hashToId('!!!')).toBe(0);
  });
});

describe('mapKugouSearchItem', () => {
  // 主形态字段。Task 0 探针若发现真实字段名不同：更新这里 + kugouCore 的 key 枚举，两者必须同步改。
  const SAMPLE = {
    FileHash: '0123456789abcdef0123456789abcdef',
    SongName: '晴天',
    SingerName: '周杰伦',
    AlbumName: '叶惠美',
    AlbumID: '12345',
    AlbumAudioID: 6873491,
    Duration: 269,
    Image: 'http://imge.kugou.com/xxx.jpg',
  };
  it('主形态字段映射', () => {
    const s = mapKugouSearchItem(SAMPLE);
    expect(s).toMatchObject({
      id: 6873491, name: '晴天', artists: '周杰伦', album: '叶惠美',
      duration: 269, fee: 0, source: 'kugou',
      hash: '0123456789abcdef0123456789abcdef',
      kugouAlbumId: '12345', albumAudioId: 6873491,
    });
    // albumPic 原样透传，http→https 由 UI 层 toHttps 做
    expect(s.albumPic).toBe('http://imge.kugou.com/xxx.jpg');
  });
  it('无 AlbumAudioID 用 mixSongID，再无则 hash 兜底', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, AlbumAudioID: undefined, mixSongID: 42 }).id).toBe(42);
    expect(mapKugouSearchItem({ FileHash: SAMPLE.FileHash, SongName: 'x' }).id).toBe(parseInt('0123456789ab', 16));
  });
  it('VIP 标记 → fee=1（列表角标语义与网易 fee===1 对齐）', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, is_vip: 1 }).fee).toBe(1);
    expect(mapKugouSearchItem({ ...SAMPLE, trans_param: { pay_block: 1 } }).fee).toBe(1);
  });
  it('毫秒时长折算成秒', () => {
    expect(mapKugouSearchItem({ ...SAMPLE, Duration: 269000 }).duration).toBe(269);
  });
});

describe('composeKugouCookie', () => {
  it('固定顺序拼装，空值跳过', () => {
    expect(composeKugouCookie({ token: 't', userid: 7, dfid: 'd', auth: 'a' })).toBe('token=t; userid=7; dfid=d; auth=a');
    expect(composeKugouCookie({ token: 't' })).toBe('token=t');
    expect(composeKugouCookie({})).toBe('');
  });
});

describe('pickKugouField', () => {
  it('data 内优先，多 key 兜底', () => {
    expect(pickKugouField({ data: { token: 'T' } }, 'token', 'qrcode')).toBe('T');
    expect(pickKugouField({ dfid: 'D' }, 'token', 'dfid')).toBe('D');
    expect(pickKugouField({}, 'token')).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack pnpm@9.15.9 vitest run utils/kugouCore.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `utils/kugouCore.ts`**

```ts
/**
 * 酷狗概念版来源的纯函数层：搜索结果映射、hash→id、音质映射、登录态拼装。
 * 消费方：context/MusicContext.tsx（kugouApi）、apps/MusicApp.tsx、apps/music/Kugou*Panel。
 * KuGouMusicApi 不同接口的响应字段大小写形态不一（FileHash/fileHash 等），key 全部枚举兜底；
 * Task 0 探针确认真实形态后以 fixture 钉住（utils/kugouCore.test.ts）。
 */
import type { MusicQuality, Song } from '../context/MusicContext';

export type KugouQuality = '128' | '320' | 'flac' | 'high';

/** 现有 5 档音质 → 酷狗 quality 参数（/song/url/auth/merge 支持 128/320/flac/high） */
export const kugouQuality = (q: MusicQuality): KugouQuality =>
  q === 'standard' ? '128' : q === 'lossless' ? 'flac' : q === 'hires' ? 'high' : '320';

/** hash 是 32 位 hex；取前 12 位转数作兜底 id（仅用于没有 albumAudioId/mixSongID 的数据） */
export const hashToId = (hash: string): number => {
  const n = parseInt((hash || '').replace(/[^0-9a-fA-F]/g, '').slice(0, 12), 16);
  return Number.isFinite(n) ? n : 0;
};

/**
 * /search 单曲列表项 → Song。
 * id：albumAudioId 优先，其次 mixSongID，最后 hash 兜底。
 * duration：主形态为秒；个别接口给毫秒（>10000 视为毫秒折算）。
 * fee：1 = VIP/付费角标（与网易 fee===1 的 UI 语义对齐）。
 */
export const mapKugouSearchItem = (s: any): Song => {
  const hash: string = s?.FileHash || s?.fileHash || s?.hash || '';
  const albumAudioId = Number(s?.AlbumAudioID || s?.albumAudioId || s?.album_audio_id || 0) || 0;
  const mixId = Number(s?.mixSongID || s?.mixsongid || s?.MixSongID || 0) || 0;
  const dur = Number(s?.Duration || s?.duration || 0) || 0;
  const vip = s?.is_vip === 1
    || s?.trans_param?.pay_block === 1
    || (s?.pay_type && (s.pay_type.sval === 1 || s.pay_type.listen_fragment === 1));
  return {
    id: albumAudioId || mixId || hashToId(hash),
    name: s?.SongName || s?.name || s?.filename || '',
    artists: s?.SingerName || s?.singername || s?.author_name || '',
    album: s?.AlbumName || s?.albumname || s?.album_name || '',
    albumPic: s?.Image || s?.image || (Array.isArray(s?.sizable_cover) ? s.sizable_cover[0] : '') || '',
    duration: dur > 10000 ? Math.round(dur / 1000) : dur,
    fee: vip ? 1 : 0,
    source: 'kugou',
    hash,
    kugouAlbumId: String(s?.AlbumID || s?.album_id || ''),
    albumAudioId: albumAudioId || undefined,
  };
};

/** 登录后把 token/userid/dfid/auth 拼成 X-Kugou-Cookie 头的值（KuGouMusicApi 的 cookie 串格式） */
export const composeKugouCookie = (p: { token?: string; userid?: string | number; dfid?: string; auth?: string }): string =>
  (['token', 'userid', 'dfid', 'auth'] as const)
    .map(k => (p[k] != null && p[k] !== '' ? `${k}=${p[k]}` : ''))
    .filter(Boolean)
    .join('; ');

/** 从 KuGouMusicApi 响应里按多 key 兜底取值（data 内优先，顶层其次） */
export const pickKugouField = (j: any, ...keys: string[]): string => {
  for (const k of keys) {
    const v = j?.data?.[k] ?? j?.[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `corepack pnpm@9.15.9 vitest run utils/kugouCore.test.ts`
Expected: PASS 全部

---

### Task 3: MusicContext — 类型 + `kugouApi` + `playSong` 酷狗分支

**Files:**
- Modify: `context/MusicContext.tsx`（类型 21-52、默认配置 90-94、import 头部、kugouApi 插在 313 `musicApi` 结束后、playSong 分支插在 743/745 之间）

**Interfaces:**
- Consumes: `kugouQuality`（Task 2）、现有 `resolveMusicWorkerUrl`/`_cachedCall`/`parseLyric`/`resolveRefToDataUrl`/`audioRef`/`cfgRef`/`setLyric`/`setTlyric`/`toast`/`setLoadingSong`。
- Produces: `export type MusicSource = 'kugou' | 'netease'`；`MusicCfg.source?: MusicSource`、`MusicCfg.kugouCookie?: string`；`Song.source?: MusicSource`、`Song.hash?: string`、`Song.kugouAlbumId?: string`、`Song.albumAudioId?: number`；`kugouApi`（方法清单见 Step 3）。`MUSIC_DEFAULT_CFG.source = 'kugou'`。

- [ ] **Step 1: 类型扩展**

  1a. 在 `export type MusicQuality ...`（21 行）后加：

```ts
export type MusicSource = 'kugou' | 'netease';
```

  1b. `MusicCfg`（23-27 行）改为：

```ts
export interface MusicCfg {
  workerUrl: string;
  /** 网易云登录态 */
  cookie: string;
  quality: MusicQuality;
  /** 音源；缺省 = 'kugou'（2026-09 用户选定酷狗默认，网易保留可切换） */
  source?: MusicSource;
  /** 酷狗登录态: token=..;userid=..;dfid=..;auth=..（KugouLoginPanel 生成） */
  kugouCookie?: string;
}
```

  1c. `Song` 接口 `lyricLineTimings?: number[];`（51 行）之后追加：

```ts
  // ── Kugou-source extensions（source 缺省 = 'netease'，存量数据零迁移） ──
  /** 歌曲来源 */
  source?: MusicSource;
  /** 酷狗歌曲 hash（换播放 URL 必需） */
  hash?: string;
  /** 酷狗专辑 id（换 URL 时传，提高命中率） */
  kugouAlbumId?: string;
  /** 酷狗专辑音频 id（作 Song.id 主来源） */
  albumAudioId?: number;
```

  1d. `MUSIC_DEFAULT_CFG`（90-94 行）加 `source: 'kugou',`：

```ts
export const MUSIC_DEFAULT_CFG: MusicCfg = {
  workerUrl: '',
  cookie: '',
  quality: 'exhigh',
  source: 'kugou',
};
```

- [ ] **Step 2: import 头部加一行**（放在既有 import 区，MusicContext 文件顶部的相对导入处）

```ts
import { kugouQuality } from '../utils/kugouCore';
```

- [ ] **Step 3: `kugouApi`** — 插在 `musicApi` 对象结束的 `};`（313 行）之后：

```ts
/* ───────────── 酷狗概念版 API ───────────── */
// 与 musicApi 平行的酷狗来源：同款 _raw/call 结构，复用 _cachedCall（cookie 盐取 kugouCookie）。
// worker 契约见 docs/superpowers/specs/2026-09-08-kugou-music-source-design.md。
export const kugouApi = {
  async _raw(cfg: MusicCfg, path: string, body: any = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const cookie = (cfg.kugouCookie || '').trim();
    if (cookie) headers['X-Kugou-Cookie'] = cookie;
    const url = `${resolveMusicWorkerUrl(cfg)}/kugou${path.startsWith('/') ? path : '/' + path}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || j?.message || `HTTP ${res.status}`);
    return j;
  },
  // 对外：与 musicApi 同款 TTL 缓存 + in-flight 去重（path 与网易同名也不冲突：cookie 盐与 body 形态不同）
  async call(cfg: MusicCfg, path: string, body: any = {}) {
    return _cachedCall(path, body, cfg.kugouCookie, () => kugouApi._raw(cfg, path, body));
  },
  search(cfg: MusicCfg, keyword: string, offset = 0) {
    return kugouApi.call(cfg, '/search', { keywords: keyword, page: Math.floor(offset / 30) + 1, pagesize: 30 });
  },
  searchLyric(cfg: MusicCfg, hash: string) {
    return kugouApi.call(cfg, '/search/lyric', { hash, fmt: 'lrc' });
  },
  lyricById(cfg: MusicCfg, id: string | number, accesskey: string) {
    return kugouApi.call(cfg, '/lyric', { id, accesskey, fmt: 'lrc', decode: true });
  },
  // 两步歌词链：hash → id+accesskey → LRC 文本；拿不到返回 null
  async lyric(cfg: MusicCfg, song: Song) {
    const hit = await kugouApi.searchLyric(cfg, song.hash || '');
    const c = hit?.data?.candidates?.[0] || (Array.isArray(hit?.data) ? hit.data[0] : null);
    if (!c?.id || !c?.accesskey) return null;
    return kugouApi.lyricById(cfg, c.id, c.accesskey);
  },
  songUrl(cfg: MusicCfg, song: Song) {
    return kugouApi.call(cfg, '/song/url', {
      hash: song.hash || '',
      album_id: song.kugouAlbumId || '',
      album_audio_id: song.albumAudioId || 0,
      quality: kugouQuality(cfg.quality),
    });
  },
  registerDev(cfg: MusicCfg) { return kugouApi.call(cfg, '/register/dev', {}); },
  userVerify(cfg: MusicCfg) { return kugouApi.call(cfg, '/user/verify', {}); },
  userDetail(cfg: MusicCfg) { return kugouApi.call(cfg, '/user/detail', {}); },
  userVipDetail(cfg: MusicCfg) { return kugouApi.call(cfg, '/user/vip/detail', {}); },
  userPlaylist(cfg: MusicCfg) { return kugouApi.call(cfg, '/user/playlist', { page: 1, pagesize: 60 }); },
  playlistTrackAllNew(cfg: MusicCfg, listid: string | number, page = 1, pagesize = 30) {
    return kugouApi.call(cfg, '/playlist/track/all/new', { listid, page, pagesize });
  },
  playlistTrackAll(cfg: MusicCfg, id: string | number, page = 1, pagesize = 30) {
    return kugouApi.call(cfg, '/playlist/track/all', { id, page, pagesize });
  },
  everydayRecommend(cfg: MusicCfg) { return kugouApi.call(cfg, '/everyday/recommend', {}); },
  personalFm(cfg: MusicCfg) { return kugouApi.call(cfg, '/personal/fm', {}); },
  userListen(cfg: MusicCfg) { return kugouApi.call(cfg, '/user/listen', {}); },
  lastestSongsListen(cfg: MusicCfg) { return kugouApi.call(cfg, '/lastest/songs/listen', {}); },
  loginQrKey(cfg: MusicCfg) { return kugouApi.call(cfg, '/login/qr/key', {}); },
  loginQrCreate(cfg: MusicCfg, key: string) { return kugouApi.call(cfg, '/login/qr/create', { key, qrimg: true }); },
  loginQrCheck(cfg: MusicCfg, key: string) { return kugouApi.call(cfg, '/login/qr/check', { key }); },
  captchaSent(cfg: MusicCfg, mobile: string) { return kugouApi.call(cfg, '/captcha/sent', { mobile }); },
  loginCellphone(cfg: MusicCfg, mobile: string, code: string) { return kugouApi.call(cfg, '/login/cellphone', { mobile, code }); },
  refreshLogin(cfg: MusicCfg) { return kugouApi.call(cfg, '/refresh/login', {}); },
};
```

- [ ] **Step 4: `playSong` 酷狗分支** — 插在本地歌分支的 `return;` + `}`（743 行）之后、`const [urlRes, lyricRes] = await Promise.all([`（745 行）之前：

```ts
      // ── Kugou branch ── 酷狗概念版：hash 换 URL（auth 聚合版），两步取 LRC 歌词
      if (song.source === 'kugou') {
        if (!song.hash) {
          toast('歌曲数据缺少 hash，无法播放', 'error');
          return;
        }
        const [urlRes, lyricRes] = await Promise.all([
          kugouApi.songUrl(cfgRef.current, song),
          kugouApi.lyric(cfgRef.current, song).catch(() => null),
        ]);
        const d: any = Array.isArray(urlRes?.data) ? urlRes.data[0] : (urlRes?.data || urlRes || {});
        const url: string | null = d?.url || d?.backupUrl || null;
        if (!url) {
          toast(cfgRef.current.kugouCookie ? '该歌曲需要酷狗 VIP 或暂无可用音源' : '需要登录酷狗（我的 → 登录酷狗）', 'error');
          return;
        }
        const a = audioRef.current!;
        a.src = url.replace(/^http:\/\//i, 'https://');
        a.play().catch(() => {});
        const lrcText: string = lyricRes?.body?.decodeContent || lyricRes?.body?.content || '';
        setLyric(parseLyric(lrcText));
        setTlyric([]); // 酷狗无翻译歌词
        // 媒体会话（锁屏 / 通知栏）— 与网易分支同款，封面走 resolveRefToDataUrl
        if ('mediaSession' in navigator) {
          try {
            const artworkSrc = song.albumPic ? await resolveRefToDataUrl(song.albumPic) : '';
            (navigator as any).mediaSession.metadata = new (window as any).MediaMetadata({
              title: song.name,
              artist: song.artists,
              album: song.album,
              artwork: artworkSrc ? [
                { src: artworkSrc, sizes: '300x300', type: 'image/jpeg' },
                { src: artworkSrc, sizes: '512x512', type: 'image/jpeg' },
              ] : [],
            });
          } catch {}
        }
        return;
      }
```

  注意：早退 return 会走函数末尾的 `finally { setLoadingSong(false); }`（782-784 行），与本地歌分支行为一致，无需重复处理。

- [ ] **Step 5: 验证**

Run: `corepack pnpm@9.15.9 vitest run utils/ worker/`
Expected: 全绿（kugouCore + worker 路由 + 既有套件）
Run: `corepack pnpm@9.15.9 exec tsc --noEmit`
Expected: MusicContext.tsx / utils/kugouCore.ts 零命中（MusicApp 还没接 kugouApi，此时应无新错误）

---

### Task 4: MusicApp — 搜索分发 + 登录提示 + 诊断按钮

**Files:**
- Modify: `apps/MusicApp.tsx`（import 4 行、doSearch 119-142、登录 pill 189-199、诊断 onClick 512-528）

**Interfaces:**
- Consumes: `kugouApi`（Task 3）、`mapKugouSearchItem`（Task 2）、`toHttps`（已 import）。
- Produces: 酷狗搜索 → Song[]（含 hash）→ 点歌即走 Task 3 的 playSong 分支。

- [ ] **Step 1: import 三处**

  4 行改为：`import { useMusic, musicApi, kugouApi, normalizeCookie, toHttps, Song } from '../context/MusicContext';`
  其后加两行：`import { mapKugouSearchItem } from '../utils/kugouCore';` 和 `import KugouProfilePage from './music/KugouProfilePage';`（后者 Task 7 才创建文件——本 Task 先加 import 会编译不过，**改为本 Task 只加前两个 import，KugouProfilePage 的 import 留到 Task 7**）

- [ ] **Step 2: doSearch 整体替换（119-142 行）**

```ts
  // ── 搜索 ──
  const doSearch = useCallback(async () => {
    const kw = keyword.trim(); if (!kw) return;
    setSearching(true);
    try {
      if (cfg.source === 'netease') {
        const r = await musicApi.search(cfg, kw);
        const songs: Song[] = (r?.result?.songs || []).map((s: any) => ({
          id: s.id, name: s.name,
          artists: (s.ar || s.artists || []).map((a: any) => a.name).join(' / '),
          album: s.al?.name || s.album?.name || '',
          albumPic: toHttps(s.al?.picUrl || s.album?.picUrl || ''),
          duration: (s.dt || s.duration || 0) / 1000,
          fee: s.fee ?? 0,
        }));
        setResults(songs);
        if (!songs.length) {
          const hint = r?.msg || r?.message || (r?.code != null ? `code=${r.code}` : '') || '无数据';
          addToast(`没找到: ${hint}`, 'info');
        }
      } else {
        const r = await kugouApi.search(cfg, kw);
        const songs: Song[] = (r?.data?.lists || r?.data?.info || [])
          .map(mapKugouSearchItem)
          .filter((s: Song) => s.hash)
          .map((s: Song) => ({ ...s, albumPic: toHttps(s.albumPic) }));
        setResults(songs);
        if (!songs.length) {
          const hint = r?.error || (r?.error_code != null ? `error_code=${r.error_code}` : '') || '无数据';
          addToast(String(hint).includes('152') ? '酷狗搜索需要先登录（我的 → 登录酷狗）' : `没找到: ${hint}`, 'info');
        }
      }
    } catch (e: any) {
      addToast(`搜索失败：${e.message}`, 'error');
    } finally {
      setSearching(false);
    }
  }, [keyword, cfg, addToast]);
```

- [ ] **Step 3: 登录提示 pill（189-199 行）整体替换**

```tsx
      {cfg.source === 'netease' && !cfg.cookie && (
        <div className="px-5 -mt-1 mb-1.5 relative z-10">
          <button
            onClick={() => setView('profile')}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] cursor-pointer"
            style={{ background: `${C.vip}18`, color: C.vip, border: `1px solid ${C.vip}30` }}
          >
            未登录 — 点击登录网易云
          </button>
        </div>
      )}
      {cfg.source === 'kugou' && !cfg.kugouCookie && (
        <div className="px-5 -mt-1 mb-1.5 relative z-10">
          <button
            onClick={() => setView('profile')}
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] cursor-pointer"
            style={{ background: `${C.vip}18`, color: C.vip, border: `1px solid ${C.vip}30` }}
          >
            未登录 — 点击登录酷狗
          </button>
        </div>
      )}
```

- [ ] **Step 4: 诊断按钮 onClick（513-528 行）整体替换**

```tsx
              onClick={async () => {
                const lines: string[] = [];
                const isKg = cfg.source === 'kugou';
                const ck = isKg ? (cfg.kugouCookie || '').trim() : normalizeCookie(cfg.cookie);
                lines.push(`Worker: ${effectiveWorkerUrl}${followsCentral ? '（跟随中心）' : '（音乐单独设的）'}`);
                lines.push(`音源: ${isKg ? '酷狗概念版' : '网易云'}`);
                lines.push(`Cookie: ${ck ? ck.slice(0, 18) + '...(' + ck.length + 'c)' : '(未填)'}`);
                try {
                  const res = await fetch(
                    `${effectiveWorkerUrl}${isKg ? '/kugou/search' : '/netease/search'}`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', ...(ck ? (isKg ? { 'X-Kugou-Cookie': ck } : { 'X-Netease-Cookie': ck }) : {}) },
                      body: JSON.stringify(isKg ? { keywords: '晴天', pagesize: 3 } : { keyword: '晴天', limit: 3 }),
                    },
                  );
                  lines.push(`HTTP ${res.status}`);
                  const txt = await res.text(); lines.push(txt.slice(0, 800));
                  try {
                    const j = JSON.parse(txt);
                    if (isKg) lines.push(`---\nstatus=${j.status}  lists=${j?.data?.lists?.length ?? 'N/A'}`);
                    else lines.push(`---\ncode=${j.code}  songs=${j?.result?.songs?.length ?? 'N/A'}`);
                  } catch {}
                } catch (e: any) { lines.push(`异常: ${e.message}`); }
                alert(lines.join('\n'));
              }}
```

- [ ] **Step 5: 验证**

Run: `corepack pnpm@9.15.9 exec tsc --noEmit`
Expected: MusicApp.tsx 零命中
Run: `corepack pnpm@9.15.9 vitest run utils/`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add utils/kugouCore.ts utils/kugouCore.test.ts context/MusicContext.tsx apps/MusicApp.tsx
git commit -m "feat(music): kugou source core - types, api, search and playback"
```

---

### Task 5: 设置页音源切换 + 登录态卡片分源

**Files:**
- Modify: `apps/MusicApp.tsx`（renderSettings 450-545 内三处）

**Interfaces:**
- Consumes: `cfg.source`/`cfg.kugouCookie`/`setDraft`（Task 3 的类型扩展）。

- [ ] **Step 1: 「音源」卡片** — 插在「服务地址」卡片（463 行 `<div className="rounded-2xl p-3.5 shizuku-glass" ...>`）之前：

```tsx
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.primary} delay={0} /> 音源
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(['kugou', 'netease'] as const).map(src => (
                <button key={src} onClick={() => setDraft({ source: src })}
                  className="py-2 rounded-xl text-[10px] transition-all"
                  style={{
                    background: (cfg.source === src) ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : C.glass,
                    color: (cfg.source === src) ? 'white' : C.muted,
                    border: (cfg.source === src) ? '1px solid transparent' : `1px solid rgba(255,255,255,0.3)`,
                    boxShadow: (cfg.source === src) ? `0 2px 12px ${C.glow}30` : 'none',
                    backdropFilter: 'blur(8px)',
                  }}
                >{src === 'kugou' ? '酷狗概念版' : '网易云'}</button>
              ))}
            </div>
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              {cfg.source === 'kugou' ? '默认酷狗概念版 · 网易云保留可切换' : '已切回网易云'}
            </div>
          </div>
```

- [ ] **Step 2: Cookie 卡片分源（480-490 行）整体替换**

```tsx
          <div className="rounded-2xl p-3.5 shizuku-glass" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
            <div className="text-[10px] mb-2 tracking-wider flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={6} color={C.sakura} delay={0.5} /> {cfg.source === 'kugou' ? '酷狗登录态' : '会员 Cookie'}
            </div>
            <textarea className="w-full rounded-xl px-3 py-2 outline-none text-[10px] shizuku-glass" rows={3}
              value={cfg.source === 'kugou' ? (cfg.kugouCookie || '') : cfg.cookie}
              onChange={e => setDraft(cfg.source === 'kugou' ? { kugouCookie: e.target.value } : { cookie: e.target.value })}
              placeholder={cfg.source === 'kugou'
                ? 'token=..;userid=..;dfid=..;auth=..（我的页扫码 / 验证码登录自动填入）'
                : 'MUSIC_U=xxx 或直接粘贴值...'}
              style={{ color: C.text, fontFamily: 'monospace', resize: 'none' }} />
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              {cfg.source === 'kugou'
                ? '在「我的」页面里扫码 / 手机验证码登录酷狗，自动填入登录态'
                : '也可以在「我的」页面里扫码 / 手机号登录，自动填入 cookie'}
            </div>
          </div>
```

- [ ] **Step 3: 音质提示分源（509 行）替换**

```tsx
            <div className="text-[9px] mt-1.5 italic" style={{ color: C.faint }}>
              {cfg.source === 'kugou' ? 'lossless / hires 需要酷狗 VIP 权益' : 'lossless / hires 需要黑胶 SVIP'}
            </div>
```

- [ ] **Step 4: 验证** — `corepack pnpm@9.15.9 exec tsc --noEmit`，MusicApp.tsx 零命中。

---

### Task 6: KugouLoginPanel

**Files:**
- Create: `apps/music/KugouLoginPanel.tsx`

**Interfaces:**
- Consumes: `kugouApi`（Task 3：loginQrKey/loginQrCreate/loginQrCheck/captchaSent/loginCellphone/registerDev/userVerify）、`composeKugouCookie`/`pickKugouField`（Task 2）、MusicUI 的 `C/Sparkle/MizuHeader/BokehBg`。
- Produces: `KugouLoginPanel: React.FC<{ onBack: () => void; onLoggedIn: (kugouCookie: string) => void }>`（Task 7 挂载）。

- [ ] **Step 1: 写完整组件**（结构与样式沿用 NeteaseLoginPanel.tsx 同款：MizuHeader + 圆形分段切换 + shizuku-glass 卡片 + w-48 h-48 二维码卡 + 60s 冷却验证码）

```tsx
/**
 * 酷狗概念版登录面板
 * - 扫码登录 (/login/qr/key → /login/qr/create → /login/qr/check 轮询, status=4 返回 token)
 * - 手机验证码登录 (/captcha/sent → /login/cellphone)
 * 登录成功后串 /register/dev(拿 dfid) + /user/verify(拿 auth)，拼成 kugouCookie 存进配置。
 * 多登录态并存：在这登录不会把手机上的概念版挤下线（设备管理是独立的显式接口）。
 * 注意：必须用酷狗概念版 App 扫码（worker 上游 platform=lite，token 与标准版不通用）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, kugouApi } from '../../context/MusicContext';
import { composeKugouCookie, pickKugouField } from '../../utils/kugouCore';
import { C, Sparkle, MizuHeader, BokehBg } from './MusicUI';

type Mode = 'qr' | 'phone';

interface Props {
  onBack: () => void;
  onLoggedIn: (kugouCookie: string) => void;
}

const KugouLoginPanel: React.FC<Props> = ({ onBack, onLoggedIn }) => {
  const { addToast } = useOS();
  const { cfg } = useMusic();
  const [mode, setMode] = useState<Mode>('qr');

  /* ── 登录收尾：register/dev 拿 dfid → user/verify 拿 auth → 拼 kugouCookie ── */
  const postLogin = useCallback(async (token: string, userid: string) => {
    let dfid = '';
    let auth = '';
    const baseCookie = composeKugouCookie({ token, userid });
    try {
      const reg = await kugouApi.registerDev({ ...cfg, kugouCookie: baseCookie });
      dfid = pickKugouField(reg, 'dfid');
    } catch { /* 拿不到就留空，song/url 的 merge 接口会自动生成随机 dfid */ }
    try {
      const verify = await kugouApi.userVerify({ ...cfg, kugouCookie: composeKugouCookie({ token, userid, dfid }) });
      auth = pickKugouField(verify, 'auth');
    } catch { /* 拿不到 auth 只影响 VIP 音质，免费歌不受影响 */ }
    return composeKugouCookie({ token, userid, dfid, auth });
  }, [cfg]);

  /* ── 扫码 ── */
  const [qrImg, setQrImg] = useState('');
  const [qrStatus, setQrStatus] = useState<'idle' | 'waiting' | 'scanned' | 'expired' | 'done'>('idle');
  const pollRef = useRef<number | null>(null);
  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const startQr = useCallback(async () => {
    stopPoll();
    setQrStatus('waiting');
    setQrImg('');
    try {
      // 探针实测（见本计划探针记录）：/login/qr/key 直接返回 key + 渲染好的二维码图，无需再调 create
      const keyRes = await kugouApi.loginQrKey(cfg);
      const key = pickKugouField(keyRes, 'qrcode', 'key');
      if (!key) throw new Error('无法获取 key');
      const img = keyRes?.data?.qrcode_img || pickKugouField(keyRes, 'qrcode_img', 'qrimg', 'image');
      if (!img) throw new Error('无法生成二维码');
      setQrImg(img.startsWith('data:') ? img : `data:image/png;base64,${img}`);

      pollRef.current = window.setInterval(async () => {
        try {
          const r = await kugouApi.loginQrCheck(cfg, key);
          const code = Number(r?.data?.status ?? r?.status ?? -1);
          if (code === 0) { setQrStatus('expired'); stopPoll(); }
          else if (code === 1) { setQrStatus('waiting'); }
          else if (code === 2) { setQrStatus('scanned'); }
          else if (code === 4) {
            stopPoll();
            setQrStatus('done');
            const token = pickKugouField(r, 'token');
            const userid = pickKugouField(r, 'userid');
            if (!token) { addToast('登录信息没拿全，请重试。', 'error'); return; }
            onLoggedIn(await postLogin(token, userid));
          }
        } catch { /* transient — 下次再试 */ }
      }, 2500);
    } catch (e: any) {
      setQrStatus('idle');
      addToast(`扫码失败：${e.message}`, 'error');
    }
  }, [cfg, addToast, onLoggedIn, postLogin]);

  useEffect(() => {
    if (mode === 'qr' && qrStatus === 'idle') startQr();
    return () => { stopPoll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* ── 手机验证码 ── */
  const [phone, setPhone] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCaptcha = useCallback(async () => {
    if (!/^\d{11}$/.test(phone)) { addToast('请输入 11 位手机号', 'error'); return; }
    setSending(true);
    try {
      await kugouApi.captchaSent(cfg, phone);
      addToast('验证码已发送', 'success');
      setCooldown(60);
    } catch (e: any) {
      addToast(`发送失败：${e.message}`, 'error');
    } finally {
      setSending(false);
    }
  }, [phone, cfg, addToast]);

  const doLogin = useCallback(async () => {
    if (!/^\d{11}$/.test(phone) || !captcha.trim()) { addToast('手机号和验证码都要填', 'error'); return; }
    setLoggingIn(true);
    try {
      const r = await kugouApi.loginCellphone(cfg, phone, captcha.trim());
      const token = pickKugouField(r, 'token');
      const userid = pickKugouField(r, 'userid');
      if (!token) throw new Error('登录响应里没有 token');
      onLoggedIn(await postLogin(token, userid));
    } catch (e: any) {
      addToast(`登录失败：${e.message}`, 'error');
    } finally {
      setLoggingIn(false);
    }
  }, [phone, captcha, cfg, addToast, onLoggedIn, postLogin]);

  const statusText: Record<string, string> = {
    idle: '准备中...', waiting: '请用酷狗概念版 App 扫描上方二维码',
    scanned: '已扫描，请在手机上确认', expired: '二维码已过期，请刷新',
    done: '登录中...',
  };

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader title="登录酷狗" onBack={onBack} />

      {/* Mode switcher */}
      <div className="mx-4 mt-3 flex items-center gap-1 shizuku-glass rounded-full p-1 relative z-10">
        {([
          { k: 'qr' as const, label: '扫码' },
          { k: 'phone' as const, label: '手机号' },
        ]).map(t => (
          <button key={t.k} onClick={() => setMode(t.k)}
            className="flex-1 py-1.5 rounded-full text-[11px] tracking-wider transition-all"
            style={{
              background: mode === t.k ? `linear-gradient(135deg, ${C.primary}, ${C.accent})` : 'transparent',
              color: mode === t.k ? 'white' : C.muted,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 relative z-10 shizuku-scrollbar">
        {/* ── 扫码 ── */}
        {mode === 'qr' && (
          <div className="flex flex-col items-center">
            <div className="relative rounded-3xl p-4 shizuku-glass-strong"
              style={{ boxShadow: `0 8px 40px ${C.glow}20` }}>
              {qrImg ? (
                <img src={qrImg} alt="qr" className="w-48 h-48 rounded-xl" />
              ) : (
                <div className="w-48 h-48 rounded-xl flex items-center justify-center"
                  style={{ background: C.glass }}>
                  <span className="w-5 h-5 border-2 rounded-full animate-spin"
                    style={{ borderColor: `${C.faint}40`, borderTopColor: C.primary }} />
                </div>
              )}
              <div className="absolute -top-1 -right-1"><Sparkle size={12} color={C.glow} delay={0} /></div>
              <div className="absolute -bottom-1 -left-1"><Sparkle size={10} color={C.sakura} delay={0.7} /></div>
            </div>
            <div className="mt-4 text-center">
              <div className="text-[11px] tracking-wide" style={{ color: C.primary }}>
                {statusText[qrStatus]}
              </div>
              {qrStatus === 'expired' && (
                <button onClick={startQr}
                  className="mt-3 px-4 py-1.5 rounded-full text-[10px] text-white"
                  style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
                  刷新二维码
                </button>
              )}
              <div className="text-[9px] mt-2 italic max-w-[220px] mx-auto" style={{ color: C.faint }}>
                打开酷狗概念版 App → 我的 → 右上角扫一扫
              </div>
            </div>
          </div>
        )}

        {/* ── 手机号 ── */}
        {mode === 'phone' && (
          <div className="space-y-3 max-w-[320px] mx-auto">
            <div className="rounded-2xl p-3 shizuku-glass">
              <div className="text-[10px] mb-1.5 tracking-wider" style={{ color: C.muted }}>手机号 (仅中国)</div>
              <input
                className="w-full rounded-xl px-3 py-2 outline-none text-sm shizuku-glass"
                style={{ color: C.text }}
                placeholder="13800138000"
                value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                inputMode="numeric"
              />
            </div>
            <div className="rounded-2xl p-3 shizuku-glass">
              <div className="text-[10px] mb-1.5 tracking-wider flex justify-between" style={{ color: C.muted }}>
                <span>验证码</span>
                <button
                  onClick={sendCaptcha}
                  disabled={sending || cooldown > 0}
                  className="text-[10px] disabled:opacity-40"
                  style={{ color: C.accent }}
                >
                  {sending ? '发送中...' : cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
                </button>
              </div>
              <input
                className="w-full rounded-xl px-3 py-2 outline-none text-sm shizuku-glass tracking-widest"
                style={{ color: C.text }}
                placeholder="6 位验证码"
                value={captcha} onChange={e => setCaptcha(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
              />
            </div>
            <button
              onClick={doLogin}
              disabled={loggingIn}
              className="w-full py-3 rounded-2xl text-sm text-white tracking-wider relative overflow-hidden disabled:opacity-60"
              style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})`, boxShadow: `0 3px 18px ${C.glow}30` }}
            >
              <span className="relative z-10">{loggingIn ? '登录中...' : '登录'}</span>
            </button>
            <div className="text-[9px] text-center italic" style={{ color: C.faint }}>
              多登录态并存，登录这里不会把你手机上的概念版挤下线
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default KugouLoginPanel;
```

- [ ] **Step 2: 验证** — `corepack pnpm@9.15.9 exec tsc --noEmit`，KugouLoginPanel.tsx 零命中。

---

### Task 7: KugouProfilePage + profile 分发 + 响应校准

**Files:**
- Create: `apps/music/KugouProfilePage.tsx`
- Modify: `apps/MusicApp.tsx`（import 区加 KugouProfilePage、552-560 分发）

**Interfaces:**
- Consumes: `kugouApi`（userDetail/userVipDetail/userPlaylist/playlistTrackAllNew/everydayRecommend/lastestSongsListen）、`mapKugouSearchItem`、`KugouLoginPanel`（Task 6）、MusicUI 的 `C/Sparkle/MizuHeader/BokehBg/MiniPlayer/SongRow`、`toHttps`。
- Produces: `KugouProfilePage: React.FC<{ onBack: () => void; onOpenPlayer: () => void; onOpenSearch?: () => void; onOpenSettings?: () => void; onVisitChar?: (charId: string) => void }>`（props 与 NeteaseProfilePage 完全同签名，MusicApp 分发处零适配）。

- [ ] **Step 1: 写完整页面**（未登录 → KugouLoginPanel；已登录 → 用户卡 + 我喜欢 + 每日推荐 + 我的歌单 + 最近在听；SongRow 必填 props：name/artists/album/albumPic/duration(string)/isVip/isActive/onClick；MiniPlayer 必填 props：name/artists/albumPic/playing/onTap/onPrev/onToggle/onNext）

```tsx
/**
 * 酷狗概念版「我的」主页
 * - 未登录: KugouLoginPanel（扫码 / 手机验证码）
 * - 已登录: 用户信息 + 我喜欢(特殊歌单) + 每日推荐 + 我的歌单(展开拉曲目) + 最近在听
 * 响应字段用多 key 兜底（KuGouMusicApi 各接口形态不一）；首次真机登录后按实际响应校准
 * mapKugouPlaylistItem / 列表项取数行（见本文件 CALIBRATE 注释）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { useMusic, kugouApi, toHttps, Song } from '../../context/MusicContext';
import { mapKugouSearchItem } from '../../utils/kugouCore';
import {
  C, Sparkle, MizuHeader, BokehBg, MiniPlayer, SongRow,
} from './MusicUI';
import { MagnifyingGlass, Gear } from '@phosphor-icons/react';
import KugouLoginPanel from './KugouLoginPanel';

interface Props {
  onBack: () => void;
  onOpenPlayer: () => void;
  onOpenSearch?: () => void;
  onOpenSettings?: () => void;
  onVisitChar?: (charId: string) => void;
}

interface KugouPlaylist {
  listid: string;
  name: string;
  pic: string;
  count: number;
}

/** CALIBRATE: /user/playlist 列表项 → KugouPlaylist（首次真机登录后按实际响应校准 key） */
const mapKugouPlaylistItem = (it: any): KugouPlaylist => ({
  listid: String(it?.listid || it?.id || it?.global_collection_id || ''),
  name: it?.name || it?.specialname || '',
  pic: it?.pic || it?.picurl || it?.imgurl || it?.img || '',
  count: Number(it?.count || it?.trackcount || it?.sourcecount || 0),
});

/** CALIBRATE: 各列表端点的歌曲数组取数（info/lists/songs/data 逐一兜底） */
const pickSongArray = (r: any): any[] =>
  r?.data?.info || r?.data?.lists || r?.data?.songs || (Array.isArray(r?.data) ? r.data : []) || [];

const toSongRows = (arr: any[]): Song[] =>
  arr
    .map((it: any) => mapKugouSearchItem(it?.song || it))
    .filter((s: Song) => s.hash)
    .map((s: Song) => ({ ...s, albumPic: toHttps(s.albumPic) }));

const KugouProfilePage: React.FC<Props> = ({ onBack, onOpenPlayer, onOpenSearch, onOpenSettings }) => {
  const { addToast } = useOS();
  const { cfg, setCfg, current, playing, playSong, togglePlay, nextSong, prevSong } = useMusic();

  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('');
  const [isVipUser, setIsVipUser] = useState(false);
  const [playlists, setPlaylists] = useState<KugouPlaylist[]>([]);
  const [likes, setLikes] = useState<KugouPlaylist | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([]);
  const [everydaySongs, setEverydaySongs] = useState<Song[]>([]);
  const [recentSongs, setRecentSongs] = useState<Song[]>([]);
  const [fmSongs, setFmSongs] = useState<Song[]>([]);
  const [loadingFm, setLoadingFm] = useState(false);
  const [loading, setLoading] = useState(false);

  // 私人 FM 是随机接口，不进并行 reload，按钮触发拉取
  const loadFm = useCallback(async () => {
    setLoadingFm(true);
    try {
      const r = await kugouApi.personalFm(cfg);
      const songs = toSongRows(pickSongArray(r));
      setFmSongs(songs);
      if (!songs.length) addToast('猜你喜欢暂时没有数据', 'info');
    } catch (e: any) {
      addToast(`FM 加载失败：${e.message}`, 'error');
    } finally {
      setLoadingFm(false);
    }
  }, [cfg, addToast]);

  const reload = useCallback(async () => {
    if (!cfg.kugouCookie) return;
    setLoading(true);
    try {
      const [detail, vip, pl, everyday, recent] = await Promise.all([
        kugouApi.userDetail(cfg).catch(() => null),
        kugouApi.userVipDetail(cfg).catch(() => null),
        kugouApi.userPlaylist(cfg).catch(() => null),
        kugouApi.everydayRecommend(cfg).catch(() => null),
        kugouApi.lastestSongsListen(cfg).catch(() => null),
      ]);
      setNickname((detail && (detail.data?.nickname || detail.data?.uname || detail.data?.username)) || '酷狗用户');
      setAvatar((detail && (detail.data?.avatar || detail.data?.user_avatar || detail.data?.head)) || '');
      setIsVipUser(!!(vip && (vip.data?.is_vip === 1 || vip.data?.vip_type > 0)));
      const items = (pl?.data?.data || pl?.data?.info || pl?.data?.lists || []).map(mapKugouPlaylistItem);
      const likePl = items.find(p => /我喜欢/.test(p.name)) || null;
      setLikes(likePl);
      setPlaylists(items.filter(p => p.listid && p !== likePl));
      setEverydaySongs(toSongRows(pickSongArray(everyday)));
      setRecentSongs(toSongRows(pickSongArray(recent)));
    } finally {
      setLoading(false);
    }
  }, [cfg]);

  useEffect(() => { reload(); }, [reload]);

  const expandPlaylist = useCallback(async (p: KugouPlaylist) => {
    if (expandedId === p.listid) { setExpandedId(null); return; }
    setExpandedId(p.listid);
    setPlaylistSongs([]);
    try {
      const r = await kugouApi.playlistTrackAllNew(cfg, p.listid, 1, 100);
      const songs = toSongRows(pickSongArray(r));
      setPlaylistSongs(songs);
      if (!songs.length) addToast('歌单没有可播放的曲目', 'info');
    } catch (e: any) {
      addToast(`歌单加载失败：${e.message}`, 'error');
      setExpandedId(null);
    }
  }, [expandedId, cfg, addToast]);

  const onPlay = useCallback((song: Song) => { playSong(song); }, [playSong]);

  /* ── 未登录：登录面板 ── */
  if (!cfg.kugouCookie) {
    return (
      <KugouLoginPanel
        onBack={onBack}
        onLoggedIn={async (kugouCookie) => {
          setCfg({ ...cfg, kugouCookie });
          addToast('酷狗登录成功', 'success');
        }}
      />
    );
  }

  const renderSongRows = (songs: Song[]) => (
    <div className="px-1">
      {songs.map(s => (
        <SongRow key={`${s.source}:${s.id}:${s.hash}`}
          name={s.name} artists={s.artists} album={s.album} albumPic={s.albumPic}
          duration={fmtDur(s.duration)} isVip={s.fee === 1}
          isActive={current?.id === s.id}
          onClick={() => onPlay(s)} />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full relative"
      style={{ background: `linear-gradient(180deg, #ffffff 0%, ${C.bg} 50%, ${C.bgDeep} 100%)` }}>
      <BokehBg />
      <MizuHeader
        title="我的 · 酷狗"
        onBack={onBack}
        right={
          <div className="flex items-center gap-1">
            {onOpenSearch && (
              <button onClick={onOpenSearch} className="p-1.5 rounded-full transition-all" style={{ color: C.primary }}>
                <MagnifyingGlass size={16} weight="bold" />
              </button>
            )}
            {onOpenSettings && (
              <button onClick={onOpenSettings} className="p-1.5 rounded-full transition-all" style={{ color: C.primary }}>
                <Gear size={16} weight="bold" />
              </button>
            )}
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-3 relative z-10 shizuku-scrollbar">
        {/* 用户卡 */}
        <div className="rounded-2xl p-3.5 shizuku-glass flex items-center gap-3" style={{ boxShadow: `0 2px 16px ${C.glow}08` }}>
          {avatar
            ? <img src={toHttps(avatar)} alt="" className="w-12 h-12 rounded-full object-cover" />
            : <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${C.primary}, ${C.accent})` }}>
                <Sparkle size={18} color="white" delay={0} />
              </div>}
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate" style={{ color: C.text }}>{nickname}</div>
            <div className="text-[10px] mt-0.5" style={{ color: C.muted }}>
              {isVipUser ? '概念版 VIP' : '免费账户'} · 音质 {cfg.quality}
            </div>
          </div>
        </div>

        {/* 我喜欢（酷狗无独立 like 接口，走用户歌单里的特殊歌单；找不到就不显示） */}
        {likes && (
          <div className="mt-4">
            <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={8} color={C.sakura} delay={0} /> 我喜欢 {likes.count ? `(${likes.count})` : ''}
            </div>
            <button onClick={() => expandPlaylist(likes)}
              className="w-full rounded-2xl p-3 shizuku-glass flex items-center gap-3 text-left">
              {likes.pic
                ? <img src={toHttps(likes.pic)} alt="" className="w-10 h-10 rounded-xl object-cover" />
                : <div className="w-10 h-10 rounded-xl" style={{ background: `linear-gradient(135deg, ${C.sakura}40, ${C.lavender}40)` }} />}
              <div className="flex-1 text-xs" style={{ color: C.text }}>{expandedId === likes.listid ? '收起' : '展开播放'}</div>
            </button>
            {expandedId === likes.listid && renderSongRows(playlistSongs)}
          </div>
        )}

        {/* 每日推荐 */}
        {everydaySongs.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={8} color={C.glow} delay={0.3} /> 每日推荐
            </div>
            {renderSongRows(everydaySongs)}
          </div>
        )}

        {/* 我的歌单 */}
        <div className="mt-4">
          <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
            <Sparkle size={8} color={C.lavender} delay={0.6} /> 我的歌单 {playlists.length ? `(${playlists.length})` : ''}
          </div>
          {playlists.map(p => (
            <div key={p.listid}>
              <button onClick={() => expandPlaylist(p)}
                className="w-full rounded-2xl p-3 mb-1.5 shizuku-glass flex items-center gap-3 text-left">
                {p.pic
                  ? <img src={toHttps(p.pic)} alt="" className="w-10 h-10 rounded-xl object-cover" />
                  : <div className="w-10 h-10 rounded-xl" style={{ background: C.glass }} />}
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate" style={{ color: C.text }}>{p.name || '未命名歌单'}</div>
                  <div className="text-[9px] mt-0.5" style={{ color: C.faint }}>{p.count || ''} 首</div>
                </div>
                <div className="text-[10px]" style={{ color: C.muted }}>{expandedId === p.listid ? '收起' : '展开'}</div>
              </button>
              {expandedId === p.listid && renderSongRows(playlistSongs)}
            </div>
          ))}
          {!playlists.length && !loading && (
            <div className="text-[10px] italic px-1" style={{ color: C.faint }}>还没有歌单</div>
          )}
        </div>

        {/* 私人 FM（猜你喜欢） */}
        <div className="mt-4">
          <button onClick={loadFm} disabled={loadingFm}
            className="w-full rounded-2xl p-3 shizuku-glass flex items-center gap-3 text-left disabled:opacity-60">
            <Sparkle size={16} color={C.lavender} delay={0} />
            <div className="flex-1 text-xs" style={{ color: C.text }}>
              {loadingFm ? '加载中...' : '私人 FM · 猜你喜欢'}
            </div>
            <div className="text-[10px]" style={{ color: C.muted }}>{fmSongs.length ? '刷新' : '开启'}</div>
          </button>
          {fmSongs.length > 0 && renderSongRows(fmSongs)}
        </div>

        {/* 最近在听 */}
        {recentSongs.length > 0 && (
          <div className="mt-4">
            <div className="text-[11px] tracking-wider mb-1.5 flex items-center gap-1.5" style={{ color: C.muted }}>
              <Sparkle size={8} color={C.sakura} delay={0.9} /> 最近在听
            </div>
            {renderSongRows(recentSongs)}
          </div>
        )}
      </div>

      {current && (
        <MiniPlayer
          name={current.name} artists={current.artists} albumPic={current.albumPic}
          playing={playing}
          onTap={onOpenPlayer} onPrev={prevSong} onToggle={togglePlay} onNext={nextSong}
        />
      )}
    </div>
  );
};

const fmtDur = (s: number): string => {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
};

export default KugouProfilePage;
```

  注意：写入时上面代码已含修正后的 `setExpandedId(null)`；执行时如仍有笔误以正确拼写为准。

- [ ] **Step 2: MusicApp 分发**

  import 区（Task 4 已加的两个 import 后）加：`import KugouProfilePage from './music/KugouProfilePage';`
  552-560 行替换为：

```tsx
      {view === 'profile' && (cfg.source === 'kugou' ? (
        <KugouProfilePage
          onBack={closeApp}
          onOpenPlayer={() => setView('player')}
          onOpenSearch={() => setView('search')}
          onOpenSettings={() => setView('settings')}
          onVisitChar={id => { setVisitCharId(id); setView('visit_char'); }}
        />
      ) : (
        <NeteaseProfilePage
          onBack={closeApp}
          onOpenPlayer={() => setView('player')}
          onOpenSearch={() => setView('search')}
          onOpenSettings={() => setView('settings')}
          onVisitChar={id => { setVisitCharId(id); setView('visit_char'); }}
        />
      ))}
```

- [ ] **Step 3: 验证（tsc + 全测试）**

Run: `corepack pnpm@9.15.9 exec tsc --noEmit`
Expected: KugouProfilePage.tsx / MusicApp.tsx 零命中
Run: `corepack pnpm@9.15.9 vitest run`
Expected: 全量绿

- [ ] **Step 4: 提交**

```bash
git add apps/music/KugouLoginPanel.tsx apps/music/KugouProfilePage.tsx apps/MusicApp.tsx
git commit -m "feat(music): kugou login panel and profile page with source switch"
```

- [ ] **Step 5: 真机响应校准（需要用户先在真机完成一次酷狗登录）**

  用户操作：真机打开音乐 App → 我的 → 登录酷狗（扫码）。
  agent 操作：让用户从浏览器 DevTools（或诊断按钮全文输出）抓 4 个响应 JSON：`/kugou/user/playlist`、`/kugou/playlist/track/all/new`、`/kugou/everyday/recommend`、`/kugou/lastest/songs/listen`。对照 KugouProfilePage 的两处 CALIBRATE 注释核对 key：列表项字段名不同就同步改 `mapKugouPlaylistItem`/`pickSongArray` 和对应的兜底 key；改动后重跑 `corepack pnpm@9.15.9 vitest run utils/kugouCore.test.ts` + tsc。若搜索形态在 Task 0 因 152 未校准，此时一并抓 `/kugou/search` 响应校准 `mapKugouSearchItem`（含 fixture 更新）。
  完成判据：真机「我喜欢/歌单/每日推荐/最近在听/私人FM」均能出数据且点击可播放、歌词滚动。

---

### Task 8: 文档 + 全量门禁 + 部署核对单

**Files:**
- Modify: `notes/music-app.md`、`notes/ethernet-branch-context.md`、`README.md`

- [ ] **Step 1: `notes/music-app.md` 末尾加「酷狗概念版来源」段**（链路图 + /kugou 契约 + KuGouMusicApi 部署要点 platform=lite + 152/dfid 限制 + 概念版 token 说明）

- [ ] **Step 2: `notes/ethernet-branch-context.md` 加两条事实**：①用户自建 CF Worker 地址 `https://sully-proxy.plasmavendorlia.workers.dev`（跑 ethernet 版 worker/index.js，2026-09-08 探测确认）；②酷狗概念版来源落地记录（spec/plan 路径 + 版本号若有提升）。

- [ ] **Step 3: `README.md` 功能表音乐一行**改为「接网易云 API + 酷狗概念版 API（自部署 KuGouMusicApi），搜歌 / 听歌 / 看歌词 / 歌单 / 每日推荐」。

- [ ] **Step 4: 全量门禁**

Run: `corepack pnpm@9.15.9 vitest run` → 全量绿
Run: `corepack pnpm@9.15.9 exec tsc --noEmit` → 触碰文件（worker/index.js、context/MusicContext.tsx、apps/MusicApp.tsx、apps/music/Kugou*.tsx、utils/kugouCore*.ts）零命中
Run: `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts` → 绿
字节扫 U+FFFD（python 扫本次触碰文件）→ 归零

- [ ] **Step 5: 提交文档**

```bash
git add notes/music-app.md notes/ethernet-branch-context.md README.md
git commit -m "docs: kugou music source notes and worker address record"
```

- [ ] **Step 6: 部署核对单（用户手工，逐项打勾）**

  1. CF 面板 → sully-proxy Worker → Settings → Variables：加 `KUGOU_UPSTREAMS` = Task 0 的 Vercel 地址
  2. 部署更新后的 worker/index.js（CF 面板粘贴，或 2026-09-07 用过的 CF API 通道）
  3. 探针：`Invoke-RestMethod -Method POST -ContentType application/json "https://sully-proxy.plasmavendorlia.workers.dev/kugou/search" -Body '{"keywords":"晴天","pagesize":3}'` → 期望 JSON 返回（未登录可能是 error 152，属预期；带登录态 header 后应返回 status:1 + lists）
  4. 真机：手机 设置 → 网络代理 = `https://sully-proxy.plasmavendorlia.workers.dev`；音乐 齿轮 → 服务地址留空
  5. 真机全链路：音源默认酷狗 → 登录扫码（概念版 App）→ 搜歌播放歌词 → 我喜欢/歌单/每日推荐/最近在听 → 诊断按钮（酷狗）→ 切回网易云搜「晴天」播放回归 → 网易云登录态/歌单不受影响

## 真机校准记录（2026-09-18 bug 修复：登录成功但我的页全空）

**Bug A（前端 cookie 拼接空格）**：`composeKugouCookie` 用 `; ` 带空格拼接，上游 `cookieToJson` 不 trim → ` userid`/` dfid` 键失配 → 所有登录态接口失败。对照实验：带空格 cookie 走 502 / 无空格 200。修复：`join(';')` 无空格拼接 + `_raw` 读入时 `\s*;\s*` 归一化（老登录态免重扫）。

**Bug B（Vercel 冷启动设备指纹漂移 + 播放 URL 20028「需要验证」）**：上游 server.js 的 `ensureCookie` 中间件每实例随机生成 guid→mid/webgl 等设备指纹；登录时 token 与当时 mid 绑定，后续请求落别的实例 mid 漂移 → 20010/20018/20028（`generateSimulate(mid,userid,dfid,webglHash)` 挑战过不了）。修复（零代码）：Vercel 项目 `kugou-music-api`（prj_pq05）加 env（production）：`KUGOU_API_GUID`=20cadc29-942b-4195-8ce0-4400c5c51bb3、`KUGOU_API_DEV`=SULLYOSKGDEV01、`KUGOU_API_MAC`=02:00:00:00:00:00、`KUGOU_API_WEBGL`=9102984751029348571 → redeploy。之后登录态（旧 token 仍有效）全线 200：verify(detail/playlist/search/track/song-url)。
  - GUID/DEV/MAC/WEBGL 值长期不变；用户重登录换来 auth 后即可开 VIP 音质。

**字段校准结论（均已落实代码 + fixture）**：- 搜索项：`FileHash/SongName/SingerName/AlbumName/AlbumID/FileName` ✓；`MixSongID` 大写 M、`Audioid`/`audio_id` 兜底；无 Image → `trans_param.union_cover`（`{size}`→480）；`Price>0` 即 VIP 角标
- track/all 项：`hash/name(.mp3 后缀要剥)/timelen(毫秒)/singerinfo[]/albuminfo.name/cover/audio_id/mixsongid`
- everyday/fm 项：`song_list[]`，`songname/author_name/album_name/hash/album_audio_id/mixsongid`
- lastest：`data.songs[]`
- 歌单项：listid/name/pic/count/is_def（我喜欢 =「默认收藏」is_def=1）
- user/detail：nickname/pic 直读；user/vip/detail：is_vip/vip_type（busi_vip 是过期赠 VIP，不看）
- search/lyric：**candidates 在顶层**（不在 data 内），kugouApi.lyric 已改
- song/url：**url/backupUrl 在顶层数组**（取首个），playSong 已改 first()
- login/qr/key 一步返回 `data.qrcode`(key) + `data.qrcode_img`(data URI)；check 状态 `data.status`（0/1/2/4）

触碰文件：`utils/kugouCore.ts(+test)`、`context/MusicContext.tsx`、`apps/music/KugouProfilePage.tsx`、`apps/music/KugouLoginPanel.tsx`、本附录。

**播放链路回归（2026-09-18 晚）**：
- 播放失败时 worker 把上游一切失败塌缩成「fetch failed (all sources)」看不出真因 → worker kugou 分支**上游错误透传**（有正文原样回 status+正文）+ 前端 `kugouUrlErrorText` 常见码映射 + 320 换不到自动降 128 重试
- 进一步实锤：`/song/url/auth/merge` 聚合链周期性挂（trackercdngz 35002 / Vercel 层裸 502），而原生 `/song/url` 连续稳定 → `KUGOU_ACTION_REWRITE` 去掉 merge 映射，`song/url` 直通原生模块（顶层 url/backupUrl 数组形态与 merge 一致，前端 readUrl 无需动）
- 线上冒烟：sully-proxy 与 proxy.ethernet-vps.bot.cd 两个入口连续 4 次全部 200 出真实播放地址；worker 已重新部署，两端自动生效
- Vercel env（GUID/DEV/MAC/WEBGL）保留，auth 仍随每次播放现取现验（merge 在前端不再用，但登录态完整保留）
- **最后一环修复**：酷狗音频 CDN（fs.youthandroid*.kugou.com）证书域不匹配、无有效 HTTPS——playSong 禁止 http→https 强转（a.src 原样用 http），全局 onErr toast 带音频错误码；https 页面部署时需另加 worker 音频代理中转，本期不做## 探针记录（Task 0 已完成本地实测，2026-09-08）> 实测环境：本地 `node app.js`（platform=lite，端口 37123，临时目录 `Temp\opencode\kugou-api`）。Vercel 地址待用户部署后填入；上线前 worker 用同一份代码，响应形态一致。

- KuGouMusicApi Vercel 地址：**https://kugou-music-api-chi.vercel.app**（账号 plsvena-1020，项目 kugou-music-api prj_pq050FFBMjy9UEkWA4HGPfwSg0tA，env `platform=lite` @production，2026-09-18 部署验证：register/dev 出 dfid、匿名 search 152、别名稳定）
- `/register/dev` 响应：`{"status":1,"data":{"dfid":"3498Xq0d5pW62a0Nod1YjV82"},"error_code":0}` —— **dfid 在 `data.dfid`**
- `/login/qr/key` 响应：`{"data":{"qrcode":"<key字符串>","qrcode_img":"data:image/png;base64,..."},"status":1,"error_code":0}` —— **一步返回 key（qrcode）与渲染好的二维码图（qrcode_img，自带 data: 前缀），登录面板无需再调 /login/qr/create**
- `/login/qr/check` 响应（未扫时）：`{"data":{"status":1},"status":1,"error_code":0}` —— 状态码在 `data.status`
- 匿名 `/search`（仅 dfid cookie）：**`error_code:152, error_msg:"Parameter Error"`，HTTP 502 包装**；响应结构可见 `data.lists`（空数组）——确认酷狗强制登录态搜索，歌曲列表项字段校准推迟到真机登录后（Task 7 步骤 5）
- 上游本地验证结论：白名单里的端点命名与 KuGouMusicApi 实际一致；`platform=lite` 正常工作
