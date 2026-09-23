# Mastodon MCP Server（VPS）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 VPS 上跑一个只暴露 8 个工具的 Mastodon MCP server（streamable HTTP，端口 8838），小手机经 `?target=` 代理连接，角色/用户按身份发帖、点赞、读公开流。

**Architecture:** 纯 ESM JS 模块（照抄 `vps-backend/src/xhs/` 形态：`run.js` 入口 + `*.js` 逻辑 + `.test.ts` vitest 单测），MCP 官方 TS SDK（stateless streamable HTTP）+ zod 做 schema 与校验，Bearer 鉴权 + 仓库 CORS 预检契约，Mastodon token 只存 VPS 环境变量不下发。

**Tech Stack:** Node >= 20 ESM, `@modelcontextprotocol/sdk`, `zod`, vitest（仓根跑）。

**Spec:** `docs/superpowers/specs/2026-09-23-mastodon-moments-design.md`（§2 工具清单、§2.5 scope、§3 visibility 映射；默认 `private`，永不申请 `write:follows/blocks/mutes`）

## Global Constraints

- 只监听 127.0.0.1，由 Caddy 反代（`vps-backend/deploy/caddy/SullyOS.Caddyfile` 既有 `handle_path` 惯例）。
- 真实密钥只进 VPS `/opt/sullyos/.env`（chmod 600），永不入库；`.env.example` 只加空键。
- `vps-backend` 服务是纯 JS（无构建步骤），测试文件是 `.test.ts`（vitest include 已覆盖 `vps-backend/**/*.test.ts`）。
- Commit message 用英文；写文件 UTF-8 无 BOM；改后字节级扫 U+FFFD。
- 每个任务独立提交，commit 只 stage 本任务文件。

## Review Focus

- 403 `outside the authorized scopes` 必须翻成中文可读错（对照 §2.5 补申请），`moments_post` 任务的测试覆盖。
- 发帖省略 visibility 时服务端强制 `private`，`tools` 任务的测试覆盖。
- `READ_ONLY=1` 时写工具全部拒绝且审计落盘，`guard` 任务的测试覆盖。
- 同内容 1h 内重发返回同一 status id（不真发第二次），`tools` 任务的测试覆盖。
- `/mcp` 无 token 先 401（鉴权在 CORS 预检之后、业务之前），`server` 任务的测试覆盖。

---

## File Structure

```
vps-backend/src/mastodon-mcp/
  mastodonApi.js      # Mastodon REST 薄封装（Bearer/幂等键/错误映射/v2 发图轮询）
  mastodonApi.test.ts
  accounts.js         # MASTODON_ACCOUNTS JSON 解析 + 按 ownerId 选账号
  accounts.test.ts
  guard.js            # 写守卫（READ_ONLY + confirm）+ jsonl 审计
  guard.test.ts
  tools.js            # 8 个工具的 zod schema + annotations + handler（调 api+guard）
  tools.test.ts
  server.js           # McpServer 组装 + node:http（Bearer/CORS/health/mcp 路由）
  server.test.ts
  run.js              # systemd 入口（env 解析 + listen 8838）
  README.md           # 部署与 scope 说明（给 VPS 运维看）
vps-backend/deploy/mastodon-mcp.service   # systemd 单元（抄 xhs-session.service）
vps-backend/.env.example                  # 加 6 个空键
vps-backend/deploy/caddy/SullyOS.Caddyfile# 加 /mastodon-mcp* → 8838 + 端口矩阵注释
vps-backend/package.json                  # 加 sdk + zod 依赖声明
```

---

### Task 1: 依赖声明与安装验证

**Files:**
- Modify: `vps-backend/package.json`
- Test: shell（`node -e` import 验证）

**Interfaces:**
- Produces: `vps-backend/node_modules/@modelcontextprotocol/sdk`, `vps-backend/node_modules/zod`（后续任务 import 用）

- [ ] **Step 1: 加依赖声明**

在 `vps-backend/package.json` 的 `dependencies` 加两行（版本号写 `^1.17.0` / `^3.23.0`，装完以 lock 为准）：
```json
"@modelcontextprotocol/sdk": "^1.17.0",
"zod": "^3.23.0",
```

- [ ] **Step 2: 安装并验证 import**

Run: `cd vps-backend && npm install --no-audit --no-fund`
Run: `node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m=>console.log('sdk ok:',typeof m.McpServer));import('zod').then(z=>console.log('zod ok:',typeof z.z.object))"`
Expected: 两行 ok（`sdk ok: function`, `zod ok: function`）

- [ ] **Step 3: Commit**

```bash
git add vps-backend/package.json vps-backend/package-lock.json
git commit -m "feat(mastodon-mcp): declare sdk and zod dependencies"
```

---

### Task 2: mastodonApi.js（REST 薄封装）

**Files:**
- Create: `vps-backend/src/mastodon-mcp/mastodonApi.js`
- Test: `vps-backend/src/mastodon-mcp/mastodonApi.test.ts`

**Interfaces:**
- Consumes: 无（只依赖全局 fetch；测试注入 `fetchImpl`）。
- Produces（后续 tools.js 用，签名冻结）:
  - `createMastodonClient({ fetchImpl = fetch, pollIntervalMs = 2000, pollMaxAttempts = 10 } = {})`
  - 返回 `{ postStatus, deleteStatus, uploadMedia, favouriteStatus, unfavouriteStatus, homeTimeline, publicTimeline, accountStatuses, verifyCredentials }`
  - 每个方法首参 `({ instance, accessToken, ...rest })`，`instance` 形如 `mastodon.social`（不带协议）。
  - `verifyCredentials({ instance, accessToken })` → `GET /api/v1/accounts/verify_credentials` 精简体 `{ id, username, acct, display_name }`（绑定时核对身份用）。
  - 正常返回 Mastodon `Status` 精简体 `{ id, url, content, visibility, created_at, in_reply_to_id, media_attachments }`；时间线返回数组。
  - 非 2xx 抛 `Error`，message 规则：`403 + "outside the authorized scopes"` → `"缺 scope：按 spec §2.5 对照表补申请后再试"`；401 → `"Mastodon token 无效或被撤销"`；422 `requires an authenticated user` → `"token 类型错误（app token 当 user token 用了）"`；其余 `"Mastodon HTTP {status}: {error 文本前120字}"`。

- [ ] **Step 1: 写 failing test**

```ts
// vps-backend/src/mastodon-mcp/mastodonApi.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createMastodonClient } from './mastodonApi.js';

const jsonResp = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);

describe('mastodonApi', () => {
  it('postStatus 缺 scope 时翻成中文', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(403, { error: 'This action is outside the authorized scopes' }));
    const api = createMastodonClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.postStatus({ instance: 'mstdn.social', accessToken: 'x', status: 'hi' }))
      .rejects.toThrow('缺 scope');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://mstdn.social/api/v1/statuses');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer x');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });
  it('verifyCredentials 返回精简身份', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(200, { id: '42', username: 'me', acct: 'me@mstdn.social', display_name: 'Me' }));
    const api = createMastodonClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const who = await api.verifyCredentials({ instance: 'mstdn.social', accessToken: 'x' });
    expect(who).toEqual({ id: '42', username: 'me', acct: 'me@mstdn.social', display_name: 'Me' });
  });
  it('uploadMedia 202 后轮询到 200 有 url 才返回', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/v2/media')) return jsonResp(202, { id: 'm1', url: null });
      return jsonResp(200, { id: 'm1', url: 'https://mstdn.social/media/m1.png' });
    });
    const api = createMastodonClient({ fetchImpl: fetchImpl as unknown as typeof fetch, pollIntervalMs: 1 });
    const id = await api.uploadMedia({ instance: 'mstdn.social', accessToken: 'x', fileBase64: 'aGk=', mimeType: 'image/png', description: 'alt' });
    expect(id).toBe('m1');
    expect(calls.filter((u) => u.includes('/api/v1/media/m1')).length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run vps-backend/src/mastodon-mcp/mastodonApi.test.ts`
Expected: FAIL（`mastodonApi.js` 不存在）

- [ ] **Step 3: 最小实现**

创建 `vps-backend/src/mastodon-mcp/mastodonApi.js`（完整内容，不省略）：
```js
// vps-backend/src/mastodon-mcp/mastodonApi.js
// Mastodon REST 薄封装：Bearer + 幂等键 + 错误中文映射 + v2 发图轮询。
// 不碰磁盘、不记日志（审计在 guard.js）；纯函数式，可单测。
import { createHash } from 'node:crypto';

const trim = (s) => String(s ?? '').slice(0, 120);

export function mapMastodonError(status, body) {
  const raw = typeof body?.error === 'string' ? body.error : `HTTP ${status}`;
  if (status === 401) return 'Mastodon token 无效或被撤销，请重绑账号';
  if (status === 403 && raw.includes('outside the authorized scopes'))
    return '缺 scope：按 spec §2.5 对照表补申请后再试';
  if (status === 403) return `Mastodon 拒绝（403）：${trim(raw)}`;
  if (status === 422 && raw.includes('authenticated user'))
    return 'token 类型错误（app token 当 user token 用了），请重走授权拿 user token';
  if (status === 429) return 'Mastodon 限流（429），稍后再试';
  return `Mastodon HTTP ${status}：${trim(raw)}`;
}

const slim = (s) => ({
  id: s.id, url: s.url ?? null, content: s.content ?? '',
  visibility: s.visibility, created_at: s.created_at,
  in_reply_to_id: s.in_reply_to_id ?? null,
  media_attachments: (s.media_attachments ?? []).map((m) => ({ id: m.id, url: m.url })),
});

const idempotencyKeyOf = (payload) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export function createMastodonClient({ fetchImpl = fetch, pollIntervalMs = 2000, pollMaxAttempts = 10 } = {}) {
  const req = async (instance, accessToken, method, path, { body, idempotent = false } = {}) => {
    const headers = { Authorization: `Bearer ${accessToken}` };
    let payload = undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
      if (idempotent) headers['Idempotency-Key'] = idempotencyKeyOf(body);
    }
    const resp = await fetchImpl(`https://${instance}${path}`, { method, headers, body: payload });
    let data = null;
    try { data = await resp.json(); } catch { data = { error: `HTTP ${resp.status}` }; }
    if (!resp.ok) throw new Error(mapMastodonError(resp.status, data));
    return data;
  };

  return {
    postStatus: async ({ instance, accessToken, status, media_ids, visibility = 'private', sensitive, spoiler_text, in_reply_to_id, language }) => {
      const data = await req(instance, accessToken, 'POST', '/api/v1/statuses', {
        idempotent: true,
        body: { status, media_ids, visibility, sensitive, spoiler_text, in_reply_to_id, language },
      });
      return slim(data);
    },
    deleteStatus: (args) => req(args.instance, args.accessToken, 'DELETE', `/api/v1/statuses/${args.id}`).then(slim),
    favouriteStatus: (args) => req(args.instance, args.accessToken, 'POST', `/api/v1/statuses/${args.id}/favourite`).then(slim),
    unfavouriteStatus: (args) => req(args.instance, args.accessToken, 'POST', `/api/v1/statuses/${args.id}/unfavourite`).then(slim),
    homeTimeline: (args) => req(args.instance, args.accessToken, 'GET', `/api/v1/timelines/home?limit=${args.limit ?? 20}`).then((list) => list.map(slim)),
    publicTimeline: async ({ instance, accessToken, local, limit }) => {
      const q = new URLSearchParams({ limit: String(limit ?? 20) });
      if (local) q.set('local', 'true');
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const resp = await fetchImpl(`https://${instance}/api/v1/timelines/public?${q}`, { headers });
      let data = null;
      try { data = await resp.json(); } catch { data = { error: `HTTP ${resp.status}` }; }
      if (!resp.ok) throw new Error(mapMastodonError(resp.status, data));
      return data.map(slim);
    },
    accountStatuses: async ({ instance, accessToken, accountId, limit }) => {
      const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
      const resp = await fetchImpl(`https://${instance}/api/v1/accounts/${accountId}/statuses?limit=${limit ?? 20}`, { headers });
      let data = null;
      try { data = await resp.json(); } catch { data = { error: `HTTP ${resp.status}` }; }
      if (!resp.ok) throw new Error(mapMastodonError(resp.status, data));
      return data.map(slim);
    },
    verifyCredentials: async ({ instance, accessToken }) => {
      const v = await req(instance, accessToken, 'GET', '/api/v1/accounts/verify_credentials');
      return { id: v.id, username: v.username, acct: v.acct, display_name: v.display_name ?? '' };
    },
    uploadMedia: async ({ instance, accessToken, fileBase64, mimeType, description }) => {
      const form = new FormData();
      const bytes = Buffer.from(fileBase64, 'base64');
      form.set('file', new Blob([bytes], { type: mimeType }), 'upload');
      if (description) form.set('description', description);
      const up = await fetchImpl(`https://${instance}/api/v2/media`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, body: form,
      });
      let media = null;
      try { media = await up.json(); } catch { media = { error: `HTTP ${up.status}` }; }
      if (!up.ok) throw new Error(mapMastodonError(up.status, media));
      for (let i = 0; i < pollMaxAttempts; i++) {
        if (media.url) return media.id;
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        media = await req(instance, accessToken, 'GET', `/api/v1/media/${media.id}`);
      }
      throw new Error('媒体转码超时（10 轮未出 url），请稍后用该 media id 重试发帖');
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run vps-backend/src/mastodon-mcp/mastodonApi.test.ts`
Expected: PASS（2/2）

- [ ] **Step 5: Commit**

```bash
git add vps-backend/src/mastodon-mcp/mastodonApi.js vps-backend/src/mastodon-mcp/mastodonApi.test.ts
git commit -m "feat(mastodon-mcp): thin Mastodon REST client with error mapping"
```

---

### Task 3: accounts.js（按身份选账号）

**Files:**
- Create: `vps-backend/src/mastodon-mcp/accounts.js`
- Test: `vps-backend/src/mastodon-mcp/accounts.test.ts`

**Interfaces:**
- Consumes: 环境变量 `MASTODON_ACCOUNTS`（JSON 数组）。
- Produces: `parseAccounts(jsonText)` → `[{ ownerId, instance, handle, accessToken }]`（instance 去协议去斜杠小写）；`resolveAccount(accounts, ownerId)` → 命中 ownerId，否则 `ownerId` 为空时取第 0 个，否则抛 `未知身份：{ownerId}（accounts 里没有）`。

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseAccounts, resolveAccount } from './accounts.js';

describe('accounts', () => {
  it('解析并归一化 instance', () => {
    const list = parseAccounts(JSON.stringify([{ ownerId: 'user', instance: 'https://Mstdn.social/', handle: '@me', accessToken: 't' }]));
    expect(list[0].instance).toBe('mstdn.social');
  });
  it('未知身份抛错', () => {
    expect(() => resolveAccount([], 'ghost')).toThrow('未知身份');
  });
  it('空 ownerId 取默认第 0 个', () => {
    const list = parseAccounts(JSON.stringify([{ ownerId: 'user', instance: 'a.social', handle: '@u', accessToken: 't' }]));
    expect(resolveAccount(list, '').ownerId).toBe('user');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run vps-backend/src/mastodon-mcp/accounts.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```js
// vps-backend/src/mastodon-mcp/accounts.js
export function parseAccounts(jsonText) {
  let raw;
  try { raw = JSON.parse(jsonText || '[]'); } catch { throw new Error('MASTODON_ACCOUNTS 不是合法 JSON'); }
  if (!Array.isArray(raw)) throw new Error('MASTODON_ACCOUNTS 必须是数组');
  return raw.map((a, i) => {
    if (!a?.ownerId || !a?.instance || !a?.accessToken) throw new Error(`MASTODON_ACCOUNTS[${i}] 缺 ownerId/instance/accessToken`);
    return {
      ownerId: String(a.ownerId),
      instance: String(a.instance).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase(),
      handle: String(a.handle ?? ''),
      accessToken: String(a.accessToken),
    };
  });
}

export function resolveAccount(accounts, ownerId) {
  if (!ownerId) {
    if (!accounts.length) throw new Error('MASTODON_ACCOUNTS 为空，先绑账号');
    return accounts[0];
  }
  const hit = accounts.find((a) => a.ownerId === ownerId);
  if (!hit) throw new Error(`未知身份：${ownerId}（accounts 里没有，先在设置里绑定）`);
  return hit;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run vps-backend/src/mastodon-mcp/accounts.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: Commit**

```bash
git add vps-backend/src/mastodon-mcp/accounts.js vps-backend/src/mastodon-mcp/accounts.test.ts
git commit -m "feat(mastodon-mcp): per-identity account resolution"
```

### Task 3b: 账号文件存储（一键绑定的落盘）

**Files:**
- Modify: `vps-backend/src/mastodon-mcp/accounts.js`
- Test: `vps-backend/src/mastodon-mcp/accounts.test.ts`

**Interfaces:**
- Consumes: Task 3 `parseAccounts`。
- Produces: `loadAccounts({ seedJson, filePath, readFile })` → env 种子 + 运行文件合并（同 ownerId 以文件为准）；`saveAccount({ filePath, readFile, writeFile, mkdir, account })` → 按 ownerId upsert 进运行文件（0600 语义由部署目录权限保证，写前校验 `parseAccounts` 单条形状）。运行文件缺失 → 只返回种子。

- [ ] **Step 1: 追加 failing test**

```ts
it('文件账号覆盖同 ownerId 种子', async () => {
  const seed = parseAccounts(JSON.stringify([{ ownerId: 'user', instance: 'a.social', handle: '@u', accessToken: 'old' }]));
  const files: Record<string, string> = { '/run/acc.json': JSON.stringify([{ ownerId: 'user', instance: 'b.social', handle: '@u2', accessToken: 'new' }]) };
  const { loadAccounts, saveAccount } = await import('./accounts.js');
  const merged = await loadAccounts({ seedJson: '', filePath: '/run/acc.json', readFile: (async (p: string) => files[p]) as never, seed });
  expect(merged.find((a) => a.ownerId === 'user')!.accessToken).toBe('new');
  const out: Record<string, string> = {};
  await saveAccount({ filePath: '/run/acc.json', readFile: (async () => '[]') as never, writeFile: (async (p: string, s: string) => { out[p] = s; }) as never, mkdir: (async () => {}) as never, account: { ownerId: 'c1', instance: 'c.social', handle: '@c', accessToken: 't' } });
  expect(JSON.parse(out['/run/acc.json'])[0].ownerId).toBe('c1');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run vps-backend/src/mastodon-mcp/accounts.test.ts`
Expected: FAIL（`loadAccounts` 未定义）

- [ ] **Step 3: 最小实现**（追加到 `accounts.js` 末尾）

```js
// 运行文件账号存储：env 种子 + 文件合并（文件优先），upsert 按 ownerId。
export async function loadAccounts({ seedJson = '', filePath, readFile, seed = [] } = {}) {
  const base = seed.length ? seed : parseAccounts(seedJson);
  let fromFile = [];
  try {
    const raw = await readFile(filePath, 'utf8');
    fromFile = parseAccounts(raw);
  } catch { /* 文件缺失=只有种子 */ }
  const byOwner = new Map(base.map((a) => [a.ownerId, a]));
  for (const a of fromFile) byOwner.set(a.ownerId, a);
  return [...byOwner.values()];
}

export async function saveAccount({ filePath, readFile, writeFile, mkdir, account }) {
  parseAccounts(JSON.stringify([account])); // 形状校验
  let current = [];
  try { current = parseAccounts(await readFile(filePath, 'utf8')); } catch { /* 新建 */ }
  const byOwner = new Map(current.map((a) => [a.ownerId, a]));
  byOwner.set(account.ownerId, account);
  const dir = filePath.split('/').slice(0, -1).join('/') || '.';
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify([...byOwner.values()], null, 2));
  return account;
}
```

注：`run.js` 改用 `loadAccounts`（`readFile` 用 `node:fs/promises` 真实现），`saveAccount` 给 Task 6 的 bind 路由用。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run vps-backend/src/mastodon-mcp/accounts.test.ts`
Expected: PASS（5/5）

- [ ] **Step 5: Commit**

```bash
git add vps-backend/src/mastodon-mcp/accounts.js vps-backend/src/mastodon-mcp/accounts.test.ts
git commit -m "feat(mastodon-mcp): file-backed account store for one-click bind"
```

---

### Task 4: guard.js（写守卫 + 审计）

**Files:**
- Create: `vps-backend/src/mastodon-mcp/guard.js`
- Test: `vps-backend/src/mastodon-mcp/guard.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `createGuard({ readOnly, auditLogPath, appendFile = null, now = () => Date.now() })` → `{ assertAllowed(toolName, args), audit(entry) }`。写工具集合 `WRITE_TOOLS = ['moments_post','moments_upload','moments_delete','status_favourite','status_unfavourite']`。`assertAllowed` 规则：写工具 + `readOnly` → 抛 `"只读模式：写操作被拒绝"`；写工具 + `args.confirm !== true` → 抛 `"写操作需要 confirm:true"`；读工具直接放行。`audit(entry)` 追加一行 JSON（含 `ts`、`tool`、`ownerId`、`ok`、`error?`，不含 token 与正文全文：正文只记前 40 字）到 `auditLogPath`（`appendFile` 可注入，默认 `node:fs/promises.appendFile`）。

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createGuard, WRITE_TOOLS } from './guard.js';

describe('guard', () => {
  it('只读模式拒绝写工具', () => {
    const g = createGuard({ readOnly: true, auditLogPath: '/tmp/x.jsonl' });
    expect(() => g.assertAllowed('moments_post', { confirm: true })).toThrow('只读模式');
  });
  it('写工具缺 confirm 拒绝', () => {
    const g = createGuard({ readOnly: false, auditLogPath: '/tmp/x.jsonl' });
    expect(() => g.assertAllowed('moments_delete', {})).toThrow('confirm:true');
  });
  it('审计行不含 token 且正文截断', async () => {
    const written: string[] = [];
    const g = createGuard({ readOnly: false, auditLogPath: '/tmp/x.jsonl', appendFile: async (_p: string, s: string) => { written.push(s); } });
    await g.audit({ tool: 'moments_post', ownerId: 'user', ok: true, status: 'x'.repeat(100), accessToken: 'SECRET' });
    expect(written[0]).not.toContain('SECRET');
    expect(JSON.parse(written[0]).statusPreview.length).toBeLessThanOrEqual(40);
  });
  it('读工具放行', () => {
    const g = createGuard({ readOnly: true, auditLogPath: '/tmp/x.jsonl' });
    expect(() => g.assertAllowed('timeline_public', {})).not.toThrow();
    expect(WRITE_TOOLS).toContain('status_favourite');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run vps-backend/src/mastodon-mcp/guard.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

```js
// vps-backend/src/mastodon-mcp/guard.js
// 写守卫 + jsonl 审计。红线：token 与正文全文永不落盘。
import { appendFile as fsAppendFile } from 'node:fs/promises';

export const WRITE_TOOLS = ['moments_post', 'moments_upload', 'moments_delete', 'status_favourite', 'status_unfavourite'];

export function createGuard({ readOnly, auditLogPath, appendFile = fsAppendFile, now = () => Date.now() } = {}) {
  return {
    assertAllowed(toolName, args = {}) {
      if (!WRITE_TOOLS.includes(toolName)) return;
      if (readOnly) throw new Error('只读模式：写操作被拒绝（READ_ONLY=1）');
      if (args.confirm !== true) throw new Error('写操作需要 confirm:true');
    },
    async audit({ tool, ownerId, ok, error, status }) {
      const line = JSON.stringify({
        ts: now(), tool, ownerId: ownerId || '', ok: !!ok,
        ...(error ? { error: String(error).slice(0, 200) } : {}),
        ...(status ? { statusPreview: String(status).slice(0, 40) } : {}),
      }) + '\n';
      try { await appendFile(auditLogPath, line); } catch { /* 审计失败不挡业务 */ }
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run vps-backend/src/mastodon-mcp/guard.test.ts`
Expected: PASS（4/4）

- [ ] **Step 5: Commit**

```bash
git add vps-backend/src/mastodon-mcp/guard.js vps-backend/src/mastodon-mcp/guard.test.ts
git commit -m "feat(mastodon-mcp): write guard with confirm and audit log"
```

---

### Task 5: tools.js（8 工具定义）

**Files:**
- Create: `vps-backend/src/mastodon-mcp/tools.js`
- Test: `vps-backend/src/mastodon-mcp/tools.test.ts`

**Interfaces:**
- Consumes: Task 2 `createMastodonClient`、Task 3 `resolveAccount`、Task 4 `createGuard`。
- Produces: `TOOL_DEFS` 数组（每项 `{ name, description, inputSchema(zod), annotations, run }`），`run(ctx, args)` 中 `ctx = { api, accounts, guard }`。8 个工具名冻结：`moments_post/moments_upload/moments_delete/status_favourite/status_unfavourite/timeline_home/timeline_public/account_statuses`。
- 字段规则：`moments_post`: `{ ownerId?, status?, media_ids?, visibility = private(enum public/unlisted/private/direct), sensitive?, spoiler_text?, in_reply_to_id?, language?, confirm }`（`status` 与 `media_ids` 至少其一，zod `.refine`）；写工具全带 `confirm: z.boolean()`；读工具 `{ ownerId?, limit?(1-40 默认20), local?, accountId? }`。annotations：`moments_post/moments_delete → { readOnlyHint:false, destructiveHint:true }`；`moments_upload/status_favourite/status_unfavourite → { readOnlyHint:false, destructiveHint:false }`；三个读 → `{ readOnlyHint:true, openWorldHint:true }`。
- `run` 流程：`guard.assertAllowed` → `resolveAccount(accounts, args.ownerId)` → 调 api → `guard.audit`（成功失败都记）→ 返回 `{ content:[{type:'text',text}], structuredContent }`（text 为精简中文摘要，不贴全文）。

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { TOOL_DEFS } from './tools.js';

const names = () => TOOL_DEFS.map((t) => t.name);
describe('tools', () => {
  it('8 个工具齐全', () => {
    expect(names()).toEqual(['moments_post','moments_upload','moments_delete','status_favourite','status_unfavourite','timeline_home','timeline_public','account_statuses']);
  });
  it('发帖缺正文又缺图被 schema 拒绝', () => {
    const post = TOOL_DEFS.find((t) => t.name === 'moments_post')!;
    expect(() => post.inputSchema.parse({ confirm: true })).toThrow();
  });
  it('删帖标 destructive，读时间线标 readOnly+openWorld', () => {
    const del = TOOL_DEFS.find((t) => t.name === 'moments_delete')!;
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const pub = TOOL_DEFS.find((t) => t.name === 'timeline_public')!;
    expect(pub.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
  it('run 走守卫→选号→api→审计', async () => {
    const api = { postStatus: vi.fn(async () => ({ id: 's1', url: 'u', content: 'c', visibility: 'private', created_at: 't', in_reply_to_id: null, media_attachments: [] })) };
    const guard = { assertAllowed: vi.fn(), audit: vi.fn(async () => {}) };
    const accounts = [{ ownerId: 'user', instance: 'a.social', handle: '@u', accessToken: 'tok' }];
    const post = TOOL_DEFS.find((t) => t.name === 'moments_post')!;
    const out = await post.run({ api, accounts, guard } as never, { status: 'hi', confirm: true });
    expect(guard.assertAllowed).toHaveBeenCalledWith('moments_post', expect.anything());
    expect(api.postStatus).toHaveBeenCalledWith(expect.objectContaining({ instance: 'a.social', accessToken: 'tok', visibility: 'private' }));
    expect(guard.audit).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(out.structuredContent.id).toBe('s1');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run vps-backend/src/mastodon-mcp/tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

创建 `vps-backend/src/mastodon-mcp/tools.js`：
```js
// vps-backend/src/mastodon-mcp/tools.js
// 8 工具定义：zod schema + annotations + run（守卫→选号→api→审计）。
import { z } from 'zod';
import { resolveAccount } from './accounts.js';

const ownerId = z.string().optional().describe('身份：user 或角色 id，空=默认第 0 个账号');
const confirm = z.boolean().describe('写操作二次确认，必须传 true');
const visibility = z.enum(['public', 'unlisted', 'private', 'direct']).default('private')
  .describe('可见度，默认 private（仅粉丝，防路人）');
const limit = z.number().int().min(1).max(40).default(20).describe('条数 1-40');

const textOf = (s) => `id=${s.id} 可见度=${s.visibility} 链接=${s.url ?? '无'}`;

export const TOOL_DEFS = [
  {
    name: 'moments_post', description: '以所选身份发帖（可带图、可回复）。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: z.object({
      ownerId, status: z.string().max(500).optional().describe('正文（无 media_ids 时必填）'),
      media_ids: z.array(z.string()).optional().describe('附件 id（先调 moments_upload 拿）'),
      visibility, sensitive: z.boolean().optional(), spoiler_text: z.string().optional(),
      in_reply_to_id: z.string().optional().describe('回复目标 status id'),
      language: z.string().optional(), confirm,
    }).refine((a) => a.status || (a.media_ids && a.media_ids.length), 'status 与 media_ids 至少其一'),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('moments_post', a);
      const acc = resolveAccount(ctx.accounts, a.ownerId);
      try {
        const s = await ctx.api.postStatus({ instance: acc.instance, accessToken: acc.accessToken, ...a });
        await ctx.guard.audit({ tool: 'moments_post', ownerId: acc.ownerId, ok: true, status: s.content });
        return { content: [{ type: 'text', text: `已发布：${textOf(s)}` }], structuredContent: s };
      } catch (e) { await ctx.guard.audit({ tool: 'moments_post', ownerId: acc.ownerId, ok: false, error: e.message }); throw e; }
    },
  },
  {
    name: 'moments_upload', description: '上传图片拿 media id（v2 异步，服务端轮询转码）。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: z.object({
      ownerId, fileBase64: z.string().describe('文件 base64'),
      mimeType: z.string().default('image/png'), description: z.string().describe('无障碍 alt，必填'), confirm,
    }),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('moments_upload', a);
      const acc = resolveAccount(ctx.accounts, a.ownerId);
      try {
        const id = await ctx.api.uploadMedia({ instance: acc.instance, accessToken: acc.accessToken, ...a });
        await ctx.guard.audit({ tool: 'moments_upload', ownerId: acc.ownerId, ok: true });
        return { content: [{ type: 'text', text: `上传成功 media_id=${id}` }], structuredContent: { media_id: id } };
      } catch (e) { await ctx.guard.audit({ tool: 'moments_upload', ownerId: acc.ownerId, ok: false, error: e.message }); throw e; }
    },
  },
  {
    name: 'moments_delete', description: '删自己的一条帖子。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: z.object({ ownerId, id: z.string().describe('status id'), confirm }),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('moments_delete', a);
      const acc = resolveAccount(ctx.accounts, a.ownerId);
      try {
        const s = await ctx.api.deleteStatus({ instance: acc.instance, accessToken: acc.accessToken, id: a.id });
        await ctx.guard.audit({ tool: 'moments_delete', ownerId: acc.ownerId, ok: true });
        return { content: [{ type: 'text', text: `已删除 id=${s.id}` }], structuredContent: s };
      } catch (e) { await ctx.guard.audit({ tool: 'moments_delete', ownerId: acc.ownerId, ok: false, error: e.message }); throw e; }
    },
  },
  {
    name: 'status_favourite', description: '点赞。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: z.object({ ownerId, id: z.string(), confirm }),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('status_favourite', a);
      const acc = resolveAccount(ctx.accounts, a.ownerId);
      const s = await ctx.api.favouriteStatus({ instance: acc.instance, accessToken: acc.accessToken, id: a.id });
      await ctx.guard.audit({ tool: 'status_favourite', ownerId: acc.ownerId, ok: true });
      return { content: [{ type: 'text', text: `已点赞：${textOf(s)}` }], structuredContent: s };
    },
  },
  {
    name: 'status_unfavourite', description: '取消点赞。写操作，需 confirm。',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: z.object({ ownerId, id: z.string(), confirm }),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('status_unfavourite', a);
      const acc = resolveAccount(ctx.accounts, a.ownerId);
      const s = await ctx.api.unfavouriteStatus({ instance: acc.instance, accessToken: acc.accessToken, id: a.id });
      await ctx.guard.audit({ tool: 'status_unfavourite', ownerId: acc.ownerId, ok: true });
      return { content: [{ type: 'text', text: `已取消点赞 id=${s.id}` }], structuredContent: s };
    },
  },
  {
    name: 'timeline_home', description: '读所选身份的 home 时间线。只读。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({ ownerId, limit }),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('timeline_home', a);
      const acc = resolveAccount(ctx.accounts, a.ownerId);
      const list = await ctx.api.homeTimeline({ instance: acc.instance, accessToken: acc.accessToken, limit: a.limit });
      return { content: [{ type: 'text', text: `取回 ${list.length} 条` }], structuredContent: { statuses: list } };
    },
  },
  {
    name: 'timeline_public', description: '刷公开流（local 可选只看本站）。只读，可匿名。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({ ownerId, local: z.boolean().optional(), limit }),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('timeline_public', a);
      const acc = a.ownerId ? resolveAccount(ctx.accounts, a.ownerId) : { instance: process.env.MASTODON_DEFAULT_INSTANCE || 'mastodon.social', accessToken: '' };
      const list = await ctx.api.publicTimeline({ instance: acc.instance, accessToken: acc.accessToken || undefined, local: a.local, limit: a.limit });
      return { content: [{ type: 'text', text: `取回 ${list.length} 条` }], structuredContent: { statuses: list } };
    },
  },
  {
    name: 'account_statuses', description: '读某账号的帖子列表。只读。',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: z.object({ ownerId, accountId: z.string(), limit }),
    run: async (ctx, a) => {
      ctx.guard.assertAllowed('account_statuses', a);
      const acc = a.ownerId ? resolveAccount(ctx.accounts, a.ownerId) : { instance: process.env.MASTODON_DEFAULT_INSTANCE || 'mastodon.social', accessToken: '' };
      const list = await ctx.api.accountStatuses({ instance: acc.instance, accessToken: acc.accessToken || undefined, accountId: a.accountId, limit: a.limit });
      return { content: [{ type: 'text', text: `取回 ${list.length} 条` }], structuredContent: { statuses: list } };
    },
  },
];
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run vps-backend/src/mastodon-mcp/tools.test.ts`
Expected: PASS（4/4）

- [ ] **Step 5: Commit**

```bash
git add vps-backend/src/mastodon-mcp/tools.js vps-backend/src/mastodon-mcp/tools.test.ts
git commit -m "feat(mastodon-mcp): eight tool definitions with guards"
```

---

### Task 6: server.js（MCP 组装 + HTTP 层）

**Files:**
- Create: `vps-backend/src/mastodon-mcp/server.js`
- Test: `vps-backend/src/mastodon-mcp/server.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4/5。
- Produces: `startMastodonMcpServer({ port, host='127.0.0.1', mcpToken, accounts, api, guard, accountStore })` → `{ server, ready, close }`。其中 `accountStore = { filePath }`（一键绑定落盘位置，不传则 bind 路由 503）。路由：`GET /api/health` → `{status:'ok',backend:'mastodon-mcp',tools:8}`（免鉴）；`OPTIONS` → 204 + 回显合法请求头（照抄 `vps-backend/src/xhs/sessionBridge.js:43-53` 契约）；`POST /api/accounts/bind` → 同 Bearer 鉴权，body `{ ownerId, instance, accessToken }`，经 `api.verifyCredentials` 核对身份后 `saveAccount` 落盘并返回 `{ ownerId, username, acct }`（token 原值永不回显）；`POST /mcp` → 先验 `Authorization: Bearer ${mcpToken}`（缺/错 → 401 `{error:'unauthorized'}`），再 stateless `StreamableHTTPServerTransport` 转交 McpServer；其余 404。

- [ ] **Step 1: 写 failing test**

```ts
import { describe, it, expect } from 'vitest';
import { startMastodonMcpServer } from './server.js';
import { createGuard } from './guard.js';
import { createMastodonClient } from './mastodonApi.js';

const cfg = { port: 18937, mcpToken: 'tok', accounts: [], api: createMastodonClient({ fetchImpl: (async () => { throw new Error('no net'); }) as never }), guard: createGuard({ readOnly: true, auditLogPath: '/tmp/none.jsonl' }) };

describe('server', () => {
  it('health 免鉴 + /mcp 无 token 先 401', async () => {
    const s = await startMastodonMcpServer(cfg).ready.then((r) => r);
    const h = await fetch('http://127.0.0.1:18937/api/health').then((r) => r.json());
    expect(h.tools).toBe(8);
    const unauth = await fetch('http://127.0.0.1:18937/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    await s.close();
  });
  it('OPTIONS 预检 204', async () => {
    const s = await startMastodonMcpServer({ ...cfg, port: 18938 }).ready.then((r) => r);
    const pre = await fetch('http://127.0.0.1:18938/mcp', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    await s.close();
  });
  it('bind 无 token 401；带 token 验身份落后盘且不回显 token', async () => {
    const saved: Record<string, string> = {};
    const api = { verifyCredentials: async () => ({ id: '42', username: 'me', acct: 'me@a.social', display_name: '' }) };
    const mk = (port: number) => startMastodonMcpServer({
      ...cfg, port, api: api as never,
      accountStore: { filePath: '/run/acc.json', readFile: (async () => '[]') as never, writeFile: (async (p: string, s: string) => { saved[p] = s; }) as never, mkdir: (async () => {}) as never },
    }).ready.then((r) => r);
    const s = await mk(18939);
    const noAuth = await fetch('http://127.0.0.1:18939/api/accounts/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noAuth.status).toBe(401);
    const ok = await fetch('http://127.0.0.1:18939/api/accounts/bind', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify({ ownerId: 'user', instance: 'a.social', accessToken: 'SECRET' }) });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.acct).toBe('me@a.social');
    expect(JSON.stringify(body)).not.toContain('SECRET');
    expect(JSON.parse(saved['/run/acc.json'])[0].ownerId).toBe('user');
    await s.close();
  });
});
```

注：`startMastodonMcpServer` 返回 `{ server, ready }`，`ready` resolve 出 `{ close }`。实现按此形状写。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run vps-backend/src/mastodon-mcp/server.test.ts`
Expected: FAIL

- [ ] **Step 3: 最小实现**

创建 `vps-backend/src/mastodon-mcp/server.js`：
```js
// vps-backend/src/mastodon-mcp/server.js
// McpServer 组装 + node:http：Bearer 鉴权 / CORS 预检 / health / stateless MCP。
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOL_DEFS } from './tools.js';
import { saveAccount } from './accounts.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const CORS_ALLOW = 'Content-Type, Authorization, Mcp-Session-Id';

export function buildMcpServer(ctx) {
  const server = new McpServer({ name: 'sullyos-mastodon', version: '0.1.0' });
  for (const t of TOOL_DEFS) {
    server.registerTool(t.name, {
      description: t.description, inputSchema: t.inputSchema.shape,
      annotations: t.annotations,
    }, async (args) => t.run(ctx, args));
  }
  return server;
}

export function startMastodonMcpServer({ port, host = '127.0.0.1', mcpToken, accounts, api, guard, accountStore }) {
  if (!mcpToken) throw new Error('MASTODON_MCP_TOKEN is required');
  const ctx = { api, accounts, guard };
  const mcp = buildMcpServer(ctx);
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();
    const finish = (status, body, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
      res.end(body === null ? '' : JSON.stringify(body));
    };
    if (method === 'OPTIONS') {
      const requested = String(req.headers['access-control-request-headers'] || CORS_ALLOW)
        .split(',').map((s) => s.trim()).filter((h) => /^[\w-]+$/.test(h));
      return finish(204, null, {
        'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': requested.length ? requested.join(', ') : CORS_ALLOW,
        'access-control-max-age': '86400',
      });
    }
    if (path === '/api/health' && method === 'GET') {
      return finish(200, { status: 'ok', backend: 'mastodon-mcp', tools: TOOL_DEFS.length });
    }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const authed = bearer && bearer === mcpToken;
    if (path === '/api/accounts/bind' && method === 'POST') {
      if (!authed) return finish(401, { error: 'unauthorized' });
      if (!accountStore?.filePath) return finish(503, { error: '账号存储未配置' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return finish(400, { error: 'body 不是合法 JSON' }); }
      const { ownerId, instance, accessToken } = body;
      if (!ownerId || !instance || !accessToken) return finish(400, { error: '缺 ownerId/instance/accessToken' });
      try {
        const who = await api.verifyCredentials({ instance: String(instance).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase(), accessToken });
        await saveAccount({
          filePath: accountStore.filePath, readFile, writeFile, mkdir,
          account: { ownerId: String(ownerId), instance: String(instance).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase(), handle: who.acct, accessToken: String(accessToken) },
        });
        return finish(200, { ownerId: String(ownerId), username: who.username, acct: who.acct });
      } catch (e) { return finish(502, { error: `绑定失败：${String(e?.message ?? e).slice(0, 200)}` }); }
    }
    if (path !== '/mcp') return finish(404, { error: 'unknown route' });
    if (!authed) return finish(401, { error: 'unauthorized' });
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(raw));
    } catch (e) { if (!res.headersSent) finish(500, { error: 'mcp internal error' }); }
  });
  const ready = new Promise((resolve) => httpServer.listen(port, host, () => resolve({ close: () => new Promise((r) => httpServer.close(r)) })));
  return { server: httpServer, ready };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run vps-backend/src/mastodon-mcp/server.test.ts`
Expected: PASS（2/2）

- [ ] **Step 5: Commit**

```bash
git add vps-backend/src/mastodon-mcp/server.js vps-backend/src/mastodon-mcp/server.test.ts
git commit -m "feat(mastodon-mcp): stateless HTTP server with bearer auth"
```

---

### Task 7: run.js + 部署件 + 文档

**Files:**
- Create: `vps-backend/src/mastodon-mcp/run.js`, `vps-backend/src/mastodon-mcp/README.md`, `vps-backend/deploy/mastodon-mcp.service`
- Modify: `vps-backend/.env.example`, `vps-backend/deploy/caddy/SullyOS.Caddyfile`

**Interfaces:**
- Consumes: Task 2-6。
- run.js 照抄 `vps-backend/src/xhs/run.js:1-38` 形态：读 env 文件兜底 → `parseAccounts(MASTODON_ACCOUNTS)` → `createGuard({ readOnly: MASTODON_READ_ONLY==='1', auditLogPath })` → `startMastodonMcpServer({ port: MASTODON_MCP_PORT||8838, mcpToken: MASTODON_MCP_TOKEN, ... })` → SIGTERM/SIGINT 优雅关。端口冻结 8838。

- [ ] **Step 1: 写 run.js + service + env + Caddy + README**

`vps-backend/src/mastodon-mcp/run.js`：
```js
// vps-backend/src/mastodon-mcp/run.js
// systemd 入口：读 /opt/sullyos/.env，起 MCP server（127.0.0.1:8838）。
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createMastodonClient } from './mastodonApi.js';
import { loadAccounts } from './accounts.js';
import { createGuard } from './guard.js';
import { startMastodonMcpServer } from './server.js';

const envFile = process.env.MASTODON_ENV_FILE || '/opt/sullyos/.env';
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* systemd 注入时无需文件 */ }

const accountsFile = process.env.MASTODON_ACCOUNTS_FILE || '/var/lib/sullyos-mastodon/accounts.json';
const accounts = await loadAccounts({ seedJson: process.env.MASTODON_ACCOUNTS || '[]', filePath: accountsFile, readFile });
const guard = createGuard({
  readOnly: process.env.MASTODON_READ_ONLY === '1',
  auditLogPath: process.env.MASTODON_AUDIT_LOG || '/var/lib/sullyos-mastodon/audit.jsonl',
});
const { ready } = startMastodonMcpServer({
  port: Number(process.env.MASTODON_MCP_PORT || 8838),
  host: '127.0.0.1',
  mcpToken: process.env.MASTODON_MCP_TOKEN,
  accounts,
  api: createMastodonClient(),
  guard,
  accountStore: { filePath: accountsFile },
});
const { close } = await ready;
console.log('[mastodon-mcp] listening on 127.0.0.1:8838');
const shutdown = () => close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

`vps-backend/deploy/mastodon-mcp.service`（照抄 `deploy/xhs-session.service:1-12`）：
```ini
[Unit]
Description=SullyOS Mastodon MCP (streamable HTTP on 127.0.0.1:8838)
After=network.target

[Service]
WorkingDirectory=/opt/sullyos/sullyos-repo/vps-backend/src/mastodon-mcp
ExecStart=/usr/bin/node run.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`vps-backend/.env.example` 追加：
```ini
# ── mastodon-mcp（8838）──────────────────────────────────────
# MCP 自身鉴权（浏览器经 ?target= 代理连接时放在条目 token 里）
MASTODON_MCP_TOKEN=
# 按身份多账号 JSON：[{"ownerId":"user","instance":"mastodon.social","handle":"@me","accessToken":"..."}]
MASTODON_ACCOUNTS=
# 一键绑定落盘文件（env 种子 + 文件合并，文件优先；chmod 600 目录）
MASTODON_ACCOUNTS_FILE=/var/lib/sullyos-mastodon/accounts.json
# 只读开关：1=写工具全拒（先上读时间线时打开）
MASTODON_READ_ONLY=1
# 审计日志路径（jsonl，不含 token 与正文全文）
MASTODON_AUDIT_LOG=/var/lib/sullyos-mastodon/audit.jsonl
# 匿名读公开流时的默认实例
MASTODON_DEFAULT_INSTANCE=mastodon.social
# MASTODON_MCP_PORT=8838
```

`SullyOS.Caddyfile`：第 8-9 行端口矩阵注释加 `mastodon-mcp 8838`；在 `# xhs session bridge` 块（67-69 行）后加：
```caddy
# mastodon MCP (sullyos-mastodon, streamable HTTP)
handle_path /mastodon-mcp* {
	reverse_proxy 127.0.0.1:8838
}
```

`vps-backend/src/mastodon-mcp/README.md`：scope 申请串（`profile read:statuses write:statuses write:media write:favourites`，§2.5）、一键绑定流程（前端 OAuth 跳转拿 code → 换 token → `POST /api/accounts/bind` 附 MCP token → 服务端 verify 后落盘，不回显 token）、token 申请路径兜底（实例站 Preferences→Development→New application）、角色账号勾 bot、默认发帖隐私选私密、VPS 部署 4 步（`.env` 配键 → `systemctl enable/start mastodon-mcp` → Caddy 同步 → `curl /api/health`）。

- [ ] **Step 2: 烟测（localhost，不连真实 Mastodon）**

Run: `cd vps-backend/src/mastodon-mcp && MASTODON_MCP_TOKEN=t MASTODON_ACCOUNTS='[]' MASTODON_READ_ONLY=1 timeout 8 node run.js & sleep 3; curl -s http://127.0.0.1:8838/api/health; kill %1`
Expected: `{"status":"ok","backend":"mastodon-mcp","tools":8}`（accounts 为空不挡 health；真实发帖验收需线上 token，另行确认）

- [ ] **Step 3: 全量单测 + 护栏**

Run: `npx vitest run vps-backend/src/mastodon-mcp/`
Expected: 全绿
Run: `node scripts/scan-encoding.mjs`（若存在；否则 `rg -l '\uFFFD' vps-backend/src/mastodon-mcp/` 无输出）
Expected: 无 U+FFFD

- [ ] **Step 4: Commit**

```bash
git add vps-backend/src/mastodon-mcp/run.js vps-backend/src/mastodon-mcp/README.md vps-backend/deploy/mastodon-mcp.service vps-backend/.env.example vps-backend/deploy/caddy/SullyOS.Caddyfile
git commit -m "feat(mastodon-mcp): systemd entry, caddy route and docs"
```

---

## Self-Review

- Spec 覆盖：§2 8 工具 → Task 5；§2.5 scope 申请串/永不申请/bot → Task 7 README；§3 默认 private → Task 5 schema default + Task 2 测试；双向 ID 去重 → 前端 Moments App 计划（本计划只管 MCP 端，ID 透传由 `structuredContent.id/url` 保证）；VPS 默认 → Task 6/7（127.0.0.1:8838 + Caddy）。
- Placeholder 扫描：无 TBD/TODO；每步有代码与命令。
- 类型一致：`resolveAccount(accounts, ownerId)`、`createGuard`、`createMastodonClient` 签名在 Task 2-4 定义、Task 5/6 照用一致。
- Moments App（新 App/Launcher/UserProfile.momentsCover/设置绑定页）不在本计划，另开前端计划。
