# 透视窗三端扩展设计（spec）

日期：2026-09-13
分支：platform-shells（自 ethernet@858716c0 分叉）
状态：已批准，进入实施

## 1. 目标

把现有纯 Web 透视窗扩展为三端共用能力：

- Web：记录 SullyOS 内部虚拟 App 会话。
- Android（Capacitor 6）：复用整套 SullyOS，额外记录 Android 前台应用。
- Windows（Tauri 2）：复用整套 SullyOS，额外记录 Windows 前台进程。

三端共用一套 React/Vite 产品核心、同一套 `docs/design-system.md`、
同一个用户自建 Perspective Worker + D1、同一套角色查询与主动消息链路。

对外名称继续叫「透视窗」。

## 2. 非目标

- 不做 iOS。
- 不做浏览器扩展与网站域名记录。
- 不采集网络状态、页面 focus/blur、PWA 状态、屏幕尺寸、设备分类事件。
- 不读取窗口标题、URL、网页标题正文、消息正文、输入、通知、剪贴板、屏幕。
- 不做 Android 无障碍服务、常驻前台采集服务、Windows 系统服务。
- 不做跨端业务数据库实时同步、OTA、商店发布、首版代码签名。
- 不迁移旧 Supabase 事件点；不改记忆宫殿 Supabase 向量库。

## 3. 现状锚点

- 数据层：`utils/perspective.ts`（Supabase PostgREST，环境无关）。
- 采集：`utils/perspectiveTelemetry.ts`、`context/OSContext.tsx:866-873,935,5331`。
- 配置：`types.ts:796-818`、`apps/Settings.tsx:835-842,1785-1832,4661-4719`。
- 消费：`utils/agenticTools.ts:878-982`、
  `utils/applyAssistantPostProcessing.ts:1624-1727`、
  `utils/amsgFirePerspective.ts`、`worker/amsg/src/index.ts:1964-1968`。
- 旧事件含 `chat.send` 承诺但无发射、`char.switch` 只记 id、
  `clearPerspectiveEvents` 无入口（见审查结论）。

## 4. 统一事件模型

```ts
type AppActivitySource = 'sullyos' | 'device';
interface AppActivitySession {
  id: string;            // 客户端 UUID，幂等键
  deviceId: string;
  platform: 'web' | 'android' | 'windows';
  source: AppActivitySource;
  appKey: string;        // web=AppId / android=包名 / windows=exe 名
  appLabel: string;      // 显示名
  startedAt: number;     // epoch ms
  endedAt: number;
  durationMs: number;    // 单调时钟计算
  schemaVersion: 1;
}
```

规则：原始会话只追加/删除；展示聚合不改写原记录；
`durationMs>=0`，`endedAt>=startedAt`，名称最长 128 字符；
服务端以令牌绑定确定 `deviceId`，不信任请求体。

## 5. 平台桥

`utils/platform/**` 是唯一平台判断点：

```ts
type SullyRuntime = 'web' | 'android' | 'windows';
interface SullyPlatformBridge {
  runtime: SullyRuntime;
  capabilities: PlatformCapabilities;
  secureStore: SecureStore;
  appActivity: AppActivityProvider;
  notifications: NotificationsBridge;
}
```

`apps/`、`components/`、`context/` 禁止直接 import
`@capacitor/*`、`@tauri-apps/*`；原生依赖动态加载，不进 Web 首屏。

## 6. 安全与隐私

- 每设备独立 `pvd_` 令牌，D1 只存 SHA-256。
- 每角色独立 `pvc_` 只读令牌，只进该角色 `tool_pack`。
- 设备令牌不上主动消息云端；角色令牌不可写删。
- 黑名单在采集端执行，被排除应用不进入队列。
- 默认保留 30 天；支持按设备清空与全部清空。
- 令牌存 SecureStore（Web 独立 IDB / Android Keystore / Windows DPAPI），
  不进 `RealtimeConfig`、主库、localStorage、备份、日志。
- Windows 禁止窗口标题 API；Android 不申请无障碍与 `QUERY_ALL_PACKAGES`。

## 7. 后端

新建 `worker/perspective/`（D1 + cron + CORS 复用 `worker/shared/cors.ts`）。
表：`pv_devices`、`pv_role_tokens`、`pv_sessions`、`pv_summaries`。
端点：`/health`、`/device/register`、`/devices*`、`/sessions*`、
`/role-tokens*`、`/summaries*`、`/admin/purge-default`。
写入 `INSERT OR IGNORE`，按设备限流，30 天 TTL。

## 8. UI

同一 `PerspectivePanel` 按能力渲染；Web 显示“系统应用不支持”，
Android 显示 UsageStats 授权按钮，Windows 显示“仅进程身份”。
样式沿用设置页玻璃卡片与 `ConfirmDialog`，不引入新视觉语言。
逐角色开关保持布尔授权，未配对时拒绝打开并提示去设置配对。

## 9. 本次触碰文件清单

新增：`utils/platform/**`、`utils/perspectiveTokens.ts`、
`utils/perspectiveMigrate.ts`、`utils/perspectiveSettingsModel.ts`、
`worker/perspective/**`、`capacitor.config.ts`、`.env.capacitor`、
`android/**`、`src-tauri/**`、`.env.tauri`、构建 workflow、
`docs/perspective-window.md` 及本目录 spec/plan/report 文档。

修改：`package.json`、`pnpm-lock.yaml`、`.gitignore`、`vite.config.ts`、
`index.html`、`index.tsx`、`types.ts`、`utils/realtimeContext.ts`、
`context/OSContext.tsx`、`apps/Settings.tsx`、`apps/Chat.tsx`、
`components/chat/ChatModals.tsx`、`utils/perspective.ts`、
`utils/perspectiveTelemetry.ts`、`utils/agenticTools.ts`、
`utils/applyAssistantPostProcessing.ts`、`utils/instantToolRunner.ts`、
`utils/amsgToolPack.ts`、`utils/activeMsgClient.ts`、
`utils/amsgStateSync.ts`、`utils/amsgFirePerspective.ts`、
`utils/chatPrompts.ts`、`utils/backupSecrets.ts`、`utils/statusPanel.ts`、
`utils/perceptionRegistry.ts`、`utils/keepAlive.ts`、`utils/buildInfo.ts`、
`worker/amsg/src/index.ts`、`scripts/build-workers.mjs`、
`worker/corsContract.test.ts`、`docs/design-system.md`、
`notes/ethernet-features.md`、`notes/ethernet-branch-context.md`、
`CLAUDE.md` 及对应 `*.test.ts`。

明确不动：`utils/memoryPalace/supabaseVector.ts`、
`worker/amsg/src/nativeFcm.ts`、`@rei-standard/amsg-*`、
`vps-backend/**`、`apps/pomodoro/**`。
