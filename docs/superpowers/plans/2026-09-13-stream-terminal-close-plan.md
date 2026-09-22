# 流式终止事件收口 执行计划

> 2026-09-13 · 配套设计 `docs/superpowers/specs/2026-09-13-stream-terminal-close-design.md`
> 执行环境：Windows / PowerShell 7 / 仓库 `D:\sullyos`。包管理器用 `corepack pnpm@9.15.9`（pnpm 不在 PATH）。
> 每次改写含中文的文件后：只用专用读写工具、UTF-8 无 BOM；收尾跑 mojibake 护栏与 FFFD 字节扫。

## 阶段 0 · 测试先行（红）

### 0.1 `utils/streamUpgrade.test.ts` 新增两条 lingering-stream 测试

文件顶部 import 改为：

```ts
import { describe, it, expect, vi } from 'vitest';
```

（原为 `import { describe, it, expect } from 'vitest';`，只加 `vi`。）

在 `describe('assembleUpgradedResponse', ...)` 块的最后一个用例之后（文件第 69 行 `});` 之前）追加：

```ts
    it('上游发完 [DONE] 后不关连接 → 立即拼回 JSON，不等待 socket 关闭', async () => {
        const cancelled = vi.fn();
        const upstream = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"收口"}}]}\n\n'));
                controller.enqueue(enc.encode('data: [DONE]\n\n'));
                // 故意不 close：部分兼容代理发完终止事件后仍保持连接。
            },
            cancel() { cancelled(); },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('收口');
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('缺少 [DONE] 时由 finish_reason 收口（宽限后取消连接）', async () => {
        const cancelled = vi.fn();
        const upstream = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"无DONE"}}]}\n\n'));
                controller.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
            },
            cancel() { cancelled(); },
        }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('无DONE');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(cancelled).toHaveBeenCalledOnce();
    });
```

### 0.2 跑红（预期失败）

```powershell
corepack pnpm@9.15.9 vitest run utils/streamUpgrade.test.ts
```

预期：新增两条失败（第一条/第二条挂到 vitest 默认超时，报 test timed out）；原有用例全绿。

## 阶段 1 · Fix 1 客户端收口（绿）

### 1.1 `utils/safeApi.ts` 新增 `readBodyTextUntilTerminal`

位置：第 347 行 `readBodyWithStreaming` 函数结束后、第 349 行 `safeFetchJson` 的 JSDoc 之前，插入：

```ts
/** 终止事件（[DONE] / finish_reason）之后留给尾随 usage chunk 的宽限窗口。 */
export const TERMINAL_READ_GRACE_MS = 1500;

/**
 * 读响应全文，但见 SSE 终止事件即收口：
 *  - `data: [DONE]` → 立即取消连接，返回已读原始文本；
 *  - 仅见 finish_reason → 给 graceMs 宽限（include_usage 的 usage chunk 常紧跟其后），
 *    到期无新数据则取消。
 * 上游发完终止事件却保持连接不关时（部分 OpenAI 兼容代理的真实行为），调用方
 * 得以立刻拿到结果，而不是把 socket 吊在那里等它自己断。
 * 非 SSE 响应（或 body 不可读）→ 行为等价于 response.text()。
 */
export async function readBodyTextUntilTerminal(
    response: Response,
    graceMs: number = TERMINAL_READ_GRACE_MS,
): Promise<string> {
    if (!response.body?.getReader) return response.text();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const asm = new SseAssembler();
    let raw = '';
    let pending = '';
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelNow = () => {
        try { void reader.cancel(); } catch { /* 已关闭 */ }
    };
    const clearGrace = () => {
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    };
    const armGrace = () => {
        clearGrace();
        graceTimer = setTimeout(() => { graceTimer = null; cancelNow(); }, graceMs);
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const textChunk = decoder.decode(value, { stream: true });
            raw += textChunk;
            pending += textChunk;
            const lastNl = pending.lastIndexOf('\n');
            if (lastNl < 0) continue;
            const complete = pending.slice(0, lastNl);
            pending = pending.slice(lastNl + 1);
            let explicitDone = false;
            for (const line of complete.split(/\r?\n/)) {
                const delta = asm.feedLine(line);
                if (!delta.done) continue;
                if (line.startsWith('data:') && line.slice(5).trim() === '[DONE]') {
                    explicitDone = true;
                    break;
                }
                armGrace();
            }
            if (explicitDone) {
                clearGrace();
                cancelNow();
                break;
            }
        }
        const tail = decoder.decode();
        if (tail) {
            raw += tail;
            pending += tail;
        }
        if (pending.trim()) asm.feedLine(pending.trim());
        return raw;
    } finally {
        clearGrace();
    }
}
```

要点：`SseAssembler` 是同文件私有类，直接可用；宽限计时器在正常结束/异常时都要清掉。

### 1.2 `utils/streamUpgrade.ts` 接入

- 第 22 行 import 改为：
  `import { isSseResponseText, parseSseToCompletion, readBodyTextUntilTerminal } from './safeApi';`
- 第 60-61 行函数体开头 `const text = await response.text();` 改为：
  `const text = await readBodyTextUntilTerminal(response);`
- 顶部该函数 JSDoc（54-59 行）补一句：终止事件后主动取消连接，不等待上游 socket 关闭。

### 1.3 跑绿

```powershell
corepack pnpm@9.15.9 vitest run utils/streamUpgrade.test.ts utils/safeApi.stream.test.ts utils/safeApi.extractJson.test.ts
```

预期全绿（含新增两条；原三条 assembleUpgradedResponse 用例不回归）。

## 阶段 2 · Fix 2 关系生成超时兜底

`utils/relationshipGen.ts`：

1. 第 18 行 import 改为：`import { extractContent, extractJson, safeFetchJson } from './safeApi';`
2. 第 30 行附近常量区追加：
   ```ts
   /** 关系生成单次调用的硬上限：UI 不允许无限「生成中」；主代理上行 120s abort，这里留余量。 */
   export const REL_GEN_TIMEOUT_MS = 180_000;
   ```
3. 第 91-101 行的裸 fetch 段整体替换为：

```ts
    let data: any;
    try {
        data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 1.0,
            }),
        }, 0, REL_GEN_TIMEOUT_MS);
    } catch (e: any) {
        if (e?.name === 'AbortError' || /aborted|timeout/i.test(String(e?.message || ''))) {
            throw new Error('生成超时，请重试');
        }
        throw e;
    }
    const content = extractContent(data);
```

（原第 100 行 `if (!res.ok) throw new Error(\`LLM ${res.status}\`);` 与 `res.json()` 一并删除；safeFetchJson 内部已处理非 2xx 与解析。）

4. 文件头注释（第 12-14 行附近）不用改。

验证：`corepack pnpm@9.15.9 vitest run utils/relationshipChat.test.ts`（无关但确保没碰坏邻居），本文件无单测；以 tsc 与全量门禁兜底。

## 阶段 3 · Fix 3 主代理终止事件收口

### 3.1 `worker/main-agent/src/index.js` 的 `llmStream`（283-316 行读循环）

替换为（保持其余逻辑不动）：

```js
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      let sawTerminal = false;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        // 终止事件即收口：部分代理发完 [DONE]/finish_reason 后仍保持 socket，
        // 等 EOF 会被 120s abort 成「假失败」并触发 fallback 重试（重复计费）。
        if (data === DONE_MARKER) { acc.finishReason = acc.finishReason || 'stop'; sawTerminal = true; break; }
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        const choice = chunk && chunk.choices && chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          acc.text += delta.content;
          if (emitText) emitText(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            const slot = tcMap.get(i) || { id: '', name: '', arguments: '' };
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.name += tc.function.name;
            if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
            tcMap.set(i, slot);
          }
        }
        if (choice.finish_reason) { acc.finishReason = choice.finish_reason; sawTerminal = true; break; }
      }
      if (sawTerminal) break;
    }
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch { /* 忽略 */ }
  }
```

（相对原文的差异：仅新增 `sawTerminal` 标志、`[DONE]` 分支 `break`、`finish_reason` 分支 `break`、外层 `if (sawTerminal) break;`。）

### 3.2 `worker/main-agent/src/index.test.ts` 新增回归用例

在「聊天 SSE 心跳（静默期保活）」describe 之后追加（沿用文件既有 `AGENT` 常量与 `vi.stubGlobal` 模式；确保该 describe 结束处已 `vi.unstubAllGlobals()` 或本用例自身 finally 清理）：

```ts
describe('上游发完终止事件但不关连接', () => {
    it('主代理在 [DONE]/finish_reason 处收口，不等待上游 socket 关闭', async () => {
        try {
            vi.stubGlobal('fetch', vi.fn(async () => new Response(
                new ReadableStream({
                    start(controller) {
                        const enc = new TextEncoder();
                        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"收口"}}]}\n\n'));
                        controller.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
                        controller.enqueue(enc.encode('data: [DONE]\n\n'));
                        // 故意不 close：模拟保持连接的代理
                    },
                }),
                { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
            )));
            const res = await worker.fetch(
                new Request(`${AGENT}/agent/v1/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
                }),
                { LLM_BASE_URL: 'https://api.example.com/v1', LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_TIMEOUT_MS: '120000' },
                { waitUntil: () => {} },
            );
            expect(res.status).toBe(200);
            const text = await res.text();
            expect(text).toContain('"content":"收口"');
            expect(text).toContain('data: [DONE]');
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
```

### 3.3 跑绿

```powershell
corepack pnpm@9.15.9 vitest run worker/main-agent/src/index.test.ts
```

预期全绿（该用例在 3.1 之前会挂到测试超时）。

## 阶段 4 · 门禁

1. `corepack pnpm@9.15.9 vitest run`（全量；storageOptimize 4 项并发抖动属已知，若红单跑该文件确认）。
2. `corepack pnpm@9.15.9 tsc --noEmit`：触碰文件（safeApi/streamUpgrade/relationshipGen）在输出中零命中；存量约 45 个错误无关。
3. `corepack pnpm@9.15.9 vitest run utils/mojibakeGuard.test.ts`。
4. FFFD 字节扫：对 `utils/safeApi.ts`、`utils/streamUpgrade.ts`、`utils/streamUpgrade.test.ts`、`utils/relationshipGen.ts`、`worker/main-agent/src/index.js`、`worker/main-agent/src/index.test.ts`、新增两份 md，用 PowerShell 读字节 + `[char]0xFFFD` 计数，全部为 0。

## 阶段 5 · 构建与记账

1. `corepack pnpm@9.15.9 build:workers`（main-agent 的 `worker.bundle.js` 是 `src/index.js` 的逐字拷贝，须与源码同提交）。
2. `notes/ethernet-branch-context.md` 末尾「仓库现状与坑」追加一条（格式仿第 86/87 条）：

```
- ✅ 流式终止事件收口（2026-09-13）：……（症状、根因、三处修复、门禁结果、部署状态）
```

## 边界与禁止

- 不碰 `context/OSContext.tsx` 拦截器逻辑、不碰 `readBodyWithStreaming`。
- 不为 chat/completions 加任何自动重试。
- 不改 `utils/relationshipContactGen.ts`（同 bug 类，本次不动）。
- 不顺手重构、不格式化无关 hunk；提交只含本次文件。
- 部署（push / VPS restart）等用户明确指示再做。
