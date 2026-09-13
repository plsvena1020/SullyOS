# 三端壳兼容性 Spike 报告

日期：2026-09-13
分支：platform-shells
结论：**架构可行，TypeScript 侧全部落地并验证；原生壳生成被工具链阻塞，转为明确的后续任务。**

## 1. 本机实测通过项

- 全量 Vitest：5165 用例通过，0 失败（唯一红的是 `worker/corsContract.test.ts`
  的收集期 SyntaxError，经 `git stash` 确认在干净 HEAD 上同样失败，与本分支无关）。
- `tsc --noEmit`：本次触碰文件零新增命中（存量错误不动）。
- `vite build`：成功（45s）。
- `pnpm build:workers`：7 个 bundle 成功，新增 `worker/perspective/worker.bundle.js`。
- `utils/mojibakeGuard.test.ts`：通过，无 U+FFFD。

## 2. 工具链阻塞项（本机无条件验证）

| 能力 | 本机状态 | 结论 |
|---|---|---|
| Rust / cargo | 未安装 | Tauri 壳无法生成与编译 |
| Android SDK / adb / ANDROID_HOME | 未安装 | Capacitor `android/` 无法生成与构建 |
| Java | 仅 8（AGP 需要 17+） | 即使有 SDK 也编不过 |
| 真机 / 模拟器 | 无 | UsageStats、FCM、WebView IDB 无法实测 |

因此以下工作**不在本分支做**（做了也无法验证，违反“先验证再提交”）：

1. `npx cap add android` 生成 `android/`（约 50 文件）。
2. `SecureStorePlugin.java` / `AppUsagePlugin.java` / `AppUsageWorker.java`。
3. `src-tauri/`（Cargo.toml、tauri.conf.json、activity.rs、secure_store.rs）。
4. `.github/workflows/build-apk.yml` / `build-windows.yml`。
5. FCM 客户端注册（`utils/platform/push/android.ts`）。

## 3. 已落地的壳无关准备

TypeScript 侧的平台差异已全部收口，可直接被未来的壳复用：

- `utils/platform/bridge.ts` 按 runtime 选择 provider 与安全存储。
- `createAndroidAppActivity`：轮询 `AppUsage.drainSessions`，排除自身包，
  单测用 mock 插件覆盖（`android.test.ts` 3 用例）。
- `createWindowsAppActivity`：订阅 `activity-session` 事件，
  单测覆盖（`windows.test.ts`）。
- `createAndroidSecureStore` / `createWindowsSecureStore`：插件与 Tauri command 薄封装。
- `shouldRegisterServiceWorker()`：原生壳不注册 SW（Android 无 Push 绑定，
  Windows 无 PushManager）。
- Perspective Worker API（`/device/register`、`/sessions`、角色令牌、30 天 TTL）
  已实现并单测，`worker/perspective/README.md` 有部署步骤。

## 4. 有工具链的机器上的后续步骤

```bash
# Android（需 JDK 17+、Android SDK、真机）
corepack pnpm@9.15.9 add @capacitor/core@^6 @capacitor/android@^6 @capacitor/app@^6 \
  @capacitor/keyboard@^6 @capacitor/status-bar@^6 @capacitor/local-notifications@^6 \
  @capacitor/push-notifications@^6
corepack pnpm@9.15.9 add -D @capacitor/cli@^6
# 建 capacitor.config.ts（appId 保持 com.aetheros.simulator，与 FCM 绑定）
vite build && npx cap add android && npx cap sync android
# 按设计实现 SecureStorePlugin / AppUsagePlugin（接口见 android.ts / secureStore/android.ts）
cd android && ./gradlew assembleDebug
```

```bash
# Windows（需 Rust 稳定版、WebView2）
corepack pnpm@9.15.9 add @tauri-apps/api@^2
corepack pnpm@9.15.9 add -D @tauri-apps/cli@^2
npx tauri init  # frontendDist ../dist, devUrl http://localhost:5173
# 实现 activity.rs（只取进程文件名，禁 GetWindowText*）与 secure_store.rs（DPAPI）
npx tauri build
```

真机验收矩阵见执行计划 Task 5/6（FCM 到达、UsageStats 质量、IDB 持久化、
DPAPI 密文、安装包 SHA-256 留档）。
