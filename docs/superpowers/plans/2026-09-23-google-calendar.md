# Google 日历接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google 日历事件、待办、官方假日只读接入：VPS 桥接服务保管 refresh token，设置页一键连接，日历 tab 叠加显示，char 被动感知加主动查询。

**Architecture:** 前端只拿授权 code；`vps-backend/src/google/` 独立桥服务（照抄 xhs 会话桥形状：AES-GCM 加密落盘、token 门、no-store）做 code 换 token、refresh 保管、事件/待办拉取；前端经 `utils/googleBridge.ts` 调桥，token 永不落前端；`worker/index.js` 不新增端点（无状态 worker 无处保管 per-user refresh）。

**Tech Stack:** Node 22（webcrypto AES-GCM）、Google Calendar API v3、Tasks API v1、React（Settings/ScheduleApp 既有形状）、vitest。

**Spec:** `docs/superpowers/specs/2026-09-23-google-calendar-design.md`

## Global Constraints

- 工作树 `feat/google-calendar`，基线 `6b7bc1d5`；所有改动保持未提交，用户明确说可以提交之前不许 `git commit`（多窗口防撞车）。
- 用户本地测试环境是 localhost；联调类验证只要求单测通过加本地可跑说明，不要求线上部署。
- 含中文的文件每次改完做字节级自查（扫 EF BF BD，见各任务收尾步）。
- 单测一律 stub 上游 fetch，不碰真实 Google 账号。
- 只读：本计划不实现任何写事件、勾待办的端点与 UI。

## Review Focus

- 桥的任何响应与日志里出现 refresh token 明文时，合理表现是永不出现（只返回账号 id 加邮箱）。
- refresh 过期或被用户在 Google 侧撤销时，合理表现是设置页状态变红并提示重新授权，日历回落本地数据而不是白屏或转圈。
- 全天事件（`start.date`）与跨时区事件（`start.dateTime` 加 `timeZone`）混排时，合理表现是各归其本地日期格，不串位。
- Google 假日缺失某天时，合理表现是回落 `cnHoliday` 本地表，再缺失返回 null 不打扰（现有行为不变）。
- localhost 没起桥服务时，合理表现是设置页测试按钮报“连不上桥，先起服务”，文案风格照抄 `NotionManager.testConnection` 的不可达分支。

---

## File Structure

- 新建 `utils/googleCalendar.ts`：纯函数（scope、授权 URL、exchange body、事件/待办归一化、假日合并、过期判断），无网络无 secrets。
- 新建 `utils/googleCalendar.test.ts`：Task 1 单测位。
- 新建 `vps-backend/src/google/googleStore.js`：照抄 `vps-backend/src/xhs/sessionStore.js:35-80` 的 AES-GCM 加密落盘（key 换 `GOOGLE_SESSION_KEY`，按账号存 refresh）。
- 新建 `vps-backend/src/google/googleBridge.js`：照抄 `vps-backend/src/xhs/sessionBridge.js:22-60` 的桥形状（token 门、CORS、no-store、sanitize），挂 Google 端点。
- 新建 `vps-backend/src/google/run.js`：照抄 `vps-backend/src/xhs/run.js:1-38`（.env 兜底、起桥、SIGTERM/SIGINT）。
- 新建 `vps-backend/src/google/googleBridge.test.ts`：Task 3 单测位（vitest include 已覆盖 `vps-backend/**/*.test.ts`，见 `vitest.config.ts:19-20`）。
- 新建 `utils/googleBridge.ts`：前端调桥客户端（base URL 解析照抄 `utils/proxyWorker.ts:46-94` 形状，`X-Google-Bridge-Token` 头）。
- 新建 `utils/googleBridge.test.ts`：Task 5 单测位（stub fetch）。
- 改 `vps-backend/config/services.js`：加 `sullyos-google` 条目（端口 8838，`enabled: false`，先不进 run-all，与 xhs 一样走独立进程）。
- 改 `vps-backend/.env.example`：加 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_SESSION_KEY`（64 hex）、`GOOGLE_BRIDGE_TOKEN`、`GOOGLE_BRIDGE_PORT`（默认 8838）。
- 改 `apps/Settings.tsx`：实时感知 Modal 内加 Google 区块（锚点 `apps/Settings.tsx:4445-4483` Notion 区块，飞书区块后、小红书 Lite `4577` 前插入）。
- 改 `utils/backupSecrets.ts`：Google 字段脱敏（锚点 `utils/backupSecrets.ts:39-51`）。
- 改 `apps/ScheduleApp.tsx`：日历 tab 叠加 Google 图层（锚点 `apps/ScheduleApp.tsx:588-657`）。
- 改 `utils/chatPrompts.ts`：加 `googlePromise`（照抄 `utils/chatPrompts.ts:491-524` anniversaryPromise 形状），汇合进 `Promise.all`（锚点 `:690-735`）。
- 改 `utils/agenticTools.ts`：加 `runGoogleCalendarEvents`、`runGoogleTasks` 纯函数并注册进 dispatch（测试进既有 `utils/agenticTools.test.ts` 同目录）。

---

### Task 1：纯函数层 `utils/googleCalendar.ts`

**Files:**
- Create: `utils/googleCalendar.ts`
- Test: `utils/googleCalendar.test.ts`

**Interfaces:**
- Consumes: 无（零依赖纯函数）。
- Produces（后继任务用，签名锁死）:
  - `GOOGLE_SCOPES: string`（三个只读 scope 空格拼接）
  - `GOOGLE_HOLIDAY_CALENDAR_ID = 'zh.china#holiday@group.v.calendar.google.com'`
  - `buildGoogleAuthUrl(args: { clientId: string; redirectUri: string; state: string }): string`
  - `buildTokenExchangeBody(args: { code: string; clientId: string; clientSecret: string; redirectUri: string }): Record<string, string>`
  - `normalizeGoogleEvents(items: any[]): Array<{ dateKey: string; title: string; startText: string; location: string; calendarId: string; source: 'google' }>`
  - `normalizeGoogleTasks(items: any[]): Array<{ title: string; dueKey: string | null; notes: string; status: string }>`
  - `mergeHolidayOverlay(googleName: string | null, cnInfo: { isOffDay: boolean; name: string } | null): { isOffDay: boolean; name: string } | null`
  - `isGoogleTokenExpired(expiresAtMs: number, nowMs?: number): boolean`（提前 60 秒算过期）

- [ ] **Step 1: 先写 failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_SCOPES, buildGoogleAuthUrl, normalizeGoogleEvents,
  normalizeGoogleTasks, mergeHolidayOverlay, isGoogleTokenExpired,
} from './googleCalendar';

describe('googleCalendar pure', () => {
  it('scope 只含三个只读', () => {
    expect(GOOGLE_SCOPES).toContain('calendar.events.readonly');
    expect(GOOGLE_SCOPES).toContain('tasks.readonly');
    expect(GOOGLE_SCOPES).toContain('calendar.events.public.readonly');
    expect(GOOGLE_SCOPES).not.toContain('gmail');
  });
  it('授权 URL 带 client_id/redirect_uri/state/scope', () => {
    const url = buildGoogleAuthUrl({ clientId: 'CID', redirectUri: 'http://localhost:3000/x', state: 'S' });
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(url).toContain('client_id=CID');
    expect(url).toContain('access_type=offline');
  });
  it('全天事件用 start.date，cancelled 跳过', () => {
    const out = normalizeGoogleEvents([
      { id: '1', status: 'confirmed', summary: '中秋', start: { date: '2026-09-25' } },
      { id: '2', status: 'cancelled', summary: '作废', start: { date: '2026-09-25' } },
      { id: '3', status: 'confirmed', summary: '会', start: { dateTime: '2026-09-25T15:00:00+08:00' }, location: '国贸' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ dateKey: '2026-09-25', title: '中秋' });
    expect(out[1]).toMatchObject({ dateKey: '2026-09-25', location: '国贸' });
  });
  it('待办无 due 时 dueKey 为 null', () => {
    const out = normalizeGoogleTasks([{ title: '买机票', status: 'needsAction' }]);
    expect(out[0]).toMatchObject({ title: '买机票', dueKey: null });
  });
  it('假日合并 google 优先，缺失回落 cnHoliday，再缺失 null', () => {
    expect(mergeHolidayOverlay('中秋节', { isOffDay: true, name: '本地' })).toMatchObject({ name: '中秋节' });
    expect(mergeHolidayOverlay(null, { isOffDay: false, name: '补班' })).toMatchObject({ name: '补班' });
    expect(mergeHolidayOverlay(null, null)).toBeNull();
  });
  it('过期提前 60 秒', () => {
    expect(isGoogleTokenExpired(Date.now() + 30_000)).toBe(true);
    expect(isGoogleTokenExpired(Date.now() + 120_000)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run utils/googleCalendar.test.ts`
Expected: FAIL（`googleCalendar.ts` 不存在）。

- [ ] **Step 3: 最小实现**

实现上面签名的全部导出：`GOOGLE_SCOPES` 为 `'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/tasks.readonly https://www.googleapis.com/auth/calendar.events.public.readonly'`；`buildGoogleAuthUrl` 用 `URLSearchParams` 拼 `https://accounts.google.com/o/oauth2/v2/auth`（固定 `response_type=code`、`access_type=offline`、`prompt=consent`）；`normalizeGoogleEvents` 取 `summary/start/location`，全天用 `start.date`、时刻用 `start.dateTime` 前 10 位，跳过 `status === 'cancelled'`；`mergeHolidayOverlay` 按测试的三档回落；`isGoogleTokenExpired` 为 `nowMs >= expiresAtMs - 60_000`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run utils/googleCalendar.test.ts`
Expected: PASS（7 个用例全绿）。

- [ ] **Step 5: 自查，不提交**

确认本任务只新增两个文件（`git status --short` 无其他改动），文件含中文注释则跑字节自查（见 Task 10 Step 1 命令）。保持未提交，报告通过。

---

### Task 2：refresh 保管 `vps-backend/src/google/googleStore.js`

**Files:**
- Create: `vps-backend/src/google/googleStore.js`
- Test: `vps-backend/src/google/googleStore.test.ts`

**Interfaces:**
- Consumes: Task 1（无，其实独立；列出以便顺序）。
- Produces:
  - `createGoogleStore({ sessionKeyHex, filePath }): { save(account: { accountId: string; email: string; refreshToken: string; scope: string }): Promise<{ accountId: string }>; loadRefresh(accountId: string): Promise<string | null>; listAccounts(): Promise<Array<{ accountId: string; email: string; scope: string; updatedAt: number }>>; remove(accountId: string): Promise<void> }`
  - 约束：`listAccounts` 永不返回 refresh；磁盘文件永远是 AES-GCM 密文（照抄 `vps-backend/src/xhs/sessionStore.js:17-28` 的 encrypt/decrypt 与 `:78-80` 的 tmp 写加 `mode: 0o600`）；`sessionKeyHex` 非 64 hex 直接 throw（照抄 `:35-38`）。

- [ ] **Step 1: 先写 failing test**

```ts
import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// @ts-expect-error VPS 纯 JS 服务无类型声明（同 worker/*/worker.test.ts 惯例）
import { createGoogleStore } from './googleStore.js';

const KEY = 'ab'.repeat(32);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gstore-')), 'session.json');

describe('googleStore', () => {
  it('save 后 loadRefresh 拿回原文，listAccounts 不带 refresh', async () => {
    const store = createGoogleStore({ sessionKeyHex: KEY, filePath: tmpFile() });
    await store.save({ accountId: 'a1', email: 'u@x.com', refreshToken: 'REF', scope: 's' });
    expect(await store.loadRefresh('a1')).toBe('REF');
    const list = await store.listAccounts();
    expect(list[0]).toMatchObject({ accountId: 'a1', email: 'u@x.com' });
    expect((list[0] as any).refreshToken).toBeUndefined();
  });
  it('磁盘无明文', async () => {
    const f = tmpFile();
    const store = createGoogleStore({ sessionKeyHex: KEY, filePath: f });
    await store.save({ accountId: 'a1', email: 'u@x.com', refreshToken: 'REF-SECRET', scope: 's' });
    expect(fs.readFileSync(f, 'utf8')).not.toContain('REF-SECRET');
  });
  it('非法 key 直接 throw', () => {
    expect(() => createGoogleStore({ sessionKeyHex: 'zz', filePath: tmpFile() })).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run vps-backend/src/google/googleStore.test.ts`
Expected: FAIL（`googleStore.js` 不存在）。

- [ ] **Step 3: 最小实现**

照抄 `vps-backend/src/xhs/sessionStore.js:1-80`：`importKey/encrypt/decrypt` 原样搬；`save` 把 `{ accountId, email, scope, updatedAt, encryptedRefresh }` 整包加密后经 tmp 文件 `mode: 0o600` 落盘（多账号存为 `{ accounts: { [accountId]: {...} } }`）；`loadRefresh` 解密后只返回 refresh 字符串；`listAccounts` 返回前删掉密文字段；`remove` 删键后重写文件。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run vps-backend/src/google/googleStore.test.ts`
Expected: PASS（3 个用例全绿）。

- [ ] **Step 5: 自查，不提交**

`git status --short` 确认只新增两个文件；字节自查（Task 10 Step 1）。保持未提交，报告通过。

---

### Task 3：桥服务 `googleBridge.js` 加 `run.js`

**Files:**
- Create: `vps-backend/src/google/googleBridge.js`
- Create: `vps-backend/src/google/run.js`
- Test: `vps-backend/src/google/googleBridge.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `createGoogleStore`；Task 1 的 `normalizeGoogleEvents/normalizeGoogleTasks`（桥内归一化后返回前端）。
- Produces:
  - `startGoogleBridge({ port, host, token, store, clientId, clientSecret, redirectUri, fetchImpl? }): { ready: Promise<void>; close(): Promise<void>; port: number }`
  - 端点（全部 JSON、`cache-control: no-store`，照抄 `vps-backend/src/xhs/sessionBridge.js:31-40` 的 finish）：
    - `GET /api/health` → `{ status: 'ok', backend: 'google-bridge' }`（免鉴权，照抄 `:55-57`）
    - `POST /api/accounts/exchange` body `{ code }` → 用 `clientSecret` 调 `https://oauth2.googleapis.com/token`，refresh 存 store，响应只含 `{ accountId, email }`（永不回显 token，Review Focus 第 1 条）
    - `GET /api/accounts` → `store.listAccounts()`
    - `DELETE /api/accounts/:id` → `store.remove(id)`
    - `GET /api/calendars` / `GET /api/events?calendarId&timeMin&timeMax` / `GET /api/tasks?tasklist` → 读 `x-google-account` 头，用 access token（内存缓存，未过期复用；过期用 refresh 换，失败返回 401 `{ error: 'REAUTH_REQUIRED' }`）调 Google，事件/待办经 Task 1 归一化后返回
  - 鉴权：除 health 外要求 `x-google-bridge-token` 精确相等（照抄 `:59` 行起的门）；CORS 预检照抄 `:42-53`（`DEFAULT_CORS_HEADERS` 加 `X-Google-Bridge-Token, X-Google-Account`）；日志 sanitize 照抄 `:16-18` 思路（refresh/access token 全部 `[REDACTED]`）。
  - `run.js` 照抄 `vps-backend/src/xhs/run.js:1-38`：env 文件兜底（变量名前缀 `GOOGLE_`：`GOOGLE_ENV_FILE`、`GOOGLE_SESSION_KEY`、`GOOGLE_SESSION_FILE` 默认 `/var/lib/sullyos-google/session/session.json`、`GOOGLE_BRIDGE_PORT` 默认 `8838`、`GOOGLE_BRIDGE_TOKEN`、`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`），SIGTERM/SIGINT 关闭。

- [ ] **Step 1: 先写 failing test**

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
// @ts-expect-error VPS 纯 JS 服务无类型声明
import { startGoogleBridge } from './googleBridge.js';
// @ts-expect-error VPS 纯 JS 服务无类型声明
import { createGoogleStore } from './googleStore.js';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';

afterEach(() => { vi.restoreAllMocks(); });
const KEY = 'ab'.repeat(32);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gbridge-')), 's.json');
const start = async (routes: Record<string, any> = {}) => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = new URL(String(input));
    const route = routes[`${url.hostname}${url.pathname}`];
    if (!route) throw new Error(`unexpected upstream: ${url}`);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  const store = createGoogleStore({ sessionKeyHex: KEY, filePath: tmpFile() });
  const b = startGoogleBridge({ port: 0, host: '127.0.0.1', token: 'T', store, clientId: 'C', clientSecret: 'S', redirectUri: 'R' });
  await b.ready;
  return b;
};

describe('googleBridge', () => {
  it('health 免鉴权', async () => {
    const b = await start(); const r = await fetch(`http://127.0.0.1:${b.port}/api/health`);
    expect(r.status).toBe(200); await b.close();
  });
  it('无 token 拒绝且响应不含敏感字样', async () => {
    const b = await start();
    const r = await fetch(`http://127.0.0.1:${b.port}/api/accounts`);
    expect(r.status).toBe(401);
    expect(await r.text()).not.toMatch(/refresh|REFRESH/);
    await b.close();
  });
  it('exchange 存 refresh 但响应不回显', async () => {
    const b = await start({
      'oauth2.googleapis.com/token': { body: { access_token: 'A', refresh_token: 'REF', expires_in: 3600 } },
      'www.googleapis.com/oauth2/v2/userinfo': { body: { id: 'g1', email: 'u@x.com' } },
    });
    const r = await fetch(`http://127.0.0.1:${b.port}/api/accounts/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-google-bridge-token': 'T' },
      body: JSON.stringify({ code: 'CODE' }),
    });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.accountId).toBe('g1');
    expect(JSON.stringify(body)).not.toContain('REF');
    await b.close();
  });
});
```

实现注：测试里 `port: 0` 要求实现用 `server.address().port` 回填真实端口；exchange 拿 email 允许调 userinfo（上游 stub 已备）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run vps-backend/src/google/googleBridge.test.ts`
Expected: FAIL（`googleBridge.js` 不存在）。

- [ ] **Step 3: 最小实现**

按 Interfaces 实现 `googleBridge.js` 与 `run.js`。access token 内存缓存形如 `Map<accountId, { token, expiresAtMs }>`；过期判断复用逻辑 `Date.now() >= expiresAtMs - 60_000`（与 Task 1 同口径，不 import 前端模块，后端保持零依赖）；refresh 换 token 失败（上游 400/401）→ 删内存缓存并返回 401 `{ error: 'REAUTH_REQUIRED' }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run vps-backend/src/google/`
Expected: PASS（Task 2 加 Task 3 全部用例绿）。

- [ ] **Step 5: 自查，不提交**

`git status --short` 只新增本任务三个文件；字节自查。保持未提交，报告通过。

---

### Task 4：服务清单与 env 模板

**Files:**
- Modify: `vps-backend/config/services.js`（`services` 数组末尾追加）
- Modify: `vps-backend/.env.example`（追加 GOOGLE 段）

**Interfaces:**
- Consumes: Task 3（端口与变量名锁死：`8838`、`GOOGLE_BRIDGE_TOKEN`、`GOOGLE_SESSION_KEY`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REDIRECT_URI`、`GOOGLE_BRIDGE_PORT`、`GOOGLE_SESSION_FILE`）。
- Produces: 清单条目与模板变量，后继部署任务用。

- [ ] **Step 1: 先占位检查（本任务无单测，用断言命令当测试）**

Run: `rg -n "8838|GOOGLE_" vps-backend/config/services.js vps-backend/.env.example`
Expected: 无输出（确认端口与变量名无冲突；xhs 用 8836、home 用 8837）。

- [ ] **Step 2: 最小修改**

`services.js` 数组末追加（`enabled: false`，先不进 run-all，与 xhs 一样走独立进程，注释写明）：

```js
{
  name: 'sullyos-google',
  port: 8838,
  enabled: false, // Google 日历桥：独立 node 进程（vps-backend/src/google/run.js），暂不进 run-all
  envKeys: [
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
    'GOOGLE_SESSION_KEY', 'GOOGLE_SESSION_FILE',
    'GOOGLE_BRIDGE_TOKEN', 'GOOGLE_BRIDGE_PORT',
  ],
  crons: [],
},
```

`.env.example` 追加：

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/settings/google/callback
GOOGLE_SESSION_KEY=
GOOGLE_BRIDGE_TOKEN=
GOOGLE_BRIDGE_PORT=8838
```

- [ ] **Step 3: 跑断言确认**

Run: `node -e "import('./vps-backend/config/services.js').then(m => { const s = m.getService('sullyos-google'); if (s.port !== 8838 || s.enabled !== false) throw new Error('bad entry'); console.log('services entry ok'); })" && rg -c "GOOGLE_" vps-backend/.env.example`
Expected: 打印 `services entry ok`，计数大于等于 7。

- [ ] **Step 4: 自查，不提交**

只改两个文件；字节自查。保持未提交，报告通过。

---

### Task 5：前端调桥客户端 `utils/googleBridge.ts`

**Files:**
- Create: `utils/googleBridge.ts`
- Test: `utils/googleBridge.test.ts`

**Interfaces:**
- Consumes: Task 3 端点形状；Task 1 `buildGoogleAuthUrl`。
- Produces:
  - `readGoogleBridgeUrl(): string`（`localStorage['aetheros.google.bridgeUrl']`，缺省 `http://127.0.0.1:8838`，照抄 `utils/proxyWorker.ts:46-94` 的读加 fallback 形状）
  - `googleBridgeFetch(path: string, init?: RequestInit): Promise<Response>`（自动拼 base、带 `X-Google-Bridge-Token`（读 `localStorage['aetheros.google.bridgeToken']`）、`X-Google-Account` 由调用方传）
  - `GoogleBridgeClient.testConnection(): Promise<{ success: boolean; message: string }>`（调 `/api/health`，不可达文案照抄 `NotionManager.testConnection` 的“先在浏览器里试试能否直接打开该地址”分支，`utils/realtimeContext.ts:565-600`）

- [ ] **Step 1: 先写 failing test**

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readGoogleBridgeUrl, googleBridgeFetch } from './googleBridge';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('googleBridge client', () => {
  it('缺省指向本地 8838', () => {
    expect(readGoogleBridgeUrl()).toBe('http://127.0.0.1:8838');
  });
  it('透传双 header', async () => {
    localStorage.setItem('aetheros.google.bridgeToken', 'T');
    const seen: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      seen.push([String(input), init?.headers]); return new Response('{}');
    });
    await googleBridgeFetch('/api/accounts', { headers: { 'X-Google-Account': 'g1' } });
    expect(seen[0][0]).toBe('http://127.0.0.1:8838/api/accounts');
    expect(seen[0][1]['X-Google-Bridge-Token']).toBe('T');
    expect(seen[0][1]['X-Google-Account']).toBe('g1');
  });
});
```

注：单测跑在 node 环境，`localStorage` 由 `test-setup.ts` 提供（若没有，先读 `test-setup.ts` 确认再补最小 stub，不改既有逻辑）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run utils/googleBridge.test.ts`
Expected: FAIL（`googleBridge.ts` 不存在）。

- [ ] **Step 3: 最小实现**

按 Interfaces 实现；`testConnection` 的不可达分支文案结构照抄 realtimeContext 那段（含“打不开说明当前网络访问不了它”句式，地址换成桥地址）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run utils/googleBridge.test.ts utils/googleCalendar.test.ts`
Expected: PASS。

- [ ] **Step 5: 自查，不提交**

只新增两个文件；字节自查。保持未提交，报告通过。

---

### Task 6：设置页 Google 区块加脱敏

**Files:**
- Modify: `apps/Settings.tsx`（实时感知 Modal，飞书区块后、小红书 Lite `4577` 前插入 Google 区块；测试函数放 `testNotionApi`（`1901-1914`）旁）
- Modify: `utils/backupSecrets.ts`（`stripRealtimeConfig` 字段表 `39-51` 加 `googleBridgeToken`，或确认 `aetheros.google` 命中 `:91-120` 启发式后只加测试）
- Test: `utils/backupSecrets.test.ts`（若不存在则新建，只断言脱敏；先 `glob utils/backupSecrets*.test.ts` 确认）

**Interfaces:**
- Consumes: Task 5 客户端。
- Produces: 设置页可见的连接、状态、断开；备份永不带出 bridge token。

区块 JSX 照抄 `apps/Settings.tsx:4445-4483` Notion 形状（开关、账号列表、日历勾选、测试按钮、断开按钮、三步教程），差异锁死：无 token 输入框（refresh 永不回显）；「连接 Google」按钮用 `buildGoogleAuthUrl` 生成 URL 新窗口打开，回调 code 交 `POST /api/accounts/exchange`；状态徽标用 `StatusBadge` 加 `probeGoogle`（照抄 `utils/statusPanel.ts:80` 任一 probe 形状，读该文件后模仿）。

- [ ] **Step 1: 读锚点原文**

读 `apps/Settings.tsx:4445-4530`（Notion 全块加飞书块头）、`utils/statusPanel.ts:60-110`（probe 形状）、`utils/backupSecrets.ts:85-120`（启发式规则）。完成判据：能说出 probe 函数签名与启发式命中的键名前缀。

- [ ] **Step 2: 最小修改**

按 Interfaces 改三处。测试按钮逻辑照抄 `testNotionApi`（空值先提示、try/catch 网络错误）；断开按钮调 `DELETE /api/accounts/:id` 后清勾选。

- [ ] **Step 3: 跑相关单测**

Run: `pnpm vitest run utils/backupSecrets.test.ts utils/googleBridge.test.ts`
Expected: PASS（含新增的脱敏断言：含 `aetheros.google.bridgeToken` 的配置导出后该字段被置空）。

- [ ] **Step 4: 自查，不提交**

`git status --short` 只改本任务文件；字节自查（Settings 含中文必查）。保持未提交，报告通过。

---

### Task 7：ScheduleApp 日历叠加

**Files:**
- Modify: `apps/ScheduleApp.tsx`（日历 tab：dots 图层加 Google 色、当选日面板加 Google 事件与待办、假日角标数据源合并）

**Interfaces:**
- Consumes: Task 1 `normalizeGoogleEvents/normalizeGoogleTasks/mergeHolidayOverlay`；Task 5 客户端。
- Produces: 月历上 Google 事件用独立色点（`bg-sky-400`，与纪念日 `dotColors` 区分，`apps/ScheduleApp.tsx:609-615`）；当选日面板出现 Google 事件（时间加标题加地点）与到期待办；假日角标 `getHolidayInfo`（`:632`）调用处改为 `mergeHolidayOverlay(googleHolidayName, cnHInfo)`。

- [ ] **Step 1: 定位当选日面板**

Run: `rg -n "setCalSelected|dayAnnis" apps/ScheduleApp.tsx`
Expected: 看到 `:600` 的 `dayAnnis` 定义与面板渲染位置（记下行号，后面步骤用）。

- [ ] **Step 2: 最小修改**

dots：在 `dotMap` 旁建 `googleDotMap: Map<string, number>`（同 range 拉取当月事件归一化后计数），渲染处与纪念日 dots 并排（纪念日逐 char 色点在上，Google `bg-sky-400` 单点在下，超 3 不截断 Google 点）。
面板：在纪念日列表后加「Google 日程」段（空时不渲染整段，不打扰）；待办按 `dueKey` 过滤当选日。
假日：`:632` 处 `const hInfo = getHolidayInfo(holidayData, key)` 改为合并 Google 官方假日名（当月一次拉取 `GOOGLE_HOLIDAY_CALENDAR_ID` 全天事件建成 `Map<dateKey, name>`）。
数据获取：组件内 `useEffect` 跟 `calCursor` 拉当月（失败静默，保留本地日历；不可用态不弹错）。

- [ ] **Step 3: 跑相关单测**

Run: `pnpm vitest run utils/anniversaryEngine.test.ts utils/googleCalendar.test.ts`
Expected: PASS（本任务无组件单测位——`vitest.config.ts:22` 排除 React 组件；逻辑层已在 Task 1 覆盖）。

- [ ] **Step 4: 自查，不提交**

只改一个文件；字节自查。保持未提交，报告通过。

---

### Task 8：char 被动注入（volatile 槽位）

**Files:**
- Modify: `utils/chatPrompts.ts`（加 `googlePromise`，汇合进 `Promise.all`，stable/volatile 按既有规则落位）
- Modify: `utils/realtimeContext.ts`（`defaultRealtimeConfig`（`:60-74`）加 `googleEnabled` 默认 false；`GoogleManager` 取近期事件/待办，經 Task 5 客户端）
- Test: `utils/chatPrompts.google.test.ts`（先读 `utils/chatPrompts.scheduleClock.test.ts:1-60` 模仿 harness 形状）

**Interfaces:**
- Consumes: Task 1 归一化；Task 5 客户端。
- Produces: volatile 段 `### 【Google 日程 · 近期】`（未来 3 天事件加逾期未完待办，标题加时间，不含正文；`timeAwarenessEnabled === false` 的角色精确钟点抹掉，照抄 `:706-711` 的 includeClock 门）。

`googlePromise` 照抄 `utils/chatPrompts.ts:491-524` anniversaryPromise 形状（含 try/catch 回空字符串、`forFirePack/timelyByWorker` 直接回空照抄 `:542` 门）。

- [ ] **Step 1: 读 harness 形状**

读 `utils/chatPrompts.scheduleClock.test.ts:1-60` 与 `utils/chatPrompts.ts:565-578`。完成判据：能说出单测如何构造 char 加 config 并取 volatile 输出。

- [ ] **Step 2: 先写 failing test**

断言三条：关闭开关（`googleEnabled: false`）输出不含 Google 段；开启且有未来事件时含标题与日期；`timeAwarenessEnabled: false` 时输出不含 `15:00` 类精确钟点（只留日期）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run utils/chatPrompts.google.test.ts`
Expected: FAIL（`googlePromise` 不存在）。

- [ ] **Step 4: 最小实现**

按 Interfaces 改两处。`GoogleManager` 函数签名：`getUpcomingDigest(config, charTz, todayKey): Promise<string>`，内部失败一律回空字符串（不炸整条 prompt，照抄既有各 Promise 的 catch 风格）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run utils/chatPrompts.google.test.ts utils/chatPrompts.scheduleClock.test.ts utils/chatPrompts.test.ts`
Expected: PASS（新旧全绿）。

- [ ] **Step 6: 自查，不提交**

只改本任务文件；字节自查。保持未提交，报告通过。

---

### Task 9：char 主动查（agenticTools 只读工具）

**Files:**
- Modify: `utils/agenticTools.ts`（加 `runGoogleCalendarEvents`、`runGoogleTasks` 纯函数并注册进 dispatch）
- Test: `utils/agenticTools.google.test.ts`（先读 `utils/agenticTools.test.ts:1-80` 模仿 ctx 构造与断言形状）

**Interfaces:**
- Consumes: Task 1 归一化；Task 5 客户端（经 ctx 传入 fetch 替身，保持纯函数层不直接调网络——照抄既有 run* 从 ctx 拿配置与时间的写法）。
- Produces:
  - `runGoogleCalendarEvents(ctx, { timeMin, timeMax, keyword? }): Promise<Array<{ dateKey: string; title: string; startText: string }>>`（keyword 命中标题/地点子串）
  - `runGoogleTasks(ctx, {}): Promise<Array<{ title: string; dueKey: string | null }>>`（只返回未完成）
  - dispatch 新 case 名：`google_calendar_events`、`google_tasks`（大小写与下划线风格先读 dispatch 原文确认，不猜）。

- [ ] **Step 1: 读 dispatch 与测试形状**

Run: `rg -n "dispatchAgenticTool|case '" utils/agenticTools.ts | head -40`（pwsh 用 `Select-Object -First 40`）并读 `utils/agenticTools.test.ts:1-80`。完成判据：说出 dispatch 的 case 命名风格与 ctx 的最小构造字段。

- [ ] **Step 2: 先写 failing test**

断言：正常返回归一化数组；上游 401 时抛可识别错误（含 `REAUTH_REQUIRED`，供上层转“去设置页重新授权”）；keyword 过滤大小写不敏感。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run utils/agenticTools.google.test.ts`
Expected: FAIL（函数不存在）。

- [ ] **Step 4: 最小实现**

按 Interfaces 实现并注册 dispatch。失败一律结构化抛错，不吞错（上层提示依赖错误名）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm vitest run utils/agenticTools.google.test.ts utils/agenticTools.test.ts`
Expected: PASS。

- [ ] **Step 6: 自查，不提交**

只改本任务文件；字节自查。保持未提交，报告通过。

---

### Task 10：收尾验证

**Files:** 无新增，只跑命令。

- [ ] **Step 1: 全仓 U+FFFD 自查**

Run: `python -c "import sys,glob;bad=[f for f in glob.glob('**/*.ts',recursive=True)+glob.glob('**/*.tsx',recursive=True)+glob.glob('**/*.js',recursive=True) if '\ufffd' in open(f,encoding='utf-8',errors='strict').read()];print('BAD:',bad) if bad else print('CLEAN')"`
Expected: `CLEAN`（有 BAD 则按 AGENTS.md 乱码修复套路回溯，不在本任务展开）。

- [ ] **Step 2: 本计划单测全跑**

Run: `pnpm vitest run utils/googleCalendar.test.ts utils/googleBridge.test.ts utils/chatPrompts.google.test.ts utils/agenticTools.google.test.ts vps-backend/src/google/ utils/backupSecrets.test.ts`
Expected: 全部 PASS；若 `backupSecrets.test.ts` 不存在则去掉该项（以 Task 6 实际为准）。

- [ ] **Step 3: 回归相关旧套件**

Run: `pnpm vitest run utils/anniversaryEngine.test.ts utils/busyState.test.ts utils/chatPrompts.scheduleClock.test.ts utils/agenticTools.test.ts`
Expected: 全部 PASS。

- [ ] **Step 4: 状态报告，不提交**

Run: `git status --short`
Expected: 改动全部位于本计划 File Structure 清单内，无计划外文件。报告清单给用户，等用户说提交才提交。
