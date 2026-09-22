# 小红书集成 - 现状与排障（2026-09-22 重写）

> 旧版 CDP:9222 / Python CLI（xiaohongshu-skills / xiaohongshu-mcp / xhs-bridge.mjs）
> 路径已废弃：`/opt/xhs-mcp` 待删除，本文只描述现行两条路径。

## 两条现行路径

### 路径一：云端 Lite（手工 cookie）

- 前端设置 → 实时感知 → 小红书 → 「云端 Lite」，粘贴浏览器登录后的完整
  cookie（含 `a1` 和 `web_session`），点测试连接。
- 请求：前端经 `X-Xhs-Cookie` 头直发中心 Worker `/api/*`
 （`worker/index.js` XHSLite 段，签名唯一真源）。
- cookie 存前端 localStorage；数天到数周过期后重新粘贴一次。
- 失败分类见 `utils/xhsSession.ts`（`classifyXhsBridgeFailure`）：
  401 = 无会话，登录校验文案 = 过期，406/461/471 = 风控拒绝（不是过期），
  超时 = 网络问题。

### 路径二：VPS 托管（推荐，免复制 cookie）

- VPS 常驻 camofox 浏览器维护登录态；cookie 加密只存 VPS。
- 前端设置切「VPS 托管」，填 `X-Bridge-Token`，测试连接显示昵称即通。
- 调用链：前端 → Caddy `/xhs-api/*` → sessionBridge(8836，验 token) →
  解密注入 cookie → 中心 Worker。失效时去服务器浏览器扫一次码。
- 部署/扫码/轮换见 `docs/xhs-vps-session.md`。

## 排障对照表

| 现象 | 查哪里 |
|---|---|
| 测试连接 401 | cookie 空（Lite）/ token 错（VPS，bridge 回 401） |
| 「没有通过登录校验」 | 会话过期：Lite 重粘 cookie；VPS 去扫码 |
| bridge 503 | 服务器上还没有登录会话（扫码一次） |
| bridge 502 | 中心 Worker 不可达（查网络/CF 状态） |
| 406/461/471 | 风控拒绝，不是过期；换号或稍后再试 |
| 写操作（赞/藏/评/发）失败 | 永不自动重试，属正常；检查登录态后手动再发一次 |
| `storage_state` 404 | 容器刚重启，等采集器重建会话（约 1 分钟）再试 |

## xsecToken 说明

小红书反爬：详情/写操作多半要 xsecToken（每条笔记独立、会过期）。
搜索结果与首页推荐自带最可靠；详情页打开后可提取并缓存。
前端与 bridge 各有一份 Map 缓存（`xsecTokenCacheRef` / bridge 内存），
缺 token 时操作失败是预期行为，重进一次详情页再试。
