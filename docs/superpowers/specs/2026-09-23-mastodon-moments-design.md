# Mastodon × 朋友圈双向同步设计（spec，待执行授权）

状态：设计稿，只写文档，不碰业务代码。用户明确说「执行」才动手。
用户决策（2026-09-23）：方向 = 双向同步（发出去 + 读回来，ID 互存防重）。

## 0. 总体结果（用户要的样子）

- 朋友圈是独立 App（桌面/启动器新入口，微信式）：顶部个人页（封面背景 + 头像 + 昵称）→ 熟人时间线（角色们 + 我，按时间排）→ 发帖框（选身份：我 / 某角色）→ 点赞/评论。
- user 可自定义头像（现有 `userProfile.avatar` + 按角色 `perCharAvatars`，见 `apps/Chat.tsx:4226`、`components/user/PerCharAvatarPicker.tsx`）与朋友圈封面（新增 `UserProfile.momentsCover?: string`，存 blobref/dataURL，与头像同一套图片管线）。
- user 与每个 Char 都有自己的 Mastodon 账号并在设置里各自绑定（user 绑自己的实例 + token；角色绑它的实例 + token）；发帖时按所选身份用对应 token 发到对应账号。
- 小手机上的互动与真实软件打通：发帖/删帖/点赞/回复直写 Mastodon（该身份账号名义）；Mastodon 时间线读回朋友圈（带远端 id 去重）。默认 `private`，防路人（§2/§3）。

## 1. 目标与非目标

- 目标：新建微信式朋友圈（用户视角熟人时间线，见 §1.5）：角色发的帖子可同步到 Mastodon；Mastodon 时间线可读回朋友圈一起看。ID 双向互存，重复刷新/重发不产生 duplicate。
- 非目标：每角色独立 Mastodon 账号（ phase 2）；评论/点赞/转嘟同步（只做帖子本体 + 首图）；OAuth 登录流（先用手动 access token）。

## 1.5 朋友圈与 Spark 分离（2026-09-23 用户决策）

- Mastodon 双向同步挂「朋友圈」（微信式熟人时间线），不挂 Spark。
- 现状：查手机里已有 Moments（`apps/CheckPhone.tsx:2776 renderMoments`，看指定角色手机里的 `social` records，是 TA 视角）；Spark（`apps/SocialApp.tsx`）是公共广场（豆瓣热帖 + 角色帖混合）。
- 要新建的是用户视角的熟人时间线：看我认识的角色们发了什么（点赞/评论、按时间排、发帖框），样式仿微信朋友圈。数据源二选一（执行时定）：
  （a）聚合各角色 `social` records（查手机同一存储，零新表，熟人语义天然对齐联系人簿）；
  （b）复用 `social_posts` 但只取熟人帖（`authorCharId` 在联系人簿/神经链接里，豆瓣路人帖排除）。
- Spark 去留（2026-09-23 用户决策）：两个都留。朋友圈看熟人，Spark 看广场，互不影响；执行计划不碰 `SocialApp` 与桌面入口。

## 2. 架构决策

- 自建薄 MCP（`thenavidm` 76 工具全量约 17.5k tokens/轮，否决；`sandraschi` outbox 人审与角色发帖语义冲突，否决）。
- TypeScript + Zod，`server.registerTool`，`outputSchema` + `structuredContent`，annotations 对齐前后端：
  写（`moments_post`/`moments_delete`）`{ readOnlyHint:false, destructiveHint:true }`，
  读（3 个 timeline）`{ readOnlyHint:true, openWorldHint:true }`。
- 跑在 VPS 上 streamable HTTP（长期规则：MCP 默认放 VPS，不跑本地 stdio、不依赖电脑常开，随时可用），浏览器经现有 `?target=` 代理（`scripts/mcp-proxy.mjs:165-179`，`utils/mcpClient.ts:362-375 buildMcpFetchUrl`）或主代理 `/agent/v1/mcp-relay?target=` 连接。stdio 现成 server 浏览器不可直连，不用。
- 6 个工具封顶：`moments_post`（含 `in_reply_to_id` 即回复） / `moments_upload` / `moments_delete` / `status_favourite` / `status_unfavourite` / `timeline_home` / `timeline_public` / `account_statuses`（8 个，互动打通最小集，不做转嘟/关注）。
- 账号：按身份多账号。server 条目下加 `accounts[] = { ownerId: 'user' | charId, instance, handle, access_token }`；发帖/点赞/读线按所选身份选 token（`buildMcpRequestHeaders`、`targetFor`、`collectMcpFireServers` 按 ownerId 选 token，设置页导出导入与 relay 透传同步改）。user 在朋友圈个人页绑自己的实例 + token；角色在各自设置里绑。共用一账号降级：`accounts` 留空时回落整条 server token（旧语义保留）。
- 绑定流程（一键，2026-09-23 用户决策）：朋友圈点「用 Mastodon 登录」→ 填实例域名 → 前端注册应用并跳实例 OAuth 授权（scope 照 §2.5）→ 回调拿 code 换 token → 前端调 `POST /api/accounts/bind`（附 MCP token）→ VPS 用 `verify_credentials` 核对身份后落盘 `accounts.json`，token 原值不回显、不进浏览器存储。手动建应用粘贴 token 为兜底。前端回调页与绑定 UI 归 Moments App 前端计划。
- 默认 visibility `private`（仅粉丝，防路人）；`Idempotency-Key`（内容 hash）服务端存 1h 防重发；`READ_ONLY` 环境开关 + `confirm` 参数 + jsonl 审计日志。另建议把账号默认发帖隐私锁死：`PATCH /api/v1/accounts/update_credentials` 的 `source[privacy]=private`，或实例站 Preferences→默认发帖隐私选私密，防漏标。

## 2.5 权限 scope（2026-09-23 librarian 定稿，可直接抄）

- 申请字符串：`profile read:statuses write:statuses write:media write:favourites`（`profile` 需实例 4.3+，老实例回落 `read:accounts`）。
- 8 工具最小 scope：`moments_post`（含回复）=`write:statuses`；`moments_upload`=`write:media`；`moments_delete`=`write:statuses`；`status_favourite`/`status_unfavourite`=`write:favourites`（点赞是独立 scope，不归 `write:statuses`）；`timeline_home`=`read:statuses`；`timeline_public`/tag 流可匿名（实例关 public preview 时才需 `read:statuses`）；`account_statuses` 公开帖可匿名，非公开需 `read:statuses`。
- 永不申请：`write:follows`、`write:blocks`、`write:mutes`（角色不能关注/拉黑/屏蔽的 scope 层落实，`mute` 对话端点连带调不了）；另 `follow`（已废弃）、`push`、`admin:*`、`write:*` 全集一律不进清单。注意 `read:public` 这个 scope 不存在，别写。
- 角色账号设 `bot=true`（仅资料页 🤖 视觉标识，不影响被 @ 与进公开流；那是 `discoverable`/`indexable` 控制）。开启走网页勾选或一次性 `PATCH update_credentials`（该次需 `write:accounts`，日常 token 不保留）。
- 自检：`GET /api/v1/accounts/verify_credentials`（200 对身份；401 token 无效；403 `outside the authorized scopes` = 缺 scope，按上表补；422 = 拿 app token 当 user token 用了）。

## 3. visibility 映射（`utils/airp/projection.ts:19,45-57,121-134` 三分法）

| 小手机侧 | Mastodon（默认只用后三档） |
|---|---|
| public（公开且已对用户交代） | `unlisted`（登录可见、不进公开流）；真要进公开流才用 `public`，须显式 confirm |
| 已披露但不广播（内部） | `private`（仅粉丝，默认档） |
| 私密 | `private`（粉丝）或 `direct`（仅提及，替代 DM） |
| trace | 不发帖，只留本地 |

长/敏感内容加 `spoiler_text` + `sensitive:true`；`moments_upload` 经 `POST /api/v2/media` 异步（202 → 轮询 `GET /api/v1/media/:id` 到 200 有 `url`，206=转码中），`alt` 描述必填。

## 4. 数据模型（`types.ts:4120-4148 SocialPost`）

```ts
/** 帖子来源：加 'mastodon'（读回来的 toot / 同步出去且有远端 id 的帖子） */
origin?: 'gen' | 'douban' | 'mastodon';
/** Mastodon 远端 status id（双向去重键，读回/发出都要写） */
mastodonStatusId?: string;
/** 实例域名（如 mastodon.social），多实例防串 */
mastodonInstance?: string;
/** 发帖身份：'user' 或 charId（决定用 accounts[] 里哪个 token） */
mastodonOwnerId?: string;
```

用户个人页字段（`types.ts` UserProfile，执行时 grep 定位 interface 行）：

```ts
/** 朋友圈封面（blobref/dataURL，与 avatar 同一图片管线） */
momentsCover?: string;
```

（`avatar`、`perCharAvatars` 已有，不新增。）

- `sourceUrl` 复用存 status 链接，不新增字段。
- 去重：读回按 `mastodonStatusId`，发出按 `Idempotency-Key` + 本地 `mastodonStatusId` 已存在则跳过。
- 发出链：`SocialApp.handleRefresh(:499)` 生成角色帖 → 调 `moments_post` → 回写 `mastodonStatusId/mastodonInstance/sourceUrl` → `prependUniqueSocialPosts`（`utils/socialFeedMerge.ts:8-37`）→ `DB.saveSocialPost`（`utils/db.ts:1052-1080`，store `social_posts`）。
- 读回链：`timeline_home/public` → 归一化成 `SocialPost`（`origin:'mastodon'`，角色帖按 charId/handle 匹配头像同 `:638-690` 逻辑，路人 dicebear）→ `prependUniqueSocialPosts` 按远端 id 去重 → 落库。整批锚点规则照抄 `airpEventIds`（`:691-701`），不做正文子串匹配。

## 5. 触碰文件清单（执行时协调其他窗口）

- 新 App（微信式朋友圈，执行时定文件名，建议 `apps/MomentsApp.tsx`）：个人页（封面+头像+昵称+绑定入口）/ 熟人时间线 / 发帖框（身份选择：我/某角色）/ 点赞回复；`apps/Launcher.tsx` 加桌面入口。
- `types.ts`（SocialPost 加 4 字段 + UserProfile 加 `momentsCover`）
- 查手机 Moments（`apps/CheckPhone.tsx:2776 renderMoments`）不动（TA 视角保留）。
- `apps/SocialApp.tsx`（发出/读回两条链 + `renderPostCover:1085` 加远端图）
- `utils/socialFeedMerge.ts`（远端 id 去重）
- `utils/db.ts`（`social_posts` 读写不动结构，只走现有四件套）
- `utils/mcpClient.ts` + `components/settings/McpConnectionConsole.tsx`（加一条 Mastodon server，token 手填，`charIds` 留空）
- VPS 新目录（建议 `vps-backend/src/mastodon-mcp/`，server + 6 tools + guard + audit log，不在前端仓caleb? 放哪执行时定）
- `docs/mcp-user-guide.md`（token 申请路径：实例站 Preferences→Development→New application，scope 照抄 `profile read:statuses write:statuses write:media write:favourites`（§2.5）；角色账号资料页勾 bot；默认发帖隐私选私密）

## 6. 验证（分两段写）

localhost 可做：`SocialPost` 归一化单测（远端 id 去重、visibility 映射表全覆盖）、`prependUniqueSocialPosts` 幂等单测、Zod schema 非法输入拒绝单测、注解 vs `validate_write()` 一致性单测（抄 Vitex）。
需线上环境（另行确认才做）：VPS streamable-http 冒烟（`timeline_public` 只读先行）、`moments_post` 默认 `unlisted` 真发一条再删、双向各刷新 3 次无 duplicate。

## 7. 参考

- Mastodon API：https://docs.joinmastodon.org/methods/statuses/（发帖/删帖）、https://docs.joinmastodon.org/methods/media/（v2 异步）、https://docs.joinmastodon.org/methods/timelines/（时间线+分页）、https://docs.joinmastodon.org/client/token/（token）、https://docs.joinmastodon.org/api/oauth-scopes/（scope）。
- 现成 server：https://github.com/thenavidm/mastodon-mcp-cli（包一层可用，最顺）、https://github.com/VitexSoftware/mcp-server-mastodon（次选，默认只读）。
- 本次未改任何业务代码。
