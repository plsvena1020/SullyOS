# Perspective Worker（用户自建）

透视窗三端共用后端：Web、Android、Windows 把 `AppActivitySession`
批量上传到这里；角色经逐角色只读令牌查询。

只存应用身份与会话时长，不建窗口标题、URL、正文、消息列。

## 部署

```bash
wrangler d1 create sullyos-perspective
# 把 database_id 填进 wrangler.toml
wrangler secret put PV_PAIRING_CODE
# 可选：
wrangler secret put PV_ADMIN_TOKEN
wrangler secret put PV_IP_SALT
wrangler deploy
```

环境变量：

- `PV_PAIRING_CODE`（必填）：设备配对码。
- `PV_ADMIN_TOKEN`（可选）：管理操作令牌。
- `PV_IP_SALT`（建议）：限流哈希盐。
- `PV_RETENTION_DAYS`（默认 30，夹取 1..30）。
- `PV_RATE_EVENTS_PER_MIN`（默认 120）。
- `PV_MAX_BATCH`（默认 200）。

健康检查：`GET /health` 免鉴权。
