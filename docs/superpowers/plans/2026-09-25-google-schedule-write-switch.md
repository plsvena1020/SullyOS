# Google 日历 · 日程读写路由切换 — 执行计划

> 写给弱执行者：每步自带路径、行号、代码意图、验收判据。计划先行，未经用户说「执行」不碰业务代码。
> 生成时间：2026-09-25 · 基线：交接文档 `docs/handoff-google-calendar.md` · 分支 `ethernet`（领先远端约 38 提交，不要 push）

## 0. 结论（先读这段）

- 「日程 tab」= `apps/ScheduleApp.tsx:97` 的 `calendar` 分支（月网格 + 当日列表），不是 `quest`（心愿单/`Task`）也不是 `server_events`（时光契约/`Anniversary`）。
- 切换范围只动 `calendar` 分支：连上 Google 后该分支隐藏本地 Anniversary、全部走 Google；`quest`/`server_events` 两分支零改动。
- 桥（`vps-backend/src/google/googleBridge.js`）缺 3 个路由：`POST /api/calendars`、`PUT /api/events/:id`、`DELETE /api/events/:id`；另缺 `calendar` 写 scope 和前端改/删客户端。
- Caddy 反代（`vps-backend/deploy/caddy/SullyOS.Caddyfile:79`）透传全方法，无需改；桥内 `OPTIONS` 的 `allow-methods` 缺 `PUT`，W2 顺手补。

## 1. 类型确认（已代用户读完，执行者复核即可）

- `types.ts:4087` `Task` = 心愿单（`quest` tab，`ScheduleApp.tsx:430 handleAddTask`）。**保持本地 IndexedDB，不动。**
- `types.ts:4107` `Anniversary` = 时光契约（`server_events` tab，`ScheduleApp.tsx:472 handleAddAnni`，含 `repeat`/农历）。**保持本地，不动。**
- `calendar` tab（`ScheduleApp.tsx:670-799`）= 当月网格 + 当日列表，当前是「本地 Anniversary（`dayAnnis`/`dotMap`）+ Google 只读叠加（`selGoogleEvents`/`googleDotMap` 蓝点）」。**这是本次唯一要切换的分支。**
- Google 拉取入口 `ScheduleApp.tsx:141-210`：按 `calCursor` 月窗口 `timeMin/timeMax` 拉 events + 假日 + 待办，失败静默。双向同步沿用此链路：写后重拉即可。

## 2. 前置手动操作（用户做，约 5 分钟）

1. Google Cloud Console → 该 OAuth Client 的 scope 页勾选 `https://www.googleapis.com/auth/calendar`（建日历/改/删需要；现有 5 个 scope 不含）。
2. 设置页断开重连一次 Google（`buildGoogleAuthUrl` 已带 `prompt=consent`，重授权即拿新 scope 的 refresh token）。
3. 回调地址不变（localhost + 线上两条已登记）。

## 3. 本次触碰文件清单（只许动这些）

| # | 文件 | 动什么 |
|---|---|---|
| 1 | `utils/googleCalendar.ts:7-8` | `GOOGLE_SCOPES` 追加 `calendar` 写 scope |
| 2 | `vps-backend/src/google/googleBridge.js` | 新增 `googlePut`/`googleDelete` helper（照抄 `googlePost:141-166`）；新增 3 路由；`OPTIONS:54` 的 allow-methods 加 `PUT` |
| 3 | `vps-backend/src/google/*.test.js`（按现有命名） | 3 路由的 TDD 单测 |
| 4 | `utils/googleBridge.ts:67-82` | 新增 `createGoogleCalendar` / `updateGoogleEvent` / `deleteGoogleEvent`（照抄 `createGoogleEvent` 形状） |
| 5 | `utils/googleBridge.test.ts` | 新增 3 客户端单测 |
| 6 | `utils/googleCalendar.test.ts` | scope 断言追加新 scope |
| 7 | `apps/ScheduleApp.tsx:141-210, 670-799` | calendar 分支切换（详见 W4），quest/server_events 禁止改 |
| 8 | `apps/Settings.tsx` Google 区块（约 4730） | 如有 scope 文案/重授权提示则顺手更新，无则不动 |

禁止：`utils/db.ts`（本地存储不动）、`types.ts`（类型不动）、Caddyfile（无需改）、任何 `worker/*.bundle.js`（构建产物）。

## 4. 分步执行（按序，弱执行者逐条勾选）

### W1 · scope（约 15 分钟）

- [ ] 读 `utils/googleCalendar.ts:1-29`。
- [ ] 改 `GOOGLE_SCOPES`（第 7-8 行）：在现有串尾空格追加 `https://www.googleapis.com/auth/calendar`。注释同步加一行：`// - calendar：创建 SullyOS 专用日历 + 改/删事件（写）`。
- [ ] 读 `utils/googleCalendar.test.ts` 中 scope 断言段，把新 scope 加入期望（照抄现有 `toContain` 写法逐个加）。
- [ ] 验收：`pnpm vitest run utils/googleCalendar.test.ts` 全绿。

### W2 · 桥新增 3 路由（约 1 小时，TDD）

- [ ] 读 `vps-backend/src/google/googleBridge.js:141-166`（`googlePost`）、`:257-291`（POST events/tasks 写法）、`:46-57`（OPTIONS）。
- [ ] 先写单测（RED）：`POST /api/calendars`（带 `summary=SullyOS` 返回 `id`）、`PUT /api/events/:id`（改标题成功）、`DELETE /api/events/:id`（删成功）、缺 `x-google-account` → 400、`REAUTH_REQUIRED` → 401。启动写法照抄同目录已有 bridge 单测的 `startGoogleBridge({port:0,...})` 模式。
- [ ] 再实现（GREEN），全部照抄现有形状：
  - 新增 `googlePut(accountId, upstreamUrl, payload)` / `googleDelete(accountId, upstreamUrl)`，放在 `googlePost` 后面：取 token → `fetch(method PUT/DELETE)` → 401 清缓存抛 `REAUTH_REQUIRED` → 非 2xx 抛带 `status`/`data` 的 `UPSTREAM_API_ERROR`（逐行对齐 `googlePost:155-165`）。
  - `POST /api/calendars`：`readJsonBody` → `accountId` 取头优先（同 260 行写法）→ `payload.summary || 'SullyOS'` → `googlePost(accountId, 'https://www.googleapis.com/calendar/v3/calendars', {summary, timeZone: DISPLAY_TIME_ZONE})` → `finish(200, data)`；catch 段照抄 273-276。
  - `PUT /api/events/:eventId`：路径正则 `^/api/events/([^/]+)$` + `method==='PUT'` → 取 `calendarId`（body 优先，无则 400 `missing calendarId`）→ 给 `event.start/end.dateTime` 无 `timeZone` 的补 `DISPLAY_TIME_ZONE`（照抄 269-270 两行）→ `googlePut(.../calendars/{calendarId}/events/{eventId})`。
  - `DELETE /api/events/:eventId`：同上正则 + `method==='DELETE'` → `calendarId` 取 query 或 body（无则 400）→ `googleDelete(...)` → `finish(200, {ok:true})`。
  - `OPTIONS:54` 的 `'GET, POST, DELETE, OPTIONS'` 改为 `'GET, POST, PUT, DELETE, OPTIONS'`。
- [ ] 验收：`pnpm vitest run vps-backend/src/google/` 全绿；`node --check vps-backend/src/google/googleBridge.js` 无输出。

### W3 · 前端客户端（约 30 分钟，TDD）

- [ ] 读 `utils/googleBridge.ts:63-82`。
- [ ] 先在 `utils/googleBridge.test.ts` 加 3 个单测（mock `globalThis.fetch`，断言 path/method/header/body）：`createGoogleCalendar({accountId, summary})` → `POST /api/calendars`；`updateGoogleEvent({accountId, calendarId, eventId, event})` → `PUT /api/events/{eventId}`；`deleteGoogleEvent({accountId, calendarId, eventId})` → `DELETE /api/events/{eventId}?calendarId=...`。
- [ ] 再在 `utils/googleBridge.ts:82` 后追加 3 函数，逐行照抄 `createGoogleEvent:67-72`（`googleBridgeFetch` + `X-Google-Account` 头 + `JSON.stringify` + `.then(res=>res.json())`，不做校验清洗）。
- [ ] 验收：`pnpm vitest run utils/googleBridge.test.ts` 全绿。

### W4 · 日历 tab 切换（约 2 小时，核心）

- [ ] 读 `apps/ScheduleApp.tsx:133-210`（Google 拉取）、`:686-799`（dots + 当日列表）。
- [ ] 新增模块级常量：`const SULLYOS_CALENDAR_KEY='aetheros.google.sullyosCalendar'`（key 格式沿用 135-137 行注释风格：`accountId::calendarId` 存 localStorage）。
- [ ] 抽 `loadGoogleMonth`：把 143-208 的 IIFE 内核原样抽成 `useCallback` 可复用函数（签名 `(cursor:{y,m})=>Promise<void>`，内部逻辑一行不改，只是可被写后调用）。
- [ ] `googleEnabled` 派生：`localStorage['aetheros.google.enabled']==='1' && selected.length>0`（读法照抄 144-151 的 try/catch 块，放到 render 前的 `useMemo` 或行内 const）。
- [ ] 切换渲染（只动 calendar 分支）：
  - `googleEnabled` 为 true 时：`dotMap`（本地 Anniversary 点）不渲染、`dayAnnis` 列表段（769-779）整段隐藏、新建 Anniversary 入口在 calendar 上下文中禁用（按钮置灰 + toast「已连 Google，日程走 Google 日历」）；`selGoogleEvents/Tasks` 保持。
  - 每条 Google 事件行加「改 / 删」按钮（只在 `googleEnabled` 显示）：改 → 复用 `showAnniModal` 改成通用编辑态或新建小 modal（标题/日期/时间三字段，onSubmit 调 `updateGoogleEvent`）；删 → `confirm` 后调 `deleteGoogleEvent`。
  - 新建日程按钮（calendar 分支顶部加一个「+ 新建日程」）：字段标题/日期/时间/地点，onSubmit 逻辑：读 `SULLYOS_CALENDAR_KEY`，无则先调 `createGoogleCalendar({summary:'SullyOS'})` 存 key，再调 `createGoogleEvent`（`event` 体用 `buildEventBody({title, dateKey, timeText})` 现成函数，`utils/googleCalendar.ts:202`）。
  - 每次写成功后 `await loadGoogleMonth(calCursor)` 重拉；失败 toast 透传桥错误（`REAUTH_REQUIRED` → 提示重连）。
- [ ] 验收（手动，localhost）：A 连 Google 后 calendar 只见 Google 蓝点、无本地契约；B 新建进 SullyOS 日历且 Google 网页可见；C 网页改标题后小手机切月再切回即更新；D 删除双向消失；E 断开 Google（关总开关）后本地契约原样回来。另跑 `pnpm vitest run utils/googleCalendar.test.ts utils/googleBridge.test.ts utils/agenticTools.google.test.ts utils/chatPrompts.google.test.ts` 全绿。

### W5 · 部署（约 20 分钟，用户配合）

- [ ] 桥文件上传 VPS：`/opt/sullyos/sullyos-repo/vps-backend/src/google/googleBridge.js`（直接传文件，不要 git pull），然后 `systemctl restart google-bridge`。
- [ ] 验收：`curl -s https://ethernet-vps.bot.cd/google-api/api/health` → `{"status":"ok"...}`；`journalctl -u google-bridge -n 20 --no-pager` 无报错。Caddy 两边（仓库模板 + 线上 `/etc/caddy/Caddyfile`）均无需改（反代透传全方法）。

### W6 · 收尾回归（约 20 分钟）

- [ ] 跑 `pnpm vitest run utils/googleCalendar.test.ts utils/googleBridge.test.ts utils/agenticTools.google.test.ts utils/chatPrompts.google.test.ts utils/backupSecrets.test.ts vps-backend/src/google/ utils/airp/` 全绿。
- [ ] 跑编码护栏：`python -c "import glob,os;fs=[f for f in glob.glob('**/*.ts',recursive=True)+glob.glob('**/*.tsx',recursive=True)+glob.glob('**/*.js',recursive=True) if os.path.isfile(f) and 'node_modules' not in f];bad=[f for f in fs if '\ufffd' in open(f,encoding='utf-8').read()];print('BAD:',bad) if bad else print('CLEAN')` → `CLEAN`。
- [ ] 全量 `pnpm vitest run` 允许已知 3 失败（corsContract CRLF、mallData 未跟踪、mojibakeGuard 命中 scratch），新增失败零容忍。

## 5. 风险与不做

- Anniversary 重复规则（yearly/lunar/RRULE）不映射到 Google：`server_events` 本地保留即是为此；calendar 切 Google 后重复日程用 Google 网页的重复设置。
- 存量本地 Anniversary 不迁移：calendar 隐藏而非删除，断开即回；迁移脚本本次不做。
- 配对码机制（交接 §七-4）、Vercel 重部署（§七-2）、工作树清理（§七-3）都不在本计划内，另起任务。
- 端口 8841、CORS 双带、`calendarList` 需 `calendar.readonly` 三条红线（交接 §四）保持，W2 已内化。

## 6. 工时估计

W1 15 分钟 + W2 1 小时 + W3 30 分钟 + W4 2 小时 + W5/W6 40 分钟 ≈ 4 小时（含单测与手动验证）。
