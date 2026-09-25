# Tablet Companion Implementation Plan (Plan 3b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平板原生伴侣服务（同机抓 Citron → ML Kit 繁中 OCR → 本机桥 → 原生 overlay 显示），与 PC 桥同协议零 Web 改动。

**Architecture:** 独立 Android 工程（Kotlin）：前台服务（`mediaProjection` 单类型）+ `MediaProjection`/`ImageReader` 抓屏 + ML Kit 中文非捆绑包 OCR + NanoHTTPD 同机桥（`GET /healthz` + `GET /events?since=`，与 PC 桥同形状）+ `TYPE_APPLICATION_OVERLAY` 原生 overlay。纯 JVM 可测部分进单元测试，真机部分走精确核对单。

**Tech Stack:** Kotlin, Gradle (applicationId `com.sullyos.tabletcompanion`, minSdk 26, targetSdk 35), `play-services-mlkit-text-recognition-chinese:16.0.1`, `nanohttpd:2.3.1`, framework MediaProjection/ImageReader/WebView APIs only.

**Spec:** `docs/superpowers/specs/2026-09-24-game-companion-design.md` (§4 tablet-mirror, §5 平板 OCR, §7 overlay, §9 平板最小配 + 权限矩阵)

**Worktree:** `.worktrees/game-companion` (`feat/game-companion`, continues — do NOT merge ethernet again; base is current tip). New top-level dir `tablet-companion/` (own Gradle project, NOT part of pnpm/vite).

**Locked protocol (controller ruling, reuse over novelty):** same port `127.0.0.1:18741`, same `GET /healthz` → `{"ok":true,"version":1}` and `GET /events?since=N` → `{"events":[{seq,type,payload}],"next":M}` shapes as the PC bridge (Plan 2). Event `source` is `"tablet-mirror"`. The existing web poller (`utils/gameBridge.ts`) works unchanged on both ends. No `/ocr` raw endpoint in validation (debug only, later).

## Global Constraints

- Validation only: bottom-third ROI, 2–3fps, busy-drop frames, pure subtitle (no audio capture), horizontal dialog; vertical rotate is best-effort later.
- Every bridge response carries `Access-Control-Allow-Origin: *`; WebView needs `networkSecurityConfig` localhost exception below API 37.
- No script verbatim stored; options dedupe by content hash (same md5-12 rule as PC).
- Record flag (`companion-game:record`) is owned by the web layer; native always captures, web decides what to keep.
- No new npm dependencies. Executor needs Android SDK (`ANDROID_HOME` + platform-35 + build-tools); if absent, report BLOCKED with exactly what is missing instead of guessing.
- Commands run on Windows pwsh.

## Review Focus

- 权限拒绝逐项降级（录屏/悬浮/前台/省电），拒绝后仍可手动截图导入 — Task 4 checklist + `OverlayMode` unit test pins it.
- `FLAG_SECURE` 黑屏报 `SECURE_BLACK` 而不是空 OCR — Task 2 black-frame detector test + Task 6 device check pin it.
- 模型未下完时调用不崩（排队等就绪） — Task 3 test pins queued-not-crashed.
- Doze/杀后台不断流 — device truth in Task 6 checklist (FGS + visible overlay per Android 15 `FGS_SAW_RESTRICTIONS`).
- 端口与协议 drift（与 PC 桥不一致） — Task 5 JVM tests pin identical shapes (copy the PC fixture `sidecar/fixtures/demo-events.json` as golden).

---

### Task 1: Gradle skeleton + pure-logic unit tests

**Files:**
- Create: `tablet-companion/` Gradle project (`settings.gradle`, `app/build.gradle` with the 2 locked deps, `AndroidManifest.xml` with permissions/services from Task 4's list — manifest entries finalized in Task 4, skeleton keeps placeholders minimal but valid)
- Create: pure Kotlin `RoiMath` (ROI clamp/scale), `FrameThrottle` (latest-only drop), `EventQueue` (seq/next, cap 500), `OptionsDedupe` (md5-12) + JUnit tests under `app/src/test/`

**Interfaces:**
- Consumes: nothing.
- Produces: tested primitives Tasks 2–5 build on; `EventQueue` shape mirrors PC bridge semantics.

- [ ] **Step 1: Verify toolchain**

Run: `echo $env:ANDROID_HOME; ls "$env:ANDROID_HOME\platforms" | Select-Object -Last 3`
Expected: `android-35` (or newer) listed. If absent → report BLOCKED naming the missing piece, stop.

- [ ] **Step 2: Write failing tests first** (`RoiMathTest`, `FrameThrottleTest`, `EventQueueTest`, `OptionsDedupeTest` — boundary cases: ROI outside frame clamps, throttle drops all-but-latest under burst, `since` replay returns `[]`, identical options hash equal).
- [ ] **Step 3: RED** (`./gradlew :app:testDebugUnitTest` fails: no sources), implement, GREEN.
- [ ] **Step 4: Commit**

```bash
git add tablet-companion
git commit -m "feat: add tablet companion skeleton with tested primitives"
```

---

### Task 2: Capture service (MediaProjection + ImageReader)

**Files:**
- Create: `CaptureService.kt` (foreground service, `mediaProjection` type), `FrameTaker.kt` (VirtualDisplay + ImageReader wiring), `BlackDetector.kt` (pure) + test

**Interfaces:**
- Consumes: Task 1 throttle/ROI primitives.
- Produces: ROI bitmap stream to Task 3; `SECURE_BLACK` status on zero-variance frames.

Exact shapes (from official docs, verified in research):
- Auth: `MediaProjectionManager.createScreenCaptureIntent()` → `registerForActivityResult(StartActivityForResult())` → `getMediaProjection(resultCode, data)` (one-shot; Android 14 re-auth per `createVirtualDisplay`, `SecurityException` on reuse).
- Frames: `ImageReader.newInstance(w, h, RGBA_8888, 2)` + `acquireLatestImage()` (NOT next) + mandatory `close()`; size from `WindowMetrics.getMaximumWindowMetrics().bounds`; `VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR`.
- Cleanup: `MediaProjection.Callback.onStop()` releases VirtualDisplay + ImageReader + stops service (Android 15 chip/lock auto-stop).
- Manifest: `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION`, service `android:foregroundServiceType="mediaProjection"`; NO `microphone` type (would demand `RECORD_AUDIO`).

- [ ] **Step 1: `BlackDetector` unit test first** (zero-variance RGBA buffer → `SECURE_BLACK`; normal buffer → `OK`), RED/GREEN.
- [ ] **Step 2: Implement service per shapes above** (no unit test possible for binder paths — mark clearly).
- [ ] **Step 3: Commit** (`feat: add tablet capture service with secure-black detection`).

---

### Task 3: ML Kit OCR wiring

**Files:**
- Create: `OcrEngine.kt` (recognizer + ready-queue) + test (mapping only, mocked recognizer)

**Interfaces:**
- Consumes: ROI bitmaps (Task 2).
- Produces: `[{text, conf}]` lines per frame to Task 5 bridge; `not-ready` queue state.

Exact shapes: `implementation 'com.google.android.gms:play-services-mlkit-text-recognition-chinese:16.0.1'`; manifest `<meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="ocr_chinese">` for install-time prefetch + first-run loading UI state; `TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())`; `InputImage.fromBitmap(roi, 0)`; iterate `textBlocks → lines` (`l.text`, `l.boundingBox`); glyph height ≥16px note in code comment.

- [ ] **Step 1: Mapping test first** (fake blocks → `[{text,conf}]`, empty blocks → `[]`, not-ready → queued flag, no crash).
- [ ] **Step 2: RED/GREEN, commit** (`feat: wire ML Kit Chinese OCR with ready queue`).

---

### Task 4: Overlay + FGS + permissions matrix

**Files:**
- Create: `OverlayController.kt` + `OverlayMode` pure mapper + test; manifest entries (overlay permission flow, FGS declarations); `CompanionOverlay` layout (latest line TextView + options count, avatar ball later plans)

**Interfaces:**
- Consumes: OCR lines (Task 3).
- Produces: visible overlay; degraded modes per permission state.

Exact shapes: `TYPE_APPLICATION_OVERLAY` + `Settings.canDrawOverlays()` check + denied → `Settings.ACTION_MANAGE_OVERLAY_PERMISSION` (Android 11+: lands on top-level Settings, no `package:`); `startForeground(id, notif, FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)`; `FLAG_NOT_TOUCHABLE`/`FLAG_NOT_FOCUSABLE` toggle (same semantics as PC plan). `OverlayMode.forPermissions(overlayGranted, fgsAllowed, batteryExempt)` pure → `FULL|NO_OVERLAY|NO_BACKGROUND` + test pins all 8 combos.

- [ ] **Step 1: Mapper test first, RED/GREEN.**
- [ ] **Step 2: Overlay + manifest + degraded paths, commit** (`feat: add tablet overlay with permission degradation`).

---

### Task 5: Local bridge (NanoHTTPD, PC-identical protocol)

**Files:**
- Create: `BridgeServer.kt` + JVM tests (real localhost HTTP, no device needed)

**Interfaces:**
- Consumes: OCR lines/options (Tasks 3–4), Task 1 `EventQueue`.
- Produces: `GET /healthz` + `GET /events?since=` on `127.0.0.1:18741` with CORS `*`; `networkSecurityConfig` localhost exception (res/xml + manifest ref, needed below API 37).

Dep: `org.nanohttpd:nanohttpd:2.3.1`. Golden test: copy PC fixture `sidecar/fixtures/demo-events.json` — serve it, assert identical bytes shape (`seq`/`next`/payload keys) so the web poller works unchanged.

- [ ] **Step 1: Golden + edge tests first** (shape identity, empty poll, malformed `since` → 400 with CORS — mirrors PC review findings), RED/GREEN on JVM.
- [ ] **Step 2: Commit** (`feat: add tablet local bridge with PC-identical protocol`).

---

### Task 6: Emulator integration + device checklist (manual, no commit of results)

**Files:** none (verification only; checklists live in task report).

- [ ] **Step 1 (emulator, Play Services image):** NanoHTTPD poll from host browser + overlay layout + throttle behavior + cleartext config; Latin/horizontal-Chinese OCR shape check.
- [ ] **Step 2 (real tablet, Citron):** auth dialog + Android 14 single-app share behavior; Android 15 chip-kill + lock auto-stop + `onStop`回收; Chinese model first-download timing; bottom-ROI crop accuracy + glyph height; FGS + overlay survival under Doze/kill; `FLAG_SECURE` → `SECURE_BLACK` (or document absent).
- [ ] **Step 3: Report** (per-item PASS/FAIL + device model + Android version as the task result).

---

## After this plan

Overlay chat input + PTT STT (sherpa-onnx) + memory-chain hookup on tablet are follow-upsidecar/Plan-3a pieces land unchanged via the shared bridge protocol.
