# 透视窗三端扩展执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一套 React/Vite 核心跑在 Web、Android、Windows 三端，透视窗统一记录应用会话。

**Architecture:** 共享 TypeScript 状态机 + `utils/platform` 桥 + 薄原生壳 + 用户自建 Worker+D1。

**Tech Stack:** React 18, TypeScript, Vite 5, IndexedDB, Capacitor 6, Tauri 2, Cloudflare Workers, D1, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-13-perspective-multidevice-design.md`

## Global Constraints

- pnpm only: `corepack pnpm@9.15.9` (`package.json:54`).
- Write files only with dedicated file tools; never shell redirection.
- Commit messages in English; never put U+FFFD literal in tool args.
- `docs/design-system.md` is the only visual system; no new visual language.
- `apps/`, `components/`, `context/` must not import `@capacitor/*` or `@tauri-apps/*`.
- Windows Rust must not call window-title APIs (`GetWindowText*` zero hits).
- Android must not use accessibility service or `QUERY_ALL_PACKAGES`.
- Tokens never enter RealtimeConfig, main IDB, localStorage, backups, logs.
- tsc baseline 45 errors; touched files zero new hits.
- After touching Chinese files run `utils/mojibakeGuard.test.ts`.

---

### Task 0: Phase 0 Spike

**Files:**
- Create: `docs/superpowers/reports/2026-09-13-three-platform-spike.md`
- Create (spike only): `capacitor.config.ts`, `android/**`, `src-tauri/**`
- Modify: `package.json`, `pnpm-lock.yaml`, `.gitignore`

- [ ] **Step 1: Record baseline in worktree**

Run: `corepack pnpm@9.15.9 vitest run utils/perspective.test.ts utils/mojibakeGuard.test.ts`
Expected: PASS (20 tests).

- [ ] **Step 2: Install deps in worktree**

Run: `corepack pnpm@9.15.9 install --registry=https://registry.npmjs.org/`
Expected: exit 0.

- [ ] **Step 3: Minimal Android shell**

Run: add Capacitor 6 deps, `vite build`, `npx cap add android`, `npx cap sync android`.
Expected: `android/app/src/main/assets/public/index.html` exists.

- [ ] **Step 4: Minimal Windows shell**

Run: add `@tauri-apps/cli@^2`, `@tauri-apps/api@^2`, `npx tauri init`, `npx tauri dev`.
Expected: window opens, wide=narrow layouts OK, IDB persists after restart.

- [ ] **Step 5: Write spike report and decide go/no-go**

If IDB does not persist on either shell, stop and ask. Otherwise proceed.

- [ ] **Step 6: Commit spike**

```bash
git add docs/superpowers/reports/2026-09-13-three-platform-spike.md docs/superpowers/specs/2026-09-13-perspective-multidevice-design.md docs/superpowers/plans/2026-09-13-perspective-multidevice-plan.md
git commit -m "docs(perspective): three-platform spec, plan, spike report"
```

### Task 1: Platform bridge

**Files:**
- Create: `utils/platform/types.ts`, `utils/platform/detect.ts`, `utils/platform/bridge.ts`, `utils/platform/native.ts`, `utils/platform/runtime.ts`
- Test: `utils/platform/detect.test.ts`, `utils/platform/bridge.test.ts`, `utils/platform/runtime.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// utils/platform/detect.test.ts
import { describe, expect, it, vi } from 'vitest';
import { detectRuntime, getCapabilities } from './detect';
describe('detectRuntime', () => {
  it('plain browser is web', () => {
    expect(detectRuntime({} as any)).toBe('web');
  });
  it('capacitor android is android', () => {
    const g: any = { Capacitor: { isNativePlatform: true, getPlatform: () => 'android' } };
    expect(detectRuntime(g)).toBe('android');
  });
  it('tauri is windows', () => {
    expect(detectRuntime({ __TAURI_INTERNALS__: {} } as any)).toBe('windows');
  });
  it('capabilities match runtime', () => {
    expect(getCapabilities).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm@9.15.9 vitest run utils/platform/detect.test.ts`
Expected: FAIL with "module not defined".

- [ ] **Step 3: Write minimal implementation**

```ts
export type SullyRuntime = 'web' | 'android' | 'windows';
export interface PlatformCapabilities {
  runtime: SullyRuntime;
  isNative: boolean;
  push: 'webpush' | 'fcm' | 'none';
  appActivity: 'sullyos' | 'usage-stats' | 'foreground-process';
  secureStore: boolean;
  osNotifications: boolean;
}
export function detectRuntime(g: typeof globalThis = globalThis): SullyRuntime {
  const x = g as any;
  if (x?.Capacitor?.isNativePlatform === true && x?.Capacitor?.getPlatform?.() === 'android') return 'android';
  if (x?.__TAURI_INTERNALS__ != null) return 'windows';
  return 'web';
}
export function getCapabilities(g?: typeof globalThis): PlatformCapabilities {
  const runtime = detectRuntime(g);
  if (runtime === 'android') return { runtime, isNative: true, push: 'fcm', appActivity: 'usage-stats', secureStore: true, osNotifications: true };
  if (runtime === 'windows') return { runtime, isNative: true, push: 'none', appActivity: 'foreground-process', secureStore: true, osNotifications: true };
  return { runtime, isNative: false, push: 'webpush', appActivity: 'sullyos', secureStore: true, osNotifications: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm@9.15.9 vitest run utils/platform/detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/platform/
git commit -m "feat(platform): add runtime detection and capabilities"
```

### Task 2: SecureStore + session core

**Files:**
- Create: `utils/platform/secureStore/types.ts`, `utils/platform/secureStore/web.ts`, `utils/platform/secureStore/index.ts`
- Create: `utils/platform/appActivity/types.ts`, `utils/platform/appActivity/queue.ts`, `utils/platform/appActivity/web.ts`
- Test: `utils/platform/secureStore/web.test.ts`, `utils/platform/appActivity/queue.test.ts`, `utils/platform/appActivity/web.test.ts`

**Interfaces:**
- Consumes: `SullyRuntime` from Task 1.
- Produces: `SecureStore`, `AppActivitySession`, `AppActivityProvider`, `enqueueSession`, `drainSessions`, `ackSessions`.

- [ ] **Step 1: Write failing queue test**

```ts
import { describe, expect, it } from 'vitest';
import { enqueueSession, drainSessions, ackSessions } from './queue';
import type { AppActivitySession } from './types';
const s = (id: string, startedAt: number): AppActivitySession => ({ id, deviceId: 'd1', platform: 'web', source: 'sullyos', appKey: 'chat', appLabel: 'chat', startedAt, endedAt: startedAt + 1000, durationMs: 1000, schemaVersion: 1 });
describe('session queue', () => {
  it('drains in startedAt order and acks', async () => {
    await enqueueSession(s('b', 2000));
    await enqueueSession(s('a', 1000));
    const got = await drainSessions(10);
    expect(got.map((x) => x.id)).toEqual(['a', 'b']);
    await ackSessions(got.map((x) => x.id));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm@9.15.9 vitest run utils/platform/appActivity/queue.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement queue on `sully_activity_v1` outbox (keyPath `id`)**

Web SecureStore on `sully_secure_v1` kv (never `AetherOS_Data`).

- [ ] **Step 4: Run tests**

Run: `corepack pnpm@9.15.9 vitest run utils/platform/secureStore/web.test.ts utils/platform/appActivity/queue.test.ts utils/platform/appActivity/web.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/platform/
git commit -m "feat(activity): add secure store and session queue core"
```

### Task 3: Perspective Worker + D1

**Files:**
- Create: `worker/perspective/wrangler.toml`, `worker/perspective/src/index.ts`, `worker/perspective/src/schema.ts`, `worker/perspective/src/auth.ts`, `worker/perspective/src/sessions.ts`, `worker/perspective/src/summaries.ts`
- Test: `worker/perspective/src/auth.test.ts`, `worker/perspective/src/sessions.test.ts`, `worker/perspective/src/index.test.ts`
- Modify: `scripts/build-workers.mjs`, `worker/corsContract.test.ts`

- [ ] **Step 1: Write failing auth test (token length, sha256, timing-safe compare, revoked).**
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement worker with `preflightResponse`/`corsHeaders` from `worker/shared/cors.ts`, D1 `INSERT OR IGNORE`, 30-day TTL, per-device rate limit.**
- [ ] **Step 4: Run `corepack pnpm@9.15.9 vitest run worker/perspective/src worker/corsContract.test.ts`, expect PASS; run `pnpm build:workers`, expect `worker/perspective/worker.bundle.js`.**
- [ ] **Step 5: Commit.**

### Task 4: Migration, tokens, role query

**Files:**
- Modify: `types.ts`, `utils/perspective.ts`, `utils/perspectiveTelemetry.ts`, `utils/agenticTools.ts`, `utils/applyAssistantPostProcessing.ts`, `utils/instantToolRunner.ts`, `utils/amsgToolPack.ts`, `utils/activeMsgClient.ts`, `utils/amsgFirePerspective.ts`, `utils/chatPrompts.ts`, `utils/backupSecrets.ts`, `utils/statusPanel.ts`, `utils/perceptionRegistry.ts`, `worker/amsg/src/index.ts`, `context/OSContext.tsx`
- Create: `utils/perspectiveTokens.ts`, `utils/perspectiveMigrate.ts`

- [ ] **Step 1: Replace Supabase endpoint with Worker endpoint; delete `reportPerspectiveEvent` single-post path; add batch upload.**
- [ ] **Step 2: Wire `resolvePerspectiveToolConfig` only on perspective tool hits; per-char token only in `tool_pack`.**
- [ ] **Step 3: Run affected tests + `pnpm build:workers`; expect PASS.**
- [ ] **Step 4: Commit.**

### Task 5: Android + Windows shells

**Files:**
- Create: `capacitor.config.ts`, `.env.capacitor`, `android/**`, `src-tauri/**`, `.env.tauri`, docs, workflows.
- Create: `utils/platform/appActivity/android.ts`, `utils/platform/appActivity/windows.ts`, `utils/platform/push/android.ts`, `utils/platform/notifications/*`

- [ ] **Step 1: Android UsageStats plugin + WorkManager + FCM `fcm:<token>`; exclude own package.**
- [ ] **Step 2: Windows `activity.rs` with 5s poller; assert `rg GetWindowText src-tauri/src` zero hits.**
- [ ] **Step 3: Service Worker split (web registers; shells do not).**
- [ ] **Step 4: Local apk/exe build + install smoke; record SHA256.**
- [ ] **Step 5: Commit.**

### Task 6: Settings, docs, release

**Files:**
- Modify: `apps/Settings.tsx`, `apps/Chat.tsx`, `components/chat/ChatModals.tsx`, `docs/design-system.md`, `notes/ethernet-features.md`, `notes/ethernet-branch-context.md`, `CLAUDE.md`, `utils/buildInfo.ts`
- Create: `docs/perspective-window.md`, e2e/release/rollback reports.

- [ ] **Step 1: Capability-driven panel; same component on all shells; no token display.**
- [ ] **Step 2: Run full gate: `vitest run`, `tsc --noEmit` (touched files zero), `mojibakeGuard`, `vite build`, `build:workers`.**
- [ ] **Step 3: E2E matrix + release order + rollback doc.**
- [ ] **Step 4: Commit and push branch.**
