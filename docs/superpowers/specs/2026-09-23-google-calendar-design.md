# Google 日历接入设计（Calendar + Tasks + 节假日）

- 状态：待评审，未提交（工作树 `feat/google-calendar`，基线 `6b7bc1d5`）
- 选型：沉浸感优先；代理交换打底 + MCP 工具化封顶（2+3）
- 范围：只读先行；char 主动创建为例外（见 §12，需读写 scope，用户重授权）

## 1. 目标

Google 日历事件、待办、官方假日进小手机：一是显示在「时光契约」日历里，二是 char 被动感知（聊天 + 主动消息提前提醒）与主动查询（对话中实时查任意范围），增强沉浸感。

## 2. 范围（P0 锁死）

- 日历事件只读：`calendar.events.readonly`
- 待办只读：`tasks.readonly`（只有日期无时刻，与 Calendar 互补）
- 官方假日：用 Calendar API 读 `zh.china#holiday@group.v.calendar.google.com`，scope 为 `calendar.events.public.readonly`
- 不做：写事件/勾待办、Gmail、通讯录、翻译、表格、视频、健康，天气地图沿用现有 API

## 3. 现状锚点

- 日历 UI：`apps/ScheduleApp.tsx:90` 主入口（任务 + 纪念日 + 月历 + 农历/法定假日），`apps/Launcher.tsx:436` 月历缩览，`components/handbook/CalendarView.tsx:42` 通用月历基类
- 事件源：`types.ts:4095` Anniversary、`types.ts:1127` DailySchedule、`types.ts:4075` Task；展开引擎 `utils/anniversaryEngine.ts`；法定假日 `utils/cnHoliday.ts:172` + 内存改写 `utils/scheduleHolidaySync.ts:30`
- char 上下文：唯一入口 `utils/chatPrompts.ts:360 buildSystemPromptParts`，经 `utils/chatRequestPayload.ts:236` 组装，日程槽位在 `chatPrompts.ts:684` 旁（`getDailyScheduleForChar`）
- OAuth 现状：无用户 OAuth 通道；可抄形状：飞书 code 换 token 经 Worker（`utils/realtimeFetchCore.ts:360` + `worker/index.js:3412`）、Mastodon 绑定设计（code→token→verify→落盘→永不回显，有设计无代码）
- 设置页：`apps/Settings.tsx:615`，第三方凭据分区见 Notion `4445` / 飞书 `4485` / MCP 卡片 `215`；状态徽标 `components/StatusBadge.tsx:51` + 探针 `utils/statusPanel.ts:80`；脱敏 `utils/backupSecrets.ts`

## 4. 架构：前端一键发起，后端换存

- 设置页一个「连接 Google」按钮：点 → 跳 Google 同意页 → 自动跳回 → 显示已连接日历列表勾选，全程无复制粘贴
- 前端只拿授权 code 交后端；code 换 token、API 调用、refresh 保管全在 Worker/VPS 代理侧（抄飞书形状），`client_secret` 不落前端
- 纯前端 PKCE 不用：refresh 仍需交后端一份（云端主动提醒要用），白存两份还多一处泄露面
- 后端 token 落盘照 Mastodon 设计：verify 后落盘、永不回显；前端无 token 落盘
- 回调地址配两个：localhost 本地地址 + 线上 Worker 回调（见 §9 用户手动操作）

## 5. 组件

1. 后端 google 代理端点：授权回调接收 code、换 token、事件/待办增量拉取（syncToken）、日历列表
2. 设置页 Google 区块：放 `apps/Settings.tsx` 第三方分区，用 `SettingsSection` 外壳 + `StatusBadge` 四态；只显示账号、连接状态、日历勾选、断开按钮，refresh token 永不回显（与现有 password 全值回显习惯反着来，见 §3 锚点 `Settings.tsx:4461`）
3. ScheduleApp 图层：日历 tab 叠加 Google 事件 + Tasks 到期；官方假日与本地 `cnHoliday` 合并（Google 优先、本地表兜底）
4. char 被动：在 `buildSystemPromptParts` volatile 槽位旁加 Google 近期日程/待办注入（与 `getDailyScheduleForChar` 并排），聊天与主动消息打包共用
5. MCP 只读工具：`queryEvents(range)` / `searchEvents(keyword)` / `listTasks()`，走现有 `mcp-relay?target=` 中转约定；写接口留空

## 6. 数据流

授权 → 后端增量拉取 → 前端展示 + prompt 注入 + 主动消息打包。读链路先跑通，写操作后加。

## 7. 隐私与安全

- 最小 scope（三个只读）；标题隐私开关（正文默认不进 prompt，可选）
- `backupSecrets.ts` 新增 Google 相关字段脱敏，与飞书四件套放一处
- 后端存储文件权限参照 VPS `.env`（chmod 600，不入库）

## 8. 异常与降级

- token 失效：设置页状态变红，推重新授权；失效期间日历只显示本地数据
- 配额超限：退回本地日历 + 缓存，不弹错
- 假日源缺失：`cnHoliday` 本地表兜底，返回 null 严格降级（现有行为不变）

## 9. 用户手动操作（localhost 可做 / 需线上环境）

- localhost 可做：建 Google Cloud 项目、配 OAuth 同意屏、加本地回调地址、本地联调
- 需线上环境：Worker 回调域名、线上 client 配置、云端主动提醒验证

## 10. 测试

- mock Google 的契约测试，不碰真实账号
- 含中文文件走字节级自查（扫 EF BF BD），有编码护栏则跑一遍
- 不为复述实现的改动写测试

## 11. 不做事项

ScheduleApp 手动创建、Gmail/通讯录/翻译/表格/视频/健康接入、Custom Search 依赖（已公告 2027 停止，不引入）。

## 12. char 主动创建（写例外，2026-09-24 增补）

- scope 升级：`calendar.events.readonly`→`calendar.events.owned`（只读写自有日历，用户无共享日历，最小权限）、`tasks.readonly`→`tasks`（完整含只读，原功能不受影响）；用户去 Auth Platform Data Access 多勾两项，设置页重连一次。
- 确认环：char 不直写，先回预览（目标日历/清单、标题、时间逐项列出），用户点头才调写入；时间模糊先问不猜；默认主日历加默认待办清单。
- 写入口：桥 `POST /api/events`、`POST /api/tasks`；纯函数出参构造；agent 工具 `propose`（纯）加 `execute`（需 `confirmed: true`，否则抛错不写）。
