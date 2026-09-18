# 酷狗全功能移植 + 网易云退役 + 桌面 CD 墙 · 设计 Spec（2026-09-18）

> 基于 v1 spec（`2026-09-08-kugou-music-source-design.md`）的第二轮：酷狗成为唯一用户音源。
> 用户决策（2026-09-18 聊天确认）：导航选「搜索页=首页+每日推荐」；CD 墙选「每首歌一张 CD 卡」；
> 播放模式故障形态为「反应慢/需点多次」（竞态）；收藏目标为「我喜欢」歌单（is_def=2）；网易云用户链路全退役。

## 目标

酷狗概念版成为音乐 App 唯一用户音源：修齐 v1 的 7 个实测问题、补齐听歌功能对等（收藏→我喜欢）、
导航升级（搜索=首页）、桌面端 CD 墙、前端网易入口全删。

## 已实测的 API 事实（2026-09-18 探针，写死在计划里勿再调研）

- `/lyric?id&accesskey&fmt=lrc&decode=true`：`decodeContent` 在响应**顶层**（非 body 内），实测 4614 字符 LRC。
- 用户歌单：`默认收藏`（is_def=1，1 首）与 `我喜欢`（is_def=2，1066 首）是**两个**特殊歌单；我喜欢识别优先级：
  `is_def===2` → `name==='我喜欢'` → 默认收藏兜底。我喜欢 listid=3（按用户账号存在），曲目用
  `/playlist/track/all/new?listid=<is_def=2 的 listid>` 分页拉（pagesize=100 + 加载更多）。
- track/all 项含 `timelen`（毫秒）；track/all/new 项含 `timelen`（毫秒）、name 带 `.mp3` 后缀；
  everyday/fm 项（`data.song_list[]`）含 `time_length`（毫秒，取代 Duration 本轮补进映射）、`songname`、
  `author_name`、`album_name`、`hash`、`mixsongid`、`album_audio_id`。
- `song/url`（原生模块）响应顶层 `url`/`backupUrl` 数组 + `bitRate` 字段；**不要**用 `auth/merge` 聚合链
  （2026-09-18 实测期间周期性能挂）。播放走原生模块即可（登录态下可用）。
- 收藏（喜欢）机制：上游 `playlist/tracks/add`（`cloudlist.service v6 add_song`，参数 `data` 格式为
  `name|hash|album_id|mixsongid` 逗号分隔串，另带 listid/userid/token）；取消收藏用 `playlist/tracks/del`
  （`cloudlist.service v4 delete_songs`，参数是 `fileids`——曲目在歌单内的 fileid 逗号分隔串，
  从 track/all 曲目项的 `fileid` 字段取，所以 liked 追踪要存 songKey→fileid 映射）。需要 worker `/kugou`
  白名单新增 `playlist/tracks/add`、`playlist/tracks/del`。
- 封面 `trans_param.union_cover` 含 `{size}` 占位 → 替换为 480。
- 音频 CDN（fs.youthandroid*.kugou.com）**无有效 HTTPS 证书**：playSong 禁止 http→https 强转，
  原样使用 http 地址（用户测试环境为 http://localhost。若部署到 https 页面，需另加 worker 音频代理，
  本 spec 不包含）。

## 修 Bug（7 项）

- **F1 歌词**：`playSong` 读 `lyricRes?.decodeContent || lyricRes?.body?.decodeContent || lyricRes?.content || lyricRes?.body?.content`。
- **F2 我喜欢识别**：按「API 事实」优先级；展开分页（100/页 + 加载更多按钮）。
- **F3 App 内收藏**：`toggleLike` 加酷狗分支——未登录酷狗提示去登录；已登录则对 `is_def=2` 歌单调
  add/del；`liked` 计算加酷狗分支；`likedSet` 初始化改为拉我喜欢第一页 id 集合（5 分钟缓存）。
- **F4 时长**：映射 `dur` 补 `time_length`；时长为 0 的行显示 em dash（`—`）而非 0:00。
- **F5 真实码率**：播放时把 `song/url` 的 `bitRate` 存进 context（`actualBitrate`），黑胶标签显示实际值，
  失败时回落配置档文案；降级到 128 时显示 128 不再谎报。
- **F6 播放模式竞态**：`cyclePlayMode` 改 ref 计算下一模式（修复快速连点竞态）+ 图标即时反馈。
- **F7 导航**：见「导航重构」。

## 导航重构

- `MusicApp` 维护视图历史栈 `viewStack`（pushView/popView 辅助）：搜索页为首页；
  无搜索词 + 无结果时展示**每日推荐横排 CD 卡区**；播放页返回键回上一个视图（兜底 'search'）。
- 个人页保留：用户信息 / 我喜欢 / 歌单 / 最近在听 / 私人 FM。

## 桌面 CD 墙

- 检测：`useLayoutMode(theme.desktopMode) === 'desktop'`（与 Gallery 等同款，theme 取自 useOS）。
- 新文件 `apps/music/CdWall.tsx`：响应式网格（auto-fill minmax 150px），每首歌一张 CD 卡
  （封面 + 唱片纹理、悬停播放键、底部渐变歌名艺人，点击即播）；玻璃风 + 音乐既有 C 色板。
- 适用面：搜索结果、歌单曲目、每日推荐、FM 结果、最近在听。手机端保持 SongRow。

## 网易云退役范围（前端）

- 删：设置页音源切换卡（含 `source` 写入点；类型字段保留作兼容位，不再产生新值）、
  `NeteaseLoginPanel`、`NeteaseProfilePage` 及其引用、诊断按钮网易分支、登录提示 pill 的网易分支、
  `toggleLike`/`likedSet` 网易分支（替换为酷狗分支）。
- 保留：`musicApi` 内部对象（`charLyricCache` 角色虚构口味歌词兜底，非用户链路）、worker `/netease`
  路由（纯基础设施，无前端依赖，不动）、写歌本地歌链路。
- 网易存量数据（历史里的网易歌）点击提示不可播。

## 非目标

worker 音频代理（https 页面用）、歌单新建/重命名/删除管理、评论/MV/电台、写歌链路改动。

## 交付与门禁

四批实现（bug 修复批 / 收藏批 / 导航+首页批 / CD 墙批）→ 全量 `vitest run` +
`tsc --noEmit` 触碰文件零命中 + mojibakeGuard + U+FFFD 字节扫 → vite build 出 dist →
真机验证（用户 localhost 静态服务器吃 dist）→ 确认后 push 收尾。
执行计划见 `docs/superpowers/plans/2026-09-18-kugou-full-port.md`。
