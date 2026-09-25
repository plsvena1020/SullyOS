# Companion Memory-Chain Implementation Plan (Plan 3a/3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 游戏陪玩记忆链（人设不断＋按字数小结＋5合1大结＋向量入库＋退出静默记），全部 Web 侧可测。

**Architecture:** 纯函数 Reducer（`MiniReducer` 字数攒单、`BigReducer` 5合1）+ 可注入的 `summarizeFn`/`store`（测试用 stub，不碰 LLM/DB）；退出钩子仿 `DateSession`（visibilitychange + unmount）；prompt 复标准序，entryPoint 用游戏专值。平板原生是 Plan 3b（另案，等外部探针）。

**Tech Stack:** TS, vitest;复用 `summarizeConversation` 风格（第一人称短记忆）、`vectorizeAndStore`（cosine 去重）、`retrieveMemories`/`injectMemoryPalace`（召回不管）。

**Spec:** `docs/superpowers/specs/2026-09-24-game-companion-design.md` §8（拟人脑＋精简＋手动；退出静默记）

**Worktree:** `.worktrees/game-companion` (`feat/game-companion`, continues — do NOT merge ethernet again; base is current tip).

## Global Constraints

- 会话期间永不调用 `runCallMemoryPalacePostFlow`、`markAmsgStateDirty(_ForAll)`、`processNewMessagesWithAutoArchive`（测试不断言源码，但 reviewer 查 diff；新模块不得 import 以上三者——用 `rg` 自查为证）。
- 剧本原文不入库：入库的只有模型写的短记忆/结论条目；快照哈希计数延续 Plan 1。
- 总开关 `companion-game:record`（`localStorage`，Plan 1 已有，默认 `'1'`）关闭时整条链路零调用。
- 静默：入库失败吞掉（返回状态，不弹 toast、不抛到 UI）。
- 常量：`MINI_BUDGET_CHARS = 3000`、`BIG_THRESHOLD = 5`（均可配， Plan 不做 UI 配置页）。
- No new npm dependencies. Windows pwsh.

## Review Focus

- 阈值边界恰 3000 字触发一次不多不少 — Task 1 test pins it.
- 空缓冲/空小结不调 summarizeFn（零 LLM 花费） — Task 1/2 tests pin zero-call.
- store 抛错不炸 UI 且返回失败态 — Task 4 test pins silent failure.
- 退出钩子重复触发只写一次（once-guard） — Task 4 test pins single store call on double fire.
- 开关关闭时 summarizeFn 与 store 零调用 — Task 4 test pins it.

---

### Task 1: MiniReducer (pure, no LLM/DB)

**Files:**
- Create: `utils/gameMemory.ts`
- Create: `utils/gameMemory.test.ts`

**Interfaces:**
- Consumes: nothing (pure; caller feeds line texts).
- Produces: `MiniReducer` class: `push(text, summarizeFn) -> string|null` (note when budget reached), `notes: string[]`, `MINI_BUDGET_CHARS = 3000` (Tasks 2–4).

```ts
export const MINI_BUDGET_CHARS = 3000;

export class MiniReducer {
  private acc = '';
  readonly notes: string[] = [];
  push(text: string, summarizeFn: (chunk: string) => string): string | null {
    if (!text) return null;
    this.acc += text;
    if (this.acc.length < MINI_BUDGET_CHARS) return null;
    const note = summarizeFn(this.acc);
    this.acc = '';
    if (note) this.notes.push(note);
    return note || null;
  }
}
```

(Above is the full implementation — transcribe verbatim; `summarizeFn` returning `''` means "nothing worth keeping", still resets accumulator.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { MINI_BUDGET_CHARS, MiniReducer } from './gameMemory';

describe('MiniReducer', () => {
  it('accumulates silently below budget with zero summarize calls', () => {
    const fn = vi.fn((s: string) => `note:${s.length}`);
    const r = new MiniReducer();
    expect(r.push('a'.repeat(2999), fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(r.notes).toEqual([]);
  });

  it('fires exactly once at the boundary and resets', () => {
    const fn = vi.fn((s: string) => `note:${s.length}`);
    const r = new MiniReducer();
    r.push('a'.repeat(2999), fn);
    expect(r.push('b', fn)).toBe('note:3000');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.notes).toEqual(['note:3000']);
    expect(r.push('c', fn)).toBeNull();
  });

  it('ignores empty input and empty notes', () => {
    const fn = vi.fn(() => '');
    const r = new MiniReducer();
    expect(r.push('', fn)).toBeNull();
    expect(r.push('x'.repeat(5000), fn)).toBeNull();
    expect(r.notes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run utils/gameMemory.test.ts`
Expected: FAIL with "Cannot find module './gameMemory'".

- [ ] **Step 3: Write implementation** (transcribe the class block above verbatim into `utils/gameMemory.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run utils/gameMemory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/gameMemory.ts utils/gameMemory.test.ts
git commit -m "feat: add game mini-summary reducer with char budget"
```

---

### Task 2: BigReducer + archive with injected store

**Files:**
- Modify: `utils/gameMemory.ts` (append), `utils/gameMemory.test.ts` (append)

**Interfaces:**
- Consumes: `MiniReducer.notes` strings, injected `summarizeFn` + `store` (real wiring: `summarizeConversation`-style fn and `vectorizeAndStore` — injected, never imported here).
- Produces: `BigReducer` (`BIG_THRESHOLD = 5`), `archiveGameMemory`, `GameMemoryStore` type (Task 4 exit flow).

```ts
export const BIG_THRESHOLD = 5;

export interface GameMemoryStore {
  saveBig(summary: string): Promise<void> | void;
  saveFinal(note: string): Promise<void> | void;
}

export class BigReducer {
  private minis: string[] = [];
  readonly bigs: string[] = [];
  push(note: string, summarizeFn: (joined: string) => string): string | null {
    if (!note) return null;
    this.minis.push(note);
    if (this.minis.length < BIG_THRESHOLD) return null;
    const big = summarizeFn(this.minis.join('\n'));
    this.minis = [];
    if (big) this.bigs.push(big);
    return big || null;
  }
}

export async function archiveGameMemory(
  store: GameMemoryStore, kind: 'big' | 'final', text: string,
): Promise<'stored' | 'skipped-empty'> {
  if (!text.trim()) return 'skipped-empty';
  if (kind === 'big') await store.saveBig(text);
  else await store.saveFinal(text);
  return 'stored';
}
```

- [ ] **Step 1: Append the failing tests**

```ts
it('combines 5 minis into one big and resets', () => {
  const fn = vi.fn((s: string) => `BIG:${s.split('\n').length}`);
  const b = new BigReducer();
  let out: string | null = null;
  for (let i = 0; i < 5; i += 1) out = b.push(`m${i}`, fn);
  expect(fn).toHaveBeenCalledTimes(1);
  expect(out).toBe('BIG:5');
  expect(b.bigs).toEqual(['BIG:5']);
});

it('archives through the injected store, skips empties', async () => {
  const calls: Array<[string, string]> = [];
  const store: GameMemoryStore = {
    saveBig: (s) => { calls.push(['big', s]); },
    saveFinal: (s) => { calls.push(['final', s]); },
  };
  expect(await archiveGameMemory(store, 'big', '  ')).toBe('skipped-empty');
  expect(await archiveGameMemory(store, 'big', 'B1')).toBe('stored');
  expect(await archiveGameMemory(store, 'final', 'F1')).toBe('stored');
  expect(calls).toEqual([['big', 'B1'], ['final', 'F1']]);
});
```

(import `archiveGameMemory, BIG_THRESHOLD, BigReducer, GameMemoryStore` — extend the Step-1 import line; also assert `BIG_THRESHOLD === 5` in the first test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run utils/gameMemory.test.ts`
Expected: FAIL (no `BigReducer` export).

- [ ] **Step 3: Append implementation** (transcribe the block above verbatim).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run utils/gameMemory.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/gameMemory.ts utils/gameMemory.test.ts
git commit -m "feat: add game big-summary reducer and archive gate"
```

---

### Task 3: Exit flow (pure) + record-gate

**Files:**
- Modify: `utils/gameMemory.ts` (append), `utils/gameMemory.test.ts` (append)

**Interfaces:**
- Consumes: minis/bigs arrays, session headline (Plan 1 `SessionSnapshot.headline`), injected `summarizeFn` + `store`, record flag string.
- Produces: `runGameExitMemory(...) -> 'stored'|'skipped-off'|'skipped-empty'|'failed-silent'` (Task 4 hook).

```ts
export interface GameExitInput {
  minis: string[];
  bigs: string[];
  headline: string;
  recordOn: boolean;
  summarizeFn: (input: string) => string;
  store: GameMemoryStore;
}

export async function runGameExitMemory(input: GameExitInput): Promise<'stored' | 'skipped-off' | 'skipped-empty' | 'failed-silent'> {
  if (!input.recordOn) return 'skipped-off';
  const material = [...input.bigs, ...input.minis, input.headline].filter((s) => s.trim()).join('\n');
  if (!material) return 'skipped-empty';
  const note = input.summarizeFn(material);
  if (!note.trim()) return 'skipped-empty';
  try {
    await archiveGameMemory(input.store, 'final', note);
    return 'stored';
  } catch {
    return 'failed-silent';
  }
}
```

- [ ] **Step 1: Append the failing tests**

```ts
it('exit flow respects the record flag and swallows store errors', async () => {
  const fn = vi.fn((s: string) => `EXIT:${s.length}`);
  const calls: string[] = [];
  const store: GameMemoryStore = {
    saveBig: () => {},
    saveFinal: (s) => { calls.push(s); },
  };
  expect(await runGameExitMemory({ minis: [], bigs: [], headline: '', recordOn: false, summarizeFn: fn, store })).toBe('skipped-off');
  expect(fn).not.toHaveBeenCalled();
  expect(await runGameExitMemory({ minis: ['m'], bigs: [], headline: '共 10 行', recordOn: true, summarizeFn: fn, store })).toBe('stored');
  expect(calls).toHaveLength(1);
  const boom: GameMemoryStore = {
    saveBig: () => {},
    saveFinal: () => { throw new Error('db down'); },
  };
  expect(await runGameExitMemory({ minis: ['m'], bigs: [], headline: 'h', recordOn: true, summarizeFn: fn, store: boom })).toBe('failed-silent');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run utils/gameMemory.test.ts`
Expected: FAIL (no `runGameExitMemory` export).

- [ ] **Step 3: Append implementation** (transcribe verbatim).

- [ ] **Step 4: Run tests, expect PASS (6 tests), commit**

```bash
git add utils/gameMemory.ts utils/gameMemory.test.ts
git commit -m "feat: add game exit memory filter with silent failure"
```

---

### Task 4: Wiring — exit hook + game prompt entry + app mount

**Files:**
- Create: `utils/useGameExitMemory.ts` (hook: once-guard + visibilitychange/hidden + unmount)
- Create: `utils/useGameExitMemory.test.ts` (jsdom: double-fire → single store call; flag off → zero calls)
- Modify: `apps/CompanionGameApp.tsx` (mount hook with session mini/big state — minimal: hook owns reducers internally, app passes `recordOn` from the existing memory toggle + headline getter)
- Prompt path: verify-first — read `utils/memoryPalace/pipeline.ts:1191` surroundings + `utils/chatRequestPayload.ts:302` order, add game `entryPoint` wiring minimal; test asserts `injectMemoryPalace` receives the game entry (mock pipeline module per `utils/appIcon.test.ts` vi.mock factory pattern)

**Interfaces:**
- Consumes: Tasks 1–3, Plan 1 `SessionSnapshot` + `companion-game:record` flag.
- Produces: mounted behavior (Plan 3b tablet + overlay reuse the same hook).

Hook contract (implement exactly):

```ts
export function useGameExitMemory(args: {
  recordOn: boolean;
  getMaterial: () => { minis: string[]; bigs: string[]; headline: string };
  summarizeFn: (input: string) => string;
  store: GameMemoryStore;
}): void {
  const ran = useRef(false);
  useEffect(() => {
    const fire = () => {
      if (ran.current) return;
      ran.current = true;
      void runGameExitMemory({ ...args.getMaterial(), recordOn: args.recordOn, summarizeFn: args.summarizeFn, store: args.store });
    };
    const onVis = () => { if (document.visibilityState === 'hidden') fire(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      fire();
    };
  }, []);
}
```

(`args` in deps intentionally omitted: fire-once semantics; document with comment. `summarizeFn`/`store` real wiring — `summarizeConversation`-style + `vectorizeAndStore` adapter — lands here; keep the adapter to 10 lines calling the real imports.)

- [ ] **Step 1: Write hook test first** (jsdom, extend the waived createRoot+act harness from Plan 1): mount with recordOn true + stub store → dispatch `visibilitychange` hidden twice + unmount → store called exactly once; recordOn false → zero calls.
- [ ] **Step 2: RED, implement, GREEN** (`pnpm vitest run utils/useGameExitMemory.test.ts apps/CompanionGameApp.test.tsx`), mount in app (pass `recordOn` from existing toggle state, headline from a module-level `GameSession` instance fed by the channel subscription — extend the app minimally, no redesign).
- [ ] **Step 3: Prompt entryPoint** (verify-first per above; minimal diff; test pins the game entry value).
- [ ] **Step 4: Full suite `pnpm vitest run` (new failures only gate), commit.**

```bash
git add utils/useGameExitMemory.ts utils/useGameExitMemory.test.ts utils/gameMemory.ts utils/gameMemory.test.ts apps/CompanionGameApp.tsx apps/CompanionGameApp.test.tsx
git commit -m "feat: wire game exit memory hook and prompt entry"
```

---

## Plan 3b preview (not in this plan, awaiting research)

Tablet native service (MediaProjection, ImageReader ROI 2–3fps, ML Kit zh-Hant, overlay, local HTTP for WebView polling) + PTT STT. Consumes channel shapes, `companion-game:record` flag, and this plan's exit-hook pattern.
