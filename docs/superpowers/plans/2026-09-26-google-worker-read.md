# Worker 侧 Google 日程读取接线 — 执行计划

> 写给弱执行者：每步自带路径、行号、意图、验收判据。未经用户说「执行」不碰业务代码。
> 生成时间：2026-09-26 · 基线：`bad30cc6` · 分支 `ethernet`（不 push）

## 0. 结论（先读这段）

- 症状：云端轮读不到 Google 日程（`该能力暂不可用`），本地轮读写都通。
- 根因三件套（recon 已证实）：worker 无 director/snapshot 概念（自有三段式：`index.ts:1798` 读包 → `agentic.ts` 分类 → `index.ts:2427 executeToolCalls` 执行）；`readGoogleSelection` 直读 localStorage 在 worker 内 fail-closed（`agenticTools.ts:1022` try/catch → `GOOGLE_NOT_ENABLED`）；worker 工具链无 per-user 身份（fire 身份只有 `task.metadata.charId`，`index.ts:1101`）。
- 设计决策（待用户随「执行」一起确认）：bridge Token 用 worker 共享 secret（只是桥门禁，非用户数据）；账号选择走“前端随请求打包”（手机把自己 localStorage 的勾选每次塞进 tool_pack），worker 不存任何用户账号映射。单用户场景下这就是最简闭环；多用户也自然隔离。
- 备选（不推荐）：worker 侧存 accountId 映射——需新 KV 表 + 身份链改造，本次不做。

## 1. 前置手动操作（用户做，约 10 分钟）

1. VPS 公网桥地址确认可达（本机：`curl.exe -s https://ethernet-vps.bot.cd/google-api/api/health` → `{"status":"ok"}`）。
2. `wrangler secret put GOOGLE_BRIDGE_TOKEN`（值取 VPS `/opt/sullyos/.env` 的 `GOOGLE_BRIDGE_TOKEN`，见 handoff §六；在 worker/amsg 目录执行；命令由执行者给，用户自己敲，token 不进仓库不进聊天）。
3. Google 后台 `calendar` 写 scope + 重连（若上次没做，这次必须做，否则读新日历 403）。

## 2. 本次触碰文件清单（只许动这些）

| # | 文件 | 动什么 |
|---|---|---|
| 1 | `utils/amsgToolPack.ts`（约 28-228） | `AmsgToolPack` 加 `google?: { enabled: boolean; selection: string[]; bridgeUrl: string }`；打包函数把前端 localStorage 三件套塞进去；`isWorkerReachableUrl`（约 116）拒 127/私网 |
| 2 | `utils/activeMsgClient.ts`（约 1232-1250） | 上云打包点：读本机 `aetheros.google.enabled/selectedCalendars/bridgeUrl` 填进 tool_pack（读法照抄 `agenticTools.ts:1021-1023` 的 try/catch；缺省 = 不填，worker 侧 fail-closed 不变） |
| 3 | `utils/agenticTools.ts`（约 137-168，1018-1051） | `AgenticToolCtx` 加 `googleSelection?: {accountId,calendarId}[]`；`readGoogleSelection` 改优先读 `ctx.googleSelection`，localStorage 只留浏览器回落（函数签名不变，纯加分支） |
| 4 | `worker/amsg/src/index.ts`（约 485-521 buildToolCtx，189-214 Env） | buildToolCtx 透传 tool_pack.google → ctx + 注入 `googleFetch`（fetch 包 8-10s AbortController 超时，照抄 `utils/realtimeWorldCore.ts:69-81`；请求头 `X-Google-Bridge-Token: env.GOOGLE_BRIDGE_TOKEN` + `X-Google-Account` 由调用方透传）；Env 加 `GOOGLE_BRIDGE_URL`（var）声明 |
| 5 | `worker/amsg/wrangler.toml`（约 62-67） | vars 加 `GOOGLE_BRIDGE_URL=https://ethernet-vps.bot.cd/google-api`（secret 只走 `wrangler secret put`，不进文件） |
| 6 | 各自 `*.test.ts` | 每处改动配 TDD 单测（见 W1-W3） |

禁止：`dispatchAgenticTool` switch（google 四 case 已在）、导演 prompt（已补）、桥代码（已部署）、`worker.bundle.js` 等构建产物、任何已提交历史。

## 3. 分步执行（按序）

### W1 · tool_pack 加字段（约 40 分钟，TDD）

- [ ] 读 `utils/amsgToolPack.ts:28-51`（AmsgToolPack 形状）、`:116-132`（isWorkerReachableUrl）、`:159-228`（build）。
- [ ] 先加单测：含 google 字段的包能构造；`bridgeUrl=127.0.0.1` 判不可达；缺字段包保持旧行为。
- [ ] 再实现：`google?: { enabled: boolean; selection: string[]; bridgeUrl: string }`（selection 沿用 `accountId::calendarId` 字符串数组，与 Settings 页同形）。
- [ ] 验收：`pnpm vitest run utils/amsgToolPack.test.ts` 全绿（文件名按实际 glob 为准）。

### W2 · 前端打包 + ctx 回落（约 40 分钟，TDD）

- [ ] 读 `utils/activeMsgClient.ts:1185-1250`（打包上云点）、`utils/agenticTools.ts:1018-1051`。
- [ ] 单测：localStorage 有值 → 包里有 google 字段；无值/损坏 → 包无该字段（worker 照旧 fail-closed）。
- [ ] 实现：activeMsgClient 打包处加三行 try/catch 读取（单测 mock localStorage）；`AgenticToolCtx` 加可选 `googleSelection`；`readGoogleSelection(ctx?)` 优先用 ctx（需把调用处 `readGoogleSelection()` 改传 ctx——四个读写函数都在 `agenticTools.ts:1096-1237`，逐个改，签名从 `(ctx, args)` 本来就有 ctx，直接用）。
- [ ] 注意：`readGoogleSelection` 当前签名无参（`:1018`），改成可选参是兼容变更；确认全仓调用方只有 Gaut 四函数 + propose/execute（grep `readGoogleSelection` 核对）。
- [ ] 验收：`pnpm vitest run utils/agenticTools.google.test.ts utils/activeMsgClient.test.ts` 全绿。

### W3 · worker 透传 + secret（约 1 小时）

- [ ] 读 `worker/amsg/src/index.ts:485-521`（buildToolCtx）、`:1798-1810`（读包）、`:2427-2521`（executeToolCalls）、`:189-214`（Env）、`utils/realtimeWorldCore.ts:69-81`（超时写法）。
- [ ] buildToolCtx：`tool_pack.google` → `ctx.googleSelection`（解析 `::`，坏形状跳过，照抄 `agenticTools.ts:1040-1045`）+ `ctx.googleFetch = (path, init) => fetch(env.GOOGLE_BRIDGE_URL + path, {signal: AbortSignal.timeout(10000), headers: {...init.headers, 'X-Google-Bridge-Token': env.GOOGLE_BRIDGE_TOKEN}})`。
- [ ] `executeToolCalls` 零改（google case 已有，`:2427-2521` 只验证不断言）。
- [ ] Env + wrangler.toml 加 `GOOGLE_BRIDGE_URL`（var 进文件；TOKEN 只走 secret put，不进文件，grep 自查 `GOOGLE_BRIDGE_TOKEN` 不得出现在仓库 diff 里）。
- [ ] 验收：worker 侧单测（按该目录现有单测模式）+ `pnpm vitest run worker/amsg` 相关文件绿；`git diff` 无 token 值。

### W4 · 端到端验证（约 30 分钟，用户配合）

- [ ] 本地 `vitest` 定向回归：`utils/agenticTools.google.test.ts utils/airp/ utils/amsgToolPack.test.ts` 全绿。
- [ ] 部署 worker（`wrangler deploy`， reconfig 由用户确认窗口；多窗口施工期间部署前群里吱一声）。
- [ ] 手机走云端轮问日程：输入框上方小提示确认为云端轮 → 应读出事件；再问一次写 → 写后云端轮应读到新事件（读写合口）。
- [ ] 回退： secretary 失败则 `wrangler rollback`（版本号记在报告里），本地行为不受影响（localStorage 回落分支未动）。

## 4. 风险与不做

- worker 无 per-user 身份：本计划用“随请求打包”绕开，不建映射表；若未来要服务端定时拉取，再立项。
- refresh token 过期：表现仍是 `GOOGLE_REAUTH_REQUIRED`，需用户在设置页重连；worker 不碰 OAuth。
- bridge Token 进 worker 是共享 secret：桥门禁只鉴权调用方，不隔离用户数据；用户数据隔离靠每请求的 accountId。
- `127.0.0.1` 在 CF worker 必死（`wrangler.toml:13 global_fetch_strictly_public`）：bridgeUrl 必须用公网地址，W1 的可达判定即为此。
- 端口 8841 / CORS 双带 / Caddy 两处改三条红线保持（本次桥不动）。

## 5. 工时估计

W1 40 分钟 + W2 40 分钟 + W3 1 小时 + W4 30 分钟 ≈ 3 小时（含单测与用户侧 secret 操作等待）。
