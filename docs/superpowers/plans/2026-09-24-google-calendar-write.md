# Google 写操作（char 主动创建）执行计划

> For agentic workers: 按 Task 顺序执行，每步 checkbox 跟踪。工作树 `feat/google-calendar`，保持未提交。

**Goal:** char 能主动创建日历事件与待办：先预览、用户点头才写。

**Spec:** `docs/superpowers/specs/2026-09-23-google-calendar-design.md` §12（及 §2 范围行）。

**前置手动步骤（用户做，localhost）：** Auth Platform → Data Access 多勾 `calendar.events`、`tasks` → 设置页 Google 区块重连一次。未做之前写入口调了会 403，单测不受影响。

## Global Constraints

- 不 commit；单测 stub 上游；含中文文件字节自查；其余沿用主 plan Global Constraints。

## W1：纯函数出参构造（`utils/googleCalendar.ts` 加导出加测试）

- `buildEventBody({ title, dateKey, timeText?, location?, description? }): { start, end, summary, location?, description? }`——全天只有 `start.date/end.date`（次日），有时刻用带时区偏移的 `dateTime`（调用方传 `timeZone`，缺省沿用事件既有口径）。
- `buildTaskBody({ title, dueKey?, notes? }): { title, due?, notes? }`——无 due 不带 `due` 键。
- 测试：全天/时刻/无 due 三断言。Run: `pnpm vitest run utils/googleCalendar.test.ts`，Expected: PASS。

## W2：桥写入口（`vps-backend/src/google/googleBridge.js` 加端点加测试）

- `POST /api/events` body `{ accountId, calendarId, event }` → POST `.../calendars/{id}/events`，透传响应；`POST /api/tasks` body `{ accountId, tasklist?, task }`（缺省 `@default`）→ POST tasks insert，透传响应。同 no-store、同 token 门、同 sanitize、同 401 口径。
- 测试（`googleBridge.test.ts` 追加，stub 上游）：exchange 建账后，POST 写入口返回透传体；无 token 401；上游 403 透状态码。Run: `pnpm vitest run vps-backend/src/google/`，Expected: PASS。

## W3：前端客户端（`utils/googleBridge.ts` 加两个 wrapper 加测试）

- `createGoogleEvent({ accountId, calendarId, event })`、`createGoogleTask({ accountId, tasklist?, task })`（`googleBridgeFetch('/api/...')`，`X-Google-Account` 头）。
- 测试：断言路径、头、body 原样透传。Run: `pnpm vitest run utils/googleBridge.test.ts`，Expected: PASS。

## W4：agent 工具预览确认环（`utils/agenticTools.ts` 加两函数加 dispatch 加测试）

- `proposeGoogleCreate(ctx, { kind: 'event'|'task', ...fields })`：纯函数不联网，用 W1 构造 canonical payload，返回 `{ summary（人话预览，含目标日历/清单、标题、时间） , payload }`。
- `executeGoogleCreate(ctx, { kind, payload, confirmed })`：`confirmed !== true` 直接抛 `GOOGLE_NOT_CONFIRMED`（fetch stub 必须零调用）；为 true 才调 W3 落对应桥入口。
- dispatch 新 case：`google_create_propose`、`google_create_execute`（风格先读 dispatch 原文确认）。
- 工具描述语带硬规则：永远先 propose、用户点头才 execute、时间模糊先问。
- 测试：无确认抛错且零 fetch；有确认写透传；proposal 人话含三要素。Run: `pnpm vitest run utils/agenticTools.google.test.ts utils/agenticTools.test.ts`，Expected: PASS。

## W5：收尾

- FFFD 自查 CLEAN；`git status` 无计划外文件；相关套件全绿（W1-W4 命令）；未提交，报告。
