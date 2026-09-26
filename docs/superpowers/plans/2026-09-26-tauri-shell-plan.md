# Tauri Shell Implementation Plan (PC overlay + full-phone window)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tauri 壳跑完整小手机（主窗口）＋陪玩悬浮窗（透明穿透窗），sidecar 配双击启动器（打包进壳以后再说）。

**Architecture:** 新顶层 `desktop/` Tauri v2 工程：主窗口加载 Vite 构建产物（整个 SullyOS）；悬浮窗透明无边框置顶加载游戏 App 视图（路由先验证再写死）；`setIgnoreCursorEvents` 做穿透/可点切换＋全局热键；sidecar 仍独立进程，验证期用 `.bat` 双击启动。

**Tech Stack:** Tauri v2, Rust (MSVC target), WebView2 (runtime present 154.x), Vite static `dist/` for main window.

**Spec:** `docs/superpowers/specs/2026-09-24-game-companion-design.md` §7 overlay (Tauri locked) + §12 overlay entry.

**Worktree:** `.worktrees/game-companion` (`feat/game-companion`, continues — do NOT merge ethernet again; base is current tip).

## Global Constraints

- 壳层只做窗口/配置/胶水，不改业务逻辑；`apps/`、`utils/`、`context/` 零改动（overlay 复用游戏 App 现有视图）。
- IRON RULE ASCII-only on every touched file (Rust included — same CJK-username machine).
- 独占全屏盖不住是已知约束，不在本计划解决（窗口/无边框前提，spec 已锁）。
- No new npm dependencies. Windows pwsh.

## Toolchain cost (read before starting)

Proven on this machine (2026-09-26): WebView2 Runtime 154.x present, node 22 + pnpm 9 present, **Rust absent**. Tauri Windows additionally needs MSVC C++ build tools (Visual Studio Build Tools "Desktop C++" workload, several GB). Task 1 gates on this: if absent → report BLOCKED naming exact missing pieces, do NOT install unilaterally (same rule as the Android SDK).

## Review Focus

- 全局热键与 Eden/系统热键冲突 — Task 2 checklist pins no-conflict default + configurable key.
- 切可点模式抢游戏焦点 — Task 2 checklist pins focus stays in game until explicit click.
- 透明窗拖慢游戏帧 — Task 2 checklist pins FPS eyeball test (Eden counter on/off).
- 桥离线时悬浮窗状态 — idle ball only, no errors (Task 2 checklist).
- 开机自启重复拉起 sidecar — launcher uses mutex/port-probe (Task 3 test pins single instance).

---

### Task 1: Toolchain gate + Tauri scaffold (both windows open)

**Files:**
- Create: `desktop/` Tauri v2 project (`tauri.conf.json`, `src-tauri/` minimal, icons placeholder per `tauri init` output — no custom art in validation)

**Interfaces:**
- Consumes: Vite `dist/` build output (main window URL/file), game App view address (verify-first below).
- Produces: `pc-shell` binary opening main + overlay windows (Tasks 2–3 fill behavior).

- [ ] **Step 1: Toolchain gate**

```bash
rustc --version; cargo --version
```

Expected: stable Rust present. If absent → STOP, report BLOCKED with exact missing pieces (rustup URL + VS Build Tools "Desktop C++" workload + WebView2 already present). Do not install.

- [ ] **Step 2: Scaffold**

Run the official `create-tauri-app` (or `cargo create-tauri-app`) with the Vite frontend preset pointing at the repo `dist/` output; keep default identifiers, rename only the product name to the repo's app name. Record exact versions (Tauri, tao, wry) in the task report.

- [ ] **Step 3: Verify-first game-view address**

Read how `openApp(AppID)` addresses the companion app (PhoneShell/launcher code) and decide the overlay window's URL (dev: `http://localhost:5173` + route/param; prod: bundled `dist/` + same). Record the decision + file:line evidence in the report. Do not guess.

- [ ] **Step 4: Build + commit**

```bash
git add desktop
git commit -m "feat: add Tauri shell scaffold with main and overlay windows"
```

(Build must succeed: `cargo tauri build` or dev-mode equivalent per create-tauri-app docs. No binaries committed — `src-tauri/target/` must be gitignored; verify with `git status --porcelain`. ASCII-verify touched files.)

## Report Format

Write to `D:\sullyos\.superpowers\sdd\2026-09-26-tauri-shell\task-1-report.md` (toolchain outputs, address decision + evidence, build result, self-review, BLOCKED specifics if gated). Reply ≤15 lines: Status, commits, test/build summary, concerns, report path.

---

### Task 2: Overlay behavior (transparent, click-through, hotkey)

**Files:**
- Modify: `desktop/` window config + minimal glue only (`tauri.conf.json`: `decorations:false, transparent:true, alwaysOnTop:true` for overlay; `focusable:false` initial + `showInactive`-equivalent; JS `getCurrentWindow().setIgnoreCursorEvents(true)`; global hotkey toggling clickable mode)

**Interfaces:**
- Consumes: Task 1 window handles + game view URL.
- Produces: validated overlay behavior (Task 3 replay E2E target).

- [ ] **Step 1: Configure per shapes above** (Tauri v2 `window-customization` + Window API docs; keep Rust glue to the minimum the JS API cannot do).
- [ ] **Step 2: Manual checklist on this machine (Eden running, windowed):** overlay visible above Eden; clicks pass through in idle mode; hotkey flips to clickable and back without stealing game focus; bridge offline → idle ball only; Eden FPS eyeball unchanged. Record PASS/FAIL per item in the report (no commit of results).
- [ ] **Step 3: Commit** (`feat: add overlay click-through behavior with hotkey`).

## Report Format

Same workspace, `task-2-report.md` (config values, checklist table, build result, concerns). Reply ≤15 lines.

---

### Task 3: Sidecar launcher + replay E2E through overlay

**Files:**
- Create: `desktop/launch-sidecar.bat` (double-click start: single-instance via port probe on 18741, starts `python -m sidecar.main` from the worktree/sidecar path, pauses on error so the window doesn't vanish) + autostart doc (`desktop/AUTOSTART.md`: shell:startup shortcut steps, 5 lines)
- No PyInstaller bundling in validation (explicit non-goal, later plan).

**Interfaces:**
- Consumes: Tasks 1–2 + Plan 2 replay fixture.

- [ ] **Step 1: Write launcher + doc** (single-instance rule tested by code inspection + two-launch manual check).
- [ ] **Step 2: Replay E2E:** start launcher → bridge up → overlay shows fixture line (`今夜は満月だ`) within ~5s of app poll. Record evidence in report (no binaries in repo).
- [ ] **Step 3: Commit** (`feat: add sidecar double-click launcher and autostart doc`).

## Report Format

Same workspace, `task-3-report.md`. Reply ≤15 lines.

---

## After this plan

PyInstaller bundling + autostart-in-shell (sidecar inside the Tauri process) + overlay chat input/voice (Phase 2 audio) are follow-ups. Tablet overlay input follows the same UX when its track resumes.
