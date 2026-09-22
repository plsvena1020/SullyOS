# 流式终止事件收口（SSE terminal-close）设计

> 2026-09-13。修复「人物关系 NPC 生成永远卡在『生成中』」的根因，同一根因覆盖所有走透明流式升级的旁路 LLM 调用，以及 VPS 主代理的上游读取循环。

## 背景与根因

全局 fetch 拦截器（`context/OSContext.tsx`）在主 API 开「流式输出」时，把 40+ 处硬编码 `stream:false` 的旁路调用透明升级为 SSE（`utils/streamUpgrade.ts` 的 `upgradeChatBodyToStream`），响应侧由 `assembleUpgradedResponse` 攒齐拼回标准 JSON。

问题出在 `assembleUpgradedResponse` 用 `await response.text()` 等**整条连接关闭**，而不是等 SSE 终止事件（`finish_reason` / `data: [DONE]`）。部分 OpenAI 兼容代理（仓库 `utils/safeApi.ts` 注释明确记录过该类行为）在发完终止事件后保持 socket 存活，`response.text()` 永不返回：

- 用户可见症状：旁路调用永远停在「生成中...」（人物关系生成、查手机生成、日程、记忆总结等所有升级路径）。
- 聊天主路径不受影响，因为 `readBodyWithStreaming`（`utils/safeApi.ts`）有「终止事件即 `reader.cancel()`」短路（2026-08-19 Qixi 修复），而 `streamUpgrade` 这条路径漏了同样的守卫。

复现证据（2026-09-13，CDP 实测）：mock 上游发完 `[DONE]` 后不关连接 → UI 卡 20s 不动；手动关闭 mock 连接后 2.5s 内弹窗关闭、NPC 出现。拦截器确实把请求体升级为 `stream:true`。

同一 bug 类也存在于 VPS 主代理：`worker/main-agent/src/index.js` 的 `llmStream` 收完 `finish_reason`/`[DONE]` 后继续等上游 EOF；上游保持连接时只能等 `LLM_TIMEOUT_MS`（默认 120s）abort，随后被 `runAgentLoop` 当作失败供应商触发 fallback 重试 —— 已完成的一次生成可能被重复计费。

## 修复设计

### 1. 客户端：终止事件收口（主修）

`utils/safeApi.ts` 新增导出：

```ts
export const TERMINAL_READ_GRACE_MS = 1500;
export async function readBodyTextUntilTerminal(response, graceMs = TERMINAL_READ_GRACE_MS): Promise<string>
```

语义：

- 增量读取 response body，同时喂给现有 `SseAssembler` 判终止；
- 见 `data: [DONE]` → 立即 `reader.cancel()`，返回已读原始文本；
- 只见 `finish_reason` → 给 `graceMs` 宽限（`stream_options.include_usage` 的 usage chunk 常紧跟 `finish_reason` 之后），期间无新数据则取消；
- 非 SSE / 无 body → 行为与 `response.text()` 等价；
- 取消后 pending `reader.read()` 按 Web Streams 规范以 `{done:true}` 落定，循环自然退出。

`utils/streamUpgrade.ts` 的 `assembleUpgradedResponse` 把 `await response.text()` 换成该函数，其余判定（`isSseResponseText` / `parseSseToCompletion` / 非 SSE 原文重新包装）不变。

### 2. 客户端：关系生成超时兜底

`utils/relationshipGen.ts` 从裸 `fetch` 换 `safeFetchJson(url, init, 0, 180_000)`：

- 上游彻底黑洞（无终止事件、无断流）时，180s 后 abort 抛错，UI 以明确错误收尾而不是无限「生成中」；
- 显式 `maxRetries=0`，守「chat/completions 不自动重试」的计费红线；
- 顺带获得 `safeResponseJson` 的 SSE/HTML 容错解析能力；
- AbortError / timeout 文案统一映射为「生成超时，请重试」。

### 3. 服务端：主代理终止事件收口

`worker/main-agent/src/index.js` 的 `llmStream` 读循环：见到 `[DONE]` 或任一 choice 的 `finish_reason` 即 `break` 出读循环，由既有 `finally` 取消上游 reader。不再等上游 EOF，不触发 120s abort 假失败与 fallback 重复计费。

## 非目标

- 不改聊天主路径 `readBodyWithStreaming`（其收口语义已正确，usage 丢失行为维持现状）。
- 不引入任何自动重试逻辑。
- `utils/relationshipContactGen.ts` 同样是裸 fetch，但不在本次范围（同 bug 类，后续可顺手迁移）。
- 不为全 App 旁路调用统一加超时（超出本次根因）。

## 验收

- `utils/streamUpgrade.test.ts`：「[DONE] 后不关连接立即收口」「无 [DONE] 由 finish_reason 收口」两条（修复前超时失败）。
- `worker/main-agent/src/index.test.ts`：「上游永不关闭 socket → 主代理仍在终止事件处收口并送出 `[DONE]`」。
- 全量 vitest + `tsc --noEmit`（触碰文件零新增）+ mojibake 护栏 + FFFD 字节扫 0。
- `corepack pnpm@9.15.9 build:workers` 重建 main-agent bundle（src 逐字拷贝）。
- 手动：dev 重走「角色 → 设定 → 人物关系 → 生成」出 NPC；或 CDP + socket-holding mock 自动验证。
