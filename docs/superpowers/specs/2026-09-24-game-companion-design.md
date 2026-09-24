# 游戏陪玩 Spec：SullyOS × Eden / Citron 乙女游戏

- 日期：2026-09-24
- 状态：待用户评审（评审通过前不写执行计划、不碰业务代码）
- 决策锁：spike 已闭环（Eden 抓屏 / XCI / 繁中 OCR / VL / 缩放 / 平板），oracle 已审一轮，用户已拍板——平板拓扑选“全在平板”

## 1. 背景与目标

用户在 PC（Eden + Lossless Scaling）与 Android 平板（Citron 变体）玩繁中有语音日乙，希望 SullyOS AI 角色实时陪玩：看到选项与选择、近似跟踪路线、无台词空档语音闲聊、悬浮窗文字气泡双聊、可回手动记忆。

成功标准（验证期）：同一批 Eden 繁中截图集上，选项屏全读出率 ≥95%，竖排切碎 <5%（验证期仅横排，竖排标不支持），悬浮窗最新一条文本稳定跟播，收尾一条总结可审计。

## 2. 非目标（验证期不做，oracle 必砍项）

1. 云端 VL 高频轮询（仅验证期离线打分用，不进回路）。
2. 竖排、人名/选项分区、ruby 处理（ruby 直接丢弃）。
3. WASAPI+VAD+预生成+抢话开关全套音频（三档只留纯文本一档）。
4. 气泡 1-3 条+未读+节流花活（只留最新一条）。
5. 源窗/缩放窗双 ROI（只锁源窗一个）。
6. 选项结构化记忆（只留一句话总结+手动记/不记）。
7. Worker push 加速（`FORCE_DISABLED=true`，先别碰）。

## 3. 拓扑（已拍板）

- PC 链：Eden（窗口/无边框，禁独占全屏）→ 本地 sidecar（WGC 按 HWND 抓源窗 + PP-OCR + 变化触发）→ localhost 桥 → SullyOS（`dev-local.bat` 5173）→ PC 悬浮窗展示。
- 平板链（全在平板，自闭环，不经 PC，不传视频）：Citron + 原生前台服务（MediaProjection + ImageReader + ML Kit）+ SullyOS Web（平板浏览器打开本机服务）只做展示。断网可跑（除 STT/TTS 云链路外）。
- 两路共享同一“帧→ROI→OCR→字幕事件”管线，差异只在采集源实现。

## 4. 采集层 CaptureSource

```ts
type CaptureSource =
  | { kind: "pc-window"; hwnd: number; roi: ROI; roiVersion: number; dpiScale: number }
  | { kind: "scaled-window"; hwnd: number; roi: ROI; roiVersion: number; dpiScale: number } // Phase2
  | { kind: "tablet-mirror"; roi: ROI; roiVersion: number }; // 实际=本机 MediaProjection，不经 scrcpy
```

- ROI 按源独立标定，版本号可查；HWND 重建/窗口移动/缩放开关切换时 overlay 停更并提示重标（验证期只记日志不自动修）。
- LS 约束：只支持窗口/无边框；抓源窗拿原始分辨率（最稳），抓缩放窗仅源分辨率过低时用（有重采样+插帧伪影风险）。
- mss 仅 throwaway 验证用（无 HWND 概念，被盖即错）。

## 5. OCR（流畅线，本地）

- PC：`PP-OCRv5_mobile_rec`（16MB）或 `chinese_cht_PP-OCRv3_mobile_rec`（10.8MB），CPU 毫秒级；只裁对话框 ROI，画面无变化不调 OCR。
- 平板：ML Kit 中文非捆绑版（`zh-Hant` 在 v2 表内），横排为主；竖排先旋转 ROI 再试，失败即标不支持不崩。
- 变化触发（change-triggered）定义：对话框脏矩形帧差阈值（写死常量）+ 逐字打印去抖 + ROI 外变化忽略；LS 开关切换前后误触发率可复测。
- 选项判定：选项区 ROI 行数>1/候选符号 → 记候选；下屏文本突变即判定选择。路线/好感度 flag 不可读，只靠选项历史+章节标题近似。

## 6. 音频策略（Phase 2，验证期关闭）

验证期纯文本，不接任何音频链路。Phase 2 再开，规则已锁：

- 抢话开关（按会话可切，默认禁止抢话）：
  - 禁止抢话：游戏说话时不播但后台预生成 1 条（新覆盖旧，OCR 位移即作废）；VAD 静音 hangover 800–1500ms 确认真空档再播；平板无音频时用字幕稳定 2 秒代替（常量可配）。
  - 允许抢话：生成完即播，不等空档（VAD 只记日志）；与游戏语音叠加播放。
- 说话中来新对话：当前句继续说完不截断，新事件只进队列；说完后按当前模式处理下一条。
- 独立音量：伴侣语音单独增益（0–200%，默认 100%，按角色持久化），超 100% 部分经压缩器防削波；不动游戏音频。
- PC 用 WASAPI loopback（应用级，Win10 20348+）+ Silero VAD；平板用 AudioPlaybackCapture（10+，对面可拒则保持纯字幕降级）。

## 6b. XCI 离线层（Phase 3）

XCI 只能离线解包做剧本知识库（需 `prod.keys`，`hactool`/`nxdumptool`），不能替代实时 OCR。静态脚本解决“有没有”，运行时解决“到哪了”；后续接“OCR 行→脚本行”匹配器。版权：剧本原文不入库。

## 7. 悬浮窗与气泡双聊

- PC：置顶透明穿透窗（Electron/Tauri，`alwaysOnTop` + `setIgnoreMouseEvents`），热键切换可点模式；独占全屏下不可见（已禁独占）。
- 平板：`TYPE_APPLICATION_OVERLAY`（API 26+），`FLAG_NOT_TOUCHABLE`/`FLAG_NOT_FOCUSABLE` 切换；Android 11+ 权限到设置页开。
- 验证期：只显示最新一条文本；后续：最新 1–3 条+未读数+节流；点输入框切可点回复。
- 气泡视觉（Phase 2，细节由设计 lane 定）：多颜色/风格按角色与消息类型可配；语音消息弹语音+文字气泡（含播放态），纯文本弹文字气泡；新气泡底部进入、旧气泡逐个上顶，每气泡独立轻微浮动；无交互 4–5s 渐隐（常量可配，可点/悬停时暂停计时）。
- 发送节拍（拟人）：看一会儿再开口，不逐句跟；滚动累积近段剧情为上下文，值得反应（笑点/反转/发糖/选项）才触发，无感则跳过；语音最小间隔 15s、文字 8s（均可配）；排队只留 1 条（新覆盖旧或合并），内容聊看法不复读单句。
- 提示球：悬浮窗收起态默认用当前 char 头像，点击展开气泡与输入；换角色自动换头像。
- 展开态：气泡栈（验证期最新 1 条，后续 1–3 条+未读）＋回复输入框＋紧凑控制行（文字/语音/双开、抢话开关、音量、记不记得）；点提示球/收起键折叠。
- 游戏频道独立：独立队列、独立节流，永不进 `ProactiveChat.start/resume`，`markAmsgStateDirty`/autoArchive 默认关闭，高频字幕不污染 30 分钟主动消息。

## 8. 记忆政策（精简+手动）

- 实时气泡只进会话缓冲，不直写长期记忆；剧本原文不存，只存选择/反应。
- 游戏会话期间显式禁自动整理（`runCallMemoryPalacePostFlow` 类后置链路禁入）与脏标记。
- 收尾只调一次压缩接口：选项快照哈希 + 一句话总结，截断去重。
- 开关：按会话一键记/不记；单条可“记一下”/“这段别记”。
- 风格画像（分层汇总）：按字数阈值脑内小总结（每 3000 字剧情一次，可配），小总结攒到 5 条合成大总结（可配）；退出游戏时再筛值得进长期记忆的结论条目（可查看可删）；会话开关关闭时不跑。

## 9. 验证期最小闭环（按序 6 件）与验收

1. Eden 窗口化 → 2. WGC 按 HWND 抓源窗 → 3. 手动标底部横排 ROI →
   4. change-triggered PP-OCR → 5. PC 悬浮窗最新一条 → 6. 手动收尾一条总结。
- 验收：≥50 选项屏+≥50 对话框，选项全读出率 ≥95%，竖排切碎 <5%（竖排只抽查拒识不崩），单帧>5s 即停查。
- Android 权限矩阵（录屏/悬浮/前台/省电）逐项有拒绝降级；拒绝后仍可手动截图导入。
- 超限自动降级：平板同机跑 Citron+OCR，超帧率/温度/电量上限自动降到 2fps 纯字幕（可复现）。

## 10. 风险与降级（Top 摘录，详见 oracle 审查）

1. Android 14/15 授权与掐断（每次确认、chip 掐断、锁屏停）→ 降级手动导入。
2. DPI/窗口移动致 ROI 错位 → 停更提示重标。
3. LSFG 伪影致误触发 → 去抖常量复测。
4. 竖排/ruby/人名误读 → 验证期明确不支持。
5. 播放需手势解锁（自动播放策略），后台冻结即停，回前台补发上限一条。

## 11. 分阶段路线

- 验证期（本 spec）：PC 最小闭环 6 件 + 平板最小配（MediaProjection + ROI 2–3fps + ML Kit + 单条悬浮窗，无音频）。
- Phase 2：音频链路（预生成+抢话开关+说完不截断）与三档切换。
- Phase 3：XCI 离线剧本库 + 行级匹配 + 路线提示。

## 12. 预估触碰文件清单（写执行计划时冻结， spec 阶段不动代码）

新增（臆测，需执行计划确认）：`sidecar/`（WGC 采集、OCR 管线、localhost 桥）、`tablet-companion/`（前台服务、MediaProjection、overlay）、`overlay/`（PC 悬浮窗）。
现有只读候选：`context/OSContext.tsx`（游戏频道事件）、`utils/ttsRouter.ts`、`apps/CallApp.tsx`、`utils/perspectiveTelemetry.ts`、`utils/proactiveChat.ts`（明确不复用触发，只做隔离）、`utils/proactivePushConfig.ts`、`utils/speechToText.ts`、`utils/callAudioFeed.ts`、`index.html`、`vite.config.ts`、`dev-local.bat`。
禁区：`utils/proactiveChat.ts` 的分钟级调度链路不得改触发语义；`FORCE_DISABLED` 的 Worker 开关不动。

## 13. 待复核项（exp-2 工具中断遗留，执行计划前补查）

- `utils/keepAlive.ts` 全文、`worker/sw-keep-alive.ts` 定时器实现。
- TTS 三家在移动端的回退残留、软键盘 `visualViewport` 在 Android Chrome 的行为。
- `pipWindow.ts`/DesktopHost 现存与否（计划拟删项）。
