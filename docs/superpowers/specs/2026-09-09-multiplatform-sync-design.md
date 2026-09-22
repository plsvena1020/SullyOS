# SullyOS 多端化与两端同步 设计文档

日期：2026-09-09
状态：已评审定稿（语音线挂起，见附录）
上游讨论：2026-09-09 会话（GPT-SoVITS CPUFast 部署 → 多端化转向）

## 1. 背景与目标

SullyOS 现状：React + TS + Vite 的 local-first 虚拟手机系统，数据全在浏览器 IndexedDB，LLM 聊天与主动消息跑在用户自己的 CF Worker 上（amsg2 链路，`worker/amsg/**`，本次零改动）。

**目标**：发布形态收窄为两端，并让两端数据同步：

- **APK**：Android 手机/平板，Capacitor 包壳，GitHub Actions 自动出包
- **PC**：Windows 优先，Tauri 2 壳 + 桌面形态 UI（不是手机框套壳）
- **同步**：用户自购 VPS（4C8G，与未来语音服务同机）跑极简同步 API，角色 + 设置 + 聊天记录全部入网，含聊天记录追加式合并

**明确非目标**（挂起，见附录 A）：
- 纯网页端（Vercel）不再作为发布目标；`vite dev` 仅作开发调试形态
- 语音整线：GPT-SoVITS TTS 接入、角色自主来电 + 悬浮球、whisper STT（用户待测试音源素材后单独立项）
- FCM 推送迁移、IndexedDB→SQLite 迁移、掌心窗 MCP 感知、Tauri 多窗口、端侧加密

`api/`（Vercel serverless：minimax/elevenlabs/fishaudio 转发）随语音线一并冻结，不删除不维护。

## 2. 平台适配层（M1 地基）

新文件 `utils/platform.ts`，零依赖运行时探测 + 类型导出：

```ts
export type Runtime = 'capacitor' | 'tauri' | 'web';
export function detectRuntime(): Runtime
export function isNativeApp(): boolean  // capacitor || tauri
```

探测依据：Capacitor → `window.Capacitor?.isNativePlatform === true`；Tauri → `window.__TAURI_INTERNALS__` 存在（Tauri 2）。业务代码禁止出现平台判断散落，一律经此层（后续能力接口按需增长，如 `canSpeechSynthesize()`）。

PWA service worker：执行期核查 `rg -l "serviceWorker" src/`；若在 Capacitor WebView（`capacitor://localhost` origin）内注册有副作用，则以运行时判断条件禁用；无碍则不动。

## 3. APK 线（M1）

- 依赖：`@capacitor/core`、`@capacitor/cli`、`@capacitor/android`（取当前最新稳定 major；若与 Gradle/SDK 组合出兼容问题，回退钉 Capacitor 7）
- `capacitor.config.ts`：`appId: 'com.sullyos.app'`，`webDir: 'dist'`（执行期核查 `vite.config.ts` 的 `build.outDir` 与 `base`，若非 `dist`/`/` 则以实际为准调整）
- `android/` 生成物入库；`.gitignore` 追加 `android/app/build/`、`android/.gradle/`、`android/local.properties`
- GitHub Actions：`.github/workflows/build-apk.yml`，手动 `workflow_dispatch` 为主（放开 push 触发留给用户自行决定）：

```yaml
name: Build APK
on:
  workflow_dispatch: {}
jobs:
  apk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: 21 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: npx cap sync android
      - run: cd android && ./gradlew assembleDebug
      - uses: actions/upload-artifact@v4
        with: { name: sullyos-apk, path: android/app/build/outputs/apk/debug/app-debug.apk }
```

- 签名：自用 debug 签名（零配置）；release keystore 走 GitHub Secrets，留待用户需要时
- 验收：Actions 绿、artifact APK 装机后聊天/角色/设置可用、杀进程重开 IndexedDB 数据仍在

## 4. 同步协议（M2 服务端 + M3 客户端，核心章节）

### 4.1 模型总纲

- **每设备只写自己的聊天追加日志，合并在读端**（Git 式模型，写路径零冲突）
- 角色/设置走整实体快照 + 版本号 CAS（乐观锁），LWW：后提交者胜
- 大对象（图片 base64 等）内容寻址（sha256）进 blobs/，消息内只存引用，天然去重
- 服务端是哑文件仓库：不解析业务数据、不做合并，只管存储、清单 CAS、设备鉴权

### 4.2 VPS 端目录与数据结构

```
/srv/sullyos-sync/
  manifest.json                      # { domains: { chars: v, settings: v }, devices: {...} }
  devices.json                       # 设备注册表（服务端私有）：deviceId → { name, tokenHash, pairedAt, lastSeen, revoked }
  chars/{charId}/v{n}.json           # 角色整包快照（n 单调递增）
  settings/v{n}.json
  chat/{sessionId}/log-{deviceId}-{seq}.jsonl   # 每设备追加日志，seq 单调
  blobs/{sha256}                     # 大对象
```

manifest 与各域版本号由服务端在 PUT 成功时递增并回写（CAS 保证并发安全）。

### 4.3 服务端（`sync-server/`，Node 22 + Fastify，单仓库新目录）

端点一览（全部 HTTPS，经 Caddy 反代）：

| 方法/路径 | 语义 | 鉴权 |
|---|---|---|
| `POST /pair` | body: `{ pairingCode, deviceName }` → 签发 `{ deviceId, deviceToken }` | 配对码（env 一次配置） |
| `GET /health` | 存活探针 | 无 |
| `GET /manifest` | 清单 + 各设备 last_seen 刷新 | Bearer device token |
| `GET /domain/:domain` | 拉取某域当前版本内容（chars 返回全量索引 + 各实体） | token |
| `PUT /domain/chars/:charId` | 上传角色快照，body 带 `baseVersion`；不符 → 409 返回当前版本 | token |
| `PUT /domain/settings` | 同上 | token |
| `PUT /chat/:sessionId/log` | 追加自己的日志（seq 必须等于服务端记录的 next_seq，否则 409） | token |
| `GET /chat/:sessionId/log?deviceId=&sinceSeq=` | 增量拉取他人日志 | token |
| `PUT /blob` | body: 二进制；服务端算 sha256 落盘，返回 hash（已存在则幂等返回） | token |
| `GET /blob/:hash` | 拉取 | token |
| `GET /devices` / `PATCH /devices/:id` / `DELETE /devices/:id` | 设备列表 / 改名 / 吊销（吊销后该 token 立即 401） | token（自身）或配对码（管理） |

- 吊销实现：devices.json 标记 revoked，中间件统一校验
- 部署：systemd 单服务；Caddy 同机反代（TLS 自动签 + 仅放行该 API）；VPS 上与未来语音服务共存

### 4.4 客户端（`utils/sync/`，M3）

```
utils/sync/
  transport.ts      # fetch 包装：token 注入、409 重试语义、断网退避
  serializer.ts     # 复用现有备份导出格式（utils 里已有备份序列化，执行期对齐其接口）
  uploader.ts       # 域快照 CAS 上传 / 追加日志 / blobs 先传后引用
  downloader.ts     # manifest diff → 增量拉取
  merger.ts         # 聊天归并（时间戳排序 + 消息 id 去重 + 墓碑应用）；角色 LWW
  cursors.ts        # 每设备每会话 lastSeq、未同步变更计数（localStorage/IndexedDB）
  index.ts          # 对外：syncNow('upload'|'download'|'full')、绑定/解绑、状态查询
```

- 触发矩阵：
  - 上传 = PC（Tauri）关窗钩子（可靠）+ 低频定时（默认 1 小时，设置可调）+ 手动「立即上传」；APK = 定时 + 手动（Android 杀进程无回调，平台限制，不做关闭钩子）
  - 下载 = 启动必拉 + 手动「立即下载」
  - 用户已确认：切后台不触发上传
- 聊天合并语义：追加日志按 `createdAt` 归并、消息 id 去重；删除/撤回作为墓碑事件（`{t:'delete', messageId}`）进日志，两端应用
- 角色冲突：CAS 409 → 拉当前版本 → LWW 覆盖提交（单人使用，接受覆盖语义，spec 明示）
- 设置页同步板块（`components/settings/SyncSettings.tsx`）：连接配置（VPS 地址 + 配对码）、设备列表（改名/吊销/最后在线）、立即上传/下载/全量重同步、各域最近同步时间与**未同步变更数角标**（懒同步安全垫）

### 4.5 同步验收（M3 完成判据）

1. PC 与手机各自产生的新消息，在对端出现且双向无丢失（≥50 条混合图文）
2. 一端撤回/删除，另一端同步消失
3. 两端同时改同一角色 → 后提交者胜，无死锁无半写
4. 吊销设备后该端所有请求 401，重新配对恢复
5. 断网期间产生的增量，网络恢复后一次 syncNow 全部收敛
6. blobs：同一图片两端各传一次，服务端仅存一份

## 5. PC 线（M4 壳 + M5 桌面形态）

### 5.1 双形态架构

- **桌面形态（PC 默认）**：左侧 dock 导航 + 全尺寸内容区；`components/desktop/` 为既有目录，`DesktopHost.tsx` 是现成分支点（现渲染「全屏背景 + 居中手机框」），升级为壳调度器
- **手机模式（保留）**：现 `PhoneShell.tsx` 手机框整体作为可嵌入形态，APK/移动端唯一形态，PC 上可选（`desktopMode` 设置 auto/on/off 语义保留）与二级小窗的实现基础

### 5.2 App 桌面适配三级制（控制工程量，留扩展路）

- **一级（真适配）**：聊天三栏（会话列表 / 对话 / 角色详情）、设置两栏（分类导航 + 内容）——仅这两个高频 App；内层组件（MessageItem、气泡、语音条）原样复用，只重排外层布局
- **二级（手机框小窗）**：小程序类竖屏 App（外卖/银行/商城等）在桌面形态里以可拖动手机框小窗打开——即用户所说「需要小窗/投屏再搞出手机框」
- **三级（免适配）**：桌面小组件直接进桌面壳
- 新 App 默认二级兜底，成熟后升级一级，形成适配模板

### 5.3 Tauri（`src-tauri/`）

- Tauri 2，Windows WebView2，前端复用同一份 `dist`；`platform.ts` 识别 Tauri
- 第一版单窗口；窗口尺寸记忆；原生通知接 Tauri 通知 API（PC 版通知不走 FCM 通道）
- 关窗上传钩子：`onCloseRequested` 里触发 `syncNow('upload')` 后放行关闭

### 5.4 PC 验收

1920 宽屏下：聊天三栏完整可用、设置两栏可导航、小程序以小窗打开可操作、切手机模式正常回退、关窗后 VPS 收到增量。

## 6. 里程碑与执行计划

| 里程碑 | 内容 | 计划文件 |
|---|---|---|
| M1 | 适配层 + Capacitor + Actions | `docs/superpowers/plans/2026-09-09-m1-capacitor-apk.md`（已写） |
| M2+M3 | VPS 同步 API（含 `/agent/*`、`/amsg/*` 反代，覆盖中转依赖）+ 客户端引擎 + UI | M1 验收后编写（依赖 M1 的 platform 层与真实 dist 形态） |
| M4+M5 | Tauri 壳（含 Tauri 原生通知，覆盖 PC 推送）+ 桌面形态 | M3 验收后编写 |
| M6 | FCM 推送迁移（1~2 天，M3 后）：worker 加 FCM 通道 + `@capacitor/push-notifications` + Android 13+ 通知权限；附赠锁屏全屏来电（full-screen intent）解锁 | M3 验收后编写 |
| M7 | 蓝牙原生适配（1~2 天，可插队）：`bleEngine` 加原生适配器路由（`@capacitor-community/bluetooth-le`），恢复 APK/平板蓝牙感知与角色蓝牙工具 | M1 验收后即可编写 |

## 7. 风险登记

- 聊天图片 base64 体积大 → 追加日志分片 + blobs 内容寻址，单包尺寸上限（执行期定 2MB/请求，超出走 blob 引用）
- Android WebView IndexedDB 可能被系统清理 → 同步兜底，损失窗口 = 未上传增量（角标可见）
- 同步 token 泄露 = 全量数据出门 → 长随机 token + 可吊销 + HTTPS；端侧加密挂附录可选
- Capacitor/Tauri 版本与构建链兼容（2026-09 时点取最新稳定 major，回退预案钉 Capacitor 7）
- Tauri 依赖 Windows 10/11 自带 WebView2
- `CallApp.tsx` 等大文件本阶段不触碰；M5 只动布局壳层

### 7.1 双端兼容冲突审查结论（2026-09-09，对照现有计划与代码）

- **C1 聊天链路中转依赖**：`api/backend-proxy.ts`（Vercel 同源中转 `/agent/*`、`/amsg/*`）仅存在于 Vercel 部署，APK/PC 端没有该降级路径。缓解：主代理 agentBase 本为可配置外部地址（`utils/mcpClient.ts` `/agent/v1/mcp-relay`、`utils/modelList.ts` 透传均依赖它），M2 的 VPS 用 Caddy 反代这两段路由后，双端填 VPS 地址即通。M1 冒烟覆盖：聊天/MCP 链路在 `capacitor://localhost` origin 下连通（`toSameOriginProxyUrl` 对该 origin 的行为实测——现有测试只覆盖 dev/Vercel origin）。
- **C2 推送能力降级**：Android WebView 与 WebView2 均无 Web Push / Notification API；现有 `requirePushReady`（`utils/activeMsgClient.ts:1276`）前置 `describePushCapabilityGap()` 守卫，优雅抛错不崩溃，amsg2 outbox 补收兜底不变。M6（FCM）恢复 APK 推送；PC 走 M4 的 Tauri 原生通知 + 启动拉取。
- **C3 与 `plans/autonomy-round.md`（定稿 v4 待执行）的并行边界**：该计划主战场在 `worker/`，与 M1/M2/M4 无文件交叠；但 **M3 与它在两处必撞**——`utils/db.ts`（IndexedDB 版本化 schema，两边都要加 store）与 `Settings.tsx`（两边都要加板块），这两份计划不得同时执行这两个文件。另：autonomy 的「big 推送」在 M6 之前于 APK 上静默落 outbox（有兜底不丢，体验降级），M6 上线后恢复。
- **能力降级登记**：Web Bluetooth 双端均不支持（`utils/bleEngine.ts:112` 用 `navigator.bluetooth`；Android WebView 与 WebView2 均无此 API），`Settings.tsx` 已有 `isSupported()` 守卫显示不支持提示，角色蓝牙工具自动不注入，无崩溃——M7 以原生插件恢复 APK 端；`mediaSession`（`utils/MusicContext.tsx:732` 有 `'mediaSession' in navigator` 守卫）与 `navigator.share`（`utils/shareExport.ts:113` 有 typeof 守卫）双端优雅降级，明确放弃原生化。

## 8. 附录 A：挂起项存档（重启时读这里，勿翻会话）

### 语音整线（重启条件：用户测试完音源素材）

- **VPS 侧**：GPT-SoVITS-CPUFast（github.com/baicai-1145/GPT-SoVITS-CPUFast）推理-only，`install.sh --source ModelScope --version v2ProPlus`，只跑 `api_v2.py`（FastAPI，默认 9880，单 worker），Caddy 反代 + BasicAuth；中文暖机短句 3~8 秒、8G 内存常驻 3~4GB
- **SullyOS 侧**：`TtsProvider`（`types.ts:401`）加第四家 `'gptsovits'`；新 `utils/gptSoVitsTts.ts` 对齐 minimaxTts 接口，复用 `<语音>` 标签解析（`utils/minimaxTts.ts:111`），新增剥除 `(laughs)` 类演出标记；设置页四选一 + VPS 地址/参考音频路径/prompt_text 三件套；Chat/CallApp/约会 provider 分支照抄现有写法
- **音色**：A 路零样本（5~10 秒干声参考，用户自备声源）先行；B 路微调（1 分钟+标注数据，Kaggle 30h/周免费或 AutoDL 按量）用户已表态大概率不做
- **角色自主来电（替代原 amgs2 云端来电方案，用户已否掉主动消息来电）**：聊天 prompt 教角色输出 `[[CALL]]`（`chatPrompts.ts` 现有 `[[RECALL]]`/`[[ACTION]]` 标签族扩展），解析剥标签弹来电 UI（复用 CallApp）；挂断后冷却（N 分钟）；拒接给角色系统感知；**通话悬浮球**（微信式最小化，逛别的 App 音频不断）；平台边界：PC 切后台通话继续、APK 切后台麦克风被系统停（转暂停等待态）、杀页面通话死（PWA/WebView 无后台执行，APK 前台服务是解锁路径）
- **STT**：第一版沿用浏览器 Web Speech（`apps/CallApp.tsx:1391` 已有语音输入）；APK WebView 不带语音服务 → 升级路径为 VPS faster-whisper（int8，约 1.5GB 内存）
- **B 路代办范围（若将来重启）**：数据整理脚本、Kaggle/Colab notebook、权重验证与 `/set_*_weights` 热切换可代办；音源素材与标注把关必须用户完成

### 其他挂起

- **PC 蓝牙**：WebView2 无 Web Bluetooth，Tauri 侧需 Rust btleplug 插件（3~5 天）——用户已确认不做，除非将来需求变化
- **mediaSession / navigator.share 原生化**：明确放弃（守卫降级已足够，见 §7.1）
- **锁屏全屏来电**（full-screen intent）：依赖 M6（FCM 迁移已升格为正式里程碑，见 §6）
- **SQLite 迁移**：WebView IndexedDB 若出现实际损坏再启动
- **掌心窗感知**（零代码可插队）：自部署其 server+MCP（github.com/linzhi-524/linjian-peek-public，许可禁止再分发、允许自用），SullyOS 现有 MCP 客户端直连，角色获 `peek_screen`/通知/App 感知工具；amsg2 worker 直连 MCP 可支撑主动关怀
- **多窗口**（Tauri）：聊天/笔记独立窗口
- **端侧加密**：聊天明文过 VPS 的可选加固，token 派生密钥
