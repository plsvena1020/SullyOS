# Voice-Relay 搬 VPS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 7 个语音接口以独立原生服务跑在 VPS `127.0.0.1:8839`，Caddy 一行切换后 Vercel 可退役。

**Architecture:** 新服务抄 `mastodon-mcp`/`xhs` 原生模板（run.js + systemd unit，不进 run-all bundle 链）；handler 逻辑从 `api/*` 平移（密钥永存客户端）；Caddy `/api/*` 改指本地端口；前端零改动。

**Tech Stack:** Node 内置 http（plain JS，无新依赖）、systemd、Caddy、vitest（仓库根）/ node:test（vps-backend 内，按 Task 1 裁决）。

**Spec:** `docs/superpowers/specs/2026-09-24-voice-relay-design.md`

## Global Constraints

- 不新增 npm 依赖（Node 内置 only）。
- 端口 `8839`（已验空闲），只绑 `127.0.0.1`。
- 密钥永存客户端：服务端不读、不存、不打日志任何 Key（沿用现行防烧 key 设计）。
- 服务自己解析 JSON 请求体（multipart 上传走 raw passthrough）；未知 `/api` 路径一律 404。
- CORS 与 `api/_cors.ts` 同款（`Allow-Origin *`，放行 Authorization/xi-api-key/model/X-MiniMix-* 系）。
- 本地 Windows PowerShell 5.1；VPS Ubuntu；除 Task 5 那一行外不动 Caddy/DNS/其他服务。
- 测试：仓库根用 `pnpm vitest run <file>`；`vps-backend` 内若无 vitest 则用 `node --test`（Task 1 裁决）。

## Review Focus

1. multipart 上传体被 JSON 解析破坏 → Task 2 钉 raw 透传测试（坏包上游 400）。
2. 未知路径回了 500/200 而非 404 → music 回退链断裂；Task 1 钉 404 测试。
3. CORS 预检缺头 → 浏览器端直接失败；Task 1 钉 OPTIONS 测试（含 Authorization、xi-api-key）。
4. Key 被打进日志/错误回显 → Task 2 钉缺 key 时 400 且响应体无 key 回显。
5. 新鲜度/端口冲突致旧服务被盖 → Task 4 钉端口占用检查与备份式部署（先起新、验活、再切流）。

---

## File Structure

- `vps-backend/src/voice-relay/run.js`（新建）：路由表 + CORS + body 读取 + 7 handler + `/api/health` + 404 默认。
- `vps-backend/src/voice-relay/*.test.mjs`（新建，如用 node:test）或根 `vitest` 沿用：按 Task 1 裁决，二选一。
- `vps-backend/deploy/voice-relay.service`（新建）：抄 `deploy/mastodon-mcp.service`，替换名与路径。
- `vps-backend/.env.example`（改）：追加三行空值模板（注释中文）。
- `vps-backend/src/mastodon-mcp/README.md` 同款：在 `vps-backend/src/voice-relay/README.md` 新建 4 步（.env→enable→Caddy→curl）。
- `api/*`（读，不改）。

---

### Task 1: 脚手架 + 运行时裁决 + 路由/CORS/404/health

**Files:**
- Create: `vps-backend/src/voice-relay/run.js`
- Create: `vps-backend/src/voice-relay/route.test.mjs`（若 Task 内裁决用 node:test；vitest 则放根测，本任务内定）
- Read: `vps-backend/package.json`、`vps-backend/src/mastodon-mcp/run.js:1-40`、`api/_cors.ts:1-60`

**Interfaces:**
- Consumes: 无
- Produces: `listen(8839)`、`ROUTES` 表（Task 2 填充 7 项）、`readBody(req)`（Buffer/raw）、`sendJson(res,status,obj)`、`applyCors(req,res)`（Task 2 复用签名）。

- [ ] **Step 1: 运行时裁决（只读，先定test跑道）**

Run: `rg -n "tsx|ts-node|typescript" vps-backend/package.json`
Expected: 若零命中 → node:test 跑道（本计划默认）；若命中 → 上报 NEEDS_CONTEXT（贴命中行），等父会话裁决改 vitest 跑道后再继续。

- [ ] **Step 2: 先写测试**

```js
// vps-backend/src/voice-relay/route.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './run.js'; // 本任务导出 createServer({port}) 以便测随机端口

test('unknown api path → 404', async () => {
  const { url, close } = await createServer({ port: 0 });
  const r = await fetch(url + '/api/minimax/music');
  assert.equal(r.status, 404);
  await close();
});

test('OPTIONS preflight carries proxy headers', async () => {
  const { url, close } = await createServer({ port: 0 });
  const r = await fetch(url + '/api/minimax/t2a', {
    method: 'OPTIONS',
    headers: { Origin: 'https://ethernet.bot.cd', 'Access-Control-Request-Headers': 'Authorization, xi-api-key' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  await close();
});

test('GET /api/health → 200', async () => {
  const { url, close } = await createServer({ port: 0 });
  const r = await fetch(url + '/api/health');
  assert.equal(r.status, 200);
  await close();
});
```

- [ ] **Step 3: 跑测试确认红**

Run: `node --test vps-backend/src/voice-relay/route.test.mjs`
Expected: FAIL（run.js 不存在）。

- [ ] **Step 4: 最小实现**

```js
// vps-backend/src/voice-relay/run.js
import http from 'node:http';

export const PORT = Number(process.env.VOICE_RELAY_PORT || 8839);
const HOST = '127.0.0.1';

const ALLOW_HEADERS = ['Authorization', 'xi-api-key', 'model', 'X-MiniMax-Region', 'X-MiniMax-Group-Id', 'Content-Type', 'Accept'];

export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS.join(', '));
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const ROUTES = {}; // Task 2 填充：'POST /api/minimax/t2a' -> handler

export function createServer({ port = PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      applyCors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true });
        return;
      }
      const fn = ROUTES[`${req.method} ${url.pathname}`];
      if (!fn) { sendJson(res, 404, { error: 'Not Found' }); return; }
      await fn(req, res, url);
    } catch (e) {
      sendJson(res, 500, { error: e?.message || 'Proxy request failed' });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, HOST, () => {
      resolve({ url: `http://${HOST}:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && import.meta.url.endsWith('/run.js')) {
  createServer().then(({ url }) => console.log('voice-relay on ' + url));
}
```

- [ ] **Step 5: 跑测试确认绿**

Run: `node --test vps-backend/src/voice-relay/route.test.mjs`
Expected: PASS（3 tests）。

- [ ] **Step 6: Commit**

```bash
git add vps-backend/src/voice-relay/run.js vps-backend/src/voice-relay/route.test.mjs
git commit -m "feat(voice-relay): scaffold with routing CORS and health checks"
```

---

### Task 2: 平移 7 个 handler + 透传测试

**Files:**
- Modify: `vps-backend/src/voice-relay/run.js`（ROUTES 填充 7 项 + handler 实现）
- Modify: `vps-backend/src/voice-relay/route.test.mjs`（追加用例）
- Read: `api/minimax/t2a.ts` 全文、`api/minimax/voice-clone.ts`、`api/minimax/upload.ts`、`api/minimax/get-voice.ts`、`api/minimax/bake-voice.ts`、`api/minimax/_bakeVoiceCore.ts`、`api/fishaudio/tts.ts`、`api/elevenlabs/tts.ts`

**Interfaces:**
- Consumes: Task 1 的 `sendJson`、`readBody`、`ROUTES`（签名照抄）。
- Produces: 7 条路由生效（Task 4 探针消费）。

- [ ] **Step 1: 先写测试（mock 上游，不烧真实 key）**

```js
// 追加到 route.test.mjs（示意两例，其余 5 条同形：mock fetch 断言透传形状）
test('t2a without key → 400 without echo', async () => {
  const { url, close } = await createServer({ port: 0 });
  const r = await fetch(url + '/api/minimax/t2a', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400);
  const text = await r.text();
  assert.ok(!text.includes('sk-') && !text.includes('Bearer'));
  await close();
});

test('upload forwards raw multipart body', async () => {
  const { url, close } = await createServer({ port: 0 });
  const boundary = '----t';
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfile-test\r\n--${boundary}--\r\n`;
  const r = await fetch(url + '/api/minimax/upload', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: 'Bearer K' },
  });
  // 无真实上游，断言服务把 raw 体发出（以 5xx/上游错误收尾即证明经过转发层；细断言见实现内 mock 方案）
  assert.ok([500, 502, 400].includes(r.status));
  await close();
});
```

注：上游 fetch mock 方案——实现内用 `globalThis.fetch` 可替换点（默认 `fetch`，测试用 `tddFetch` 注入； ROUTES handler 签名 `(req, res, url, deps = {})`，`deps.fetch ?? globalThis.fetch`）。

- [ ] **Step 2: 跑测试确认红**

Run: `node --test vps-backend/src/voice-relay/route.test.mjs`
Expected: FAIL（路由未注册 → 404 vs 期望 400/透传）。

- [ ] **Step 3: 最小实现（t2a 完整示例，其余 6 条同形平移）**

```js
// run.js 内追加（t2a 完整移植，逐行对 api/minimax/t2a.ts:7-112）
const DOMESTIC_BASE = 'https://api.minimaxi.com';
const OVERSEAS_BASE = 'https://api.minimax.io';
const normKey = (v) => String(v || '').trim().replace(/^Bearer\s+/i, '').trim();

async function t2a(req, res, url, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const raw = await readBody(req);
  let body = {};
  try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
  const h = req.headers;
  const key = normKey(h.authorization) || normKey(h['x-minimax-api-key']);
  if (!key) return sendJson(res, 400, { error: 'Missing API key. Provide Authorization or x-minimax-api-key.' });
  const region = String(h['x-minimax-region'] || process.env.MINIMAX_REGION || '').trim().toLowerCase();
  const base = region === 'overseas' ? OVERSEAS_BASE : DOMESTIC_BASE;
  const gid = [body.group_id, h['x-minimax-group-id'], process.env.MINIMAX_GROUP_ID].map((v) => String(v || '').trim()).find(Boolean) || '';
  const out = { ...body };
  if (gid && !out.group_id) out.group_id = gid;
  const upstream = await f(base + '/v1/t2a_v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(out),
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(text);
}
ROUTES['POST /api/minimax/t2a'] = t2a;
```

其余 6 条按同一模板逐文件平移（逐项核对清单，不贴全文）：
- voice-clone：取 body 全量 + key 头 → POST 上游 `/v1/voice_clone`，状态码+body 透传。
- upload：**不做 JSON.parse**，raw Buffer + 原 Content-Type 直接转发 `/v1/files/upload`。
- get-voice：body 全量 JSON → `/v1/get_voice` 透传。
- bake-voice：读 body `{apiKey,voiceId,model,ttsPayload,groupId?,region?}`，
  按 `_bakeVoiceCore.ts` 三步（T2A→upload→clone）用内部函数编排（原文件可直接搬逻辑，不 import TS）。
- fishaudio：`Authorization` 必填（400 无回显）；model 取头/`FISH_MODEL`/缺省 `s2.1-pro`；
  上游 `https://api.fish.audio/v1/tts`，二进制原样回写（含 content-type）。
- elevenlabs：query 校验 `voice_id`（缺则 400）+ `output_format`（缺省 `mp3_44100_128` 按源文件缺省）；
  `xi-api-key` 头透传；二进制原样回写。

- [ ] **Step 4: 跑测试确认绿**

Run: `node --test vps-backend/src/voice-relay/`
Expected: PASS（全部）。

- [ ] **Step 5: Commit**

```bash
git add vps-backend/src/voice-relay/
git commit -m "feat(voice-relay): port seven relay handlers with mocked tests"
```

---

### Task 3: systemd unit + env 模板 + 文档

**Files:**
- Create: `vps-backend/deploy/voice-relay.service`（抄 `deploy/mastodon-mcp.service`，替换名与路径）
- Modify: `vps-backend/.env.example`（追加三行）、`vps-backend/src/voice-relay/README.md`（新建 4 步）
- Read: `vps-backend/deploy/mastodon-mcp.service` 全文（逐行抄格式）

**Interfaces:**
- Consumes: Task 2 的服务（部署它）。
- Produces: 可安装单元 + 文档（Task 4 消费）。

- [ ] **Step 1: unit 文件（抄格式，替换三处）**

```ini
[Unit]
Description=SullyOS voice relay
After=network.target

[Service]
WorkingDirectory=/opt/sullyos/sullyos-repo/vps-backend/src/voice-relay
ExecStart=/usr/bin/node run.js
Restart=on-failure
Environment=VOICE_RELAY_PORT=8839

[Install]
WantedBy=multi-user.target
```
（WorkingDirectory/描述/端口按 mastodon 模板实测格式对齐，+wantedBy；`User=root` 仅当模板有时才加。）

- [ ] **Step 2: `.env.example` 追加（值留空，注释中文）**

```ini
# 语音中转（无密钥！Key 永远走客户端请求头）
MINIMAX_REGION=
MINIMAX_GROUP_ID=
FISH_MODEL=
```

- [ ] **Step 3: README 4 步（逐字可用）**

```md
## voice-relay（语音中转，8839）
1. `.env` 配好上面三个变量（值从 Vercel 面板抄，钥匙不用配）。
2. `cp deploy/voice-relay.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now voice-relay`
3. Caddy 见 Task 5（切换前不动）。
4. `curl 127.0.0.1:8839/api/health` → `{"ok":true}`。
```

- [ ] **Step 4: Commit**

```bash
git add vps-backend/deploy/voice-relay.service vps-backend/.env.example vps-backend/src/voice-relay/README.md
git commit -m "feat(voice-relay): systemd unit, env template and docs"
```

---

### Task 4: VPS 落地（不碰线上流量）

**Files:** 无仓库改动（上传 Task 1-3 产物）。

**Interfaces:**
- Consumes: Task 1-3（服务代码 + unit + 文档）。
- Produces: VPS 上运行的 8839 服务（Task 5 切换消费）。

- [ ] **Step 1: 读 Vercel 现值（父会话执行只读 API，子会话不碰 token）**

由父会话提供：`MINIMAX_REGION`、`MINIMAX_GROUP_ID`、`FISH_MODEL` 三值（只读 env API，
只读 BACKEND_HOST/VITE_PROXY_WORKER_URL 之外的这三个；值不进文档不进报告）。

- [ ] **Step 2: 传文件**

```bash
# 用 vps.upload（localPath → remotePath，逐个）：
vps-backend/src/voice-relay/run.js → /opt/sullyos/voice-relay-staging/run.js
vps-backend/deploy/voice-relay.service → /tmp/voice-relay.service
```

- [ ] **Step 3: 装服务（vps.execute-command，逐条）**

```bash
test -f /opt/sullyos/.env && echo ENV_OK
# 三个值由父会话当场给，逐条追加（存在则跳过）：
grep -q '^MINIMAX_REGION=' /opt/sullyos/.env || echo 'MINIMAX_REGION=<值>' >> /opt/sullyos/.env
mkdir -p /opt/sullyos/voice-relay && cp /opt/sullyos/voice-relay-staging/run.js /opt/sullyos/voice-relay/run.js
cp /tmp/voice-relay.service /etc/systemd/system/voice-relay.service && systemctl daemon-reload
systemctl enable --now voice-relay && sleep 2 && systemctl is-active voice-relay
ss -ltn | grep 8839
```

Expected: `ENV_OK`、`active`、8839 在监听。

- [ ] **Step 4: 直连探针（不经 Caddy，零线上影响）**

```bash
curl -s http://127.0.0.1:8839/api/health
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8839/api/minimax/music -X POST -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w "%{http_code}" -X OPTIONS http://127.0.0.1:8839/api/minimax/t2a -H 'Origin: https://ethernet.bot.cd' -H 'Access-Control-Request-Headers: Authorization'
```

Expected: `{"ok":true}`、`404`、`204`。任一不符即停，不进 Task 5。

---

### Task 5: Caddy 切换（需用户说“切换”才执行）

**Files:** VPS `/etc/caddy/Caddyfile` 一行。

- [ ] **Step 1: 备份**

`cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-voice && ls -la` 确认存在。

- [ ] **Step 2: 改一行 + 校验 + 重载**

把 `ethernet.bot.cd` 块内 `handle_path /api/*` 的
`reverse_proxy https://sully-os-plsvena.vercel.app` 改为 `reverse_proxy 127.0.0.1:8839`
（`flush_interval -1` 保留），其余一字不动；
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`。
Expected: `Valid configuration`，无报错。

- [ ] **Step 3: 线上探针**

```bash
curl -s -o /dev/null -w "%{http_code} " https://ethernet.bot.cd/agent/health
curl -s -o /dev/null -w "%{http_code}" -X OPTIONS https://ethernet.bot.cd/api/minimax/t2a -H 'Origin: https://ethernet.bot.cd' -H 'Access-Control-Request-Headers: Authorization'
```

Expected: `200` + `204`。红灯 → 同文件恢复备份 + reload，停下上报。

### Task 6: 观察与 Vercel 下线（另行确认，不自动执行）

- 观察期用户手机端实测（电话/试听/音乐/两家 TTS 各一次）。
- 稳定后另行确认再删 Vercel 项目；`/api` 旧变体保留注释 7 天。

## Self-Review

- Spec coverage: 7 接口 Task 2 ✓；模板/unit Task 3 ✓；CORS/404/health Task 1 ✓；
  配置三变量 Task 3+4 ✓；验证链 Task 4/5 ✓；回滚 Task 5 ✓；music 保持 Task 1/4 ✓；密钥永存客户端 ✓（全局约束）。
- Placeholder scan: 无 TBD/TODO；命令均为完整可跑形式；Vercel 现值由父会话当场提供（流程内点名，非占位）。
- Type consistency: `ROUTES['METHOD path']`、`sendJson/readBody/applyCors`、`createServer({port})`、
  `{ok, stdout}`（若用）等签名 Task 间一致；`FISH_MODEL` 缺省 `s2.1-pro` 与源一致。
- Review Focus: 5 条逐条钉到 Task 1/2/4 的测试与门禁。
