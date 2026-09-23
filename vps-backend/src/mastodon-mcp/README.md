# sullyos-mastodon MCP（VPS，127.0.0.1:8837）

给小手机朋友圈用的薄 MCP：8 个工具（发帖/传图/删帖/点赞/取消赞/home 流/公开流/某人帖子），默认发帖 `private`。

## 一键绑定

1. 朋友圈点「用 Mastodon 登录」，填实例域名。
2. 前端注册应用并跳实例 OAuth 授权，scope 照抄：
   `profile read:statuses write:statuses write:media write:favourites`
   （`write:follows` / `write:blocks` / `write:mutes` 永不申请；`read:public` 不存在，别填）。
3. 回调拿 code 换 token，前端调 `POST /api/accounts/bind`（附 MCP token），VPS 用
   `verify_credentials` 核对身份后落盘，不回显 token。
4. 兜底：实例站 Preferences → Development → New application，手动粘贴 token。

角色账号在资料页勾 bot；账号默认发帖隐私选私密（`source[privacy]=private`）。

## VPS 部署

1. `/opt/sullyos/.env` 配键（`MASTODON_MCP_TOKEN` 必填；`MASTODON_ACCOUNTS` 可空，绑过就有文件）。
2. `systemctl enable --now mastodon-mcp`（单元文件 `deploy/mastodon-mcp.service`）。
3. Caddy 同步本仓 `deploy/caddy/SullyOS.Caddyfile`（`/mastodon-mcp*` → 8837）。
4. `curl http://127.0.0.1:8837/api/health` 应回 `{"status":"ok","backend":"mastodon-mcp","tools":8}`。

先只读试运行：`MASTODON_READ_ONLY=1`，调 `timeline_public`，写工具全拒且审计落盘。
