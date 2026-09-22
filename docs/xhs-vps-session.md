# XHS VPS 会话桥 · 部署与运维手册

> 设计见 `docs/superpowers/specs/2026-09-15-xhs-vps-session-bridge-design.md`，
> 执行计划见 `docs/superpowers/plans/2026-09-15-xhs-vps-session-bridge-plan.md`。
> 本文档只写「怎么做」，原理不重复。
>
> 密钥红线：四个密钥只存 `/opt/sullyos/.env`（0600），绝不进仓库；
> 本文档一律用 `<XHS_BRIDGE_TOKEN>` 等占位写法。

## 1. 密钥从哪拿（首次部署）

VPS 上执行（计划任务 5 Step 2）：

```bash
XHS_BRIDGE_TOKEN=$(openssl rand -hex 24); XHS_SESSION_KEY=$(openssl rand -hex 32)
printf 'XHS_BRIDGE_TOKEN=%s\nXHS_SESSION_KEY=%s\n' "$XHS_BRIDGE_TOKEN" "$XHS_SESSION_KEY" >> /opt/sullyos/.env
CAMOFOX_API_KEY=$(openssl rand -hex 24); XHS_CAMOFOX_VNC_PASSWORD=$(openssl rand -hex 8)
printf 'CAMOFOX_API_KEY=%s\nXHS_CAMOFOX_VNC_PASSWORD=%s\n' "$CAMOFOX_API_KEY" "$XHS_CAMOFOX_VNC_PASSWORD" >> /opt/sullyos/.env
chmod 600 /opt/sullyos/.env
```

- `<XHS_BRIDGE_TOKEN>` → 填进手机设置页（VPS 托管模式）与 amsg 凭据。
- `XHS_CAMOFOX_VNC_PASSWORD` → noVNC 登录密码（扫码时用）。
- 其余两个只活在服务器上。

## 2. 部署顺序

1. 代码：本机 push `origin/ethernet` → VPS `git pull`。
2. 容器：`bash vps-backend/deploy/xhs-camofox-run.sh`（幂等重建）。
3. 服务：`cp vps-backend/deploy/xhs-session.service /etc/systemd/system/`
   → `systemctl daemon-reload && systemctl enable --now xhs-session`。
4. 反代：`/etc/caddy/Caddyfile` 的 `ethernet-vps.bot.cd` 块 heartbeat 段后加
   `handle_path /xhs-api* { reverse_proxy 127.0.0.1:8836 }` → `systemctl reload caddy`。
5. 扫码：`bash vps-backend/deploy/xhs-login.sh` 按说明经 SSH 隧道打开 noVNC
   扫码（手机小红书 App 确认）。
6. 验收：`curl -fsS https://ethernet-vps.bot.cd/xhs-api/api/health`
   应回 `{"status":"ok","backend":"xhs-session-bridge"}`；
   带 `X-Bridge-Token` 调 `/api/check-login` 应 `logged_in:true` + 昵称。

camofox 镜像钉版：构建时记录 `git rev-parse HEAD`（/opt/camofox-browser）
与镜像 tag（默认 `camofox-browser:152.0.4-beta.28`），升级只改
`CAMOFOX_IMAGE_TAG` 后重跑 run 脚本。

## 3. 日常运维

- 查状态：`systemctl is-active xhs-session`；
  查日志：`journalctl -u xhs-session -n 50 --no-pager`（正常日志无 `a1=`）。
- 手动同步会话：设置页「立即同步」或
  `curl -X POST -H "X-Bridge-Token: <tok>" .../xhs-api/api/session/refresh`。
- 断开会话：`POST /api/session/invalidate`（清服务器会话，需重扫）。
- 整体下线（回退）：`docker rm -f camofox-browser` +
  `systemctl disable --now xhs-session` + 注释 Caddy 追加块；
  前端切回「云端 Lite」即恢复手工 cookie 路径。

## 4. 密钥轮换

1. 生成新值写入 `.env`（同第 1 节命令）。
2. `systemctl restart xhs-session`（bridge 读新 token；collector 读新 API key
   需重建容器：重跑 `xhs-camofox-run.sh`）。
3. 手机设置页更新 token；amsg 凭据重登记（换 token 后主动消息 401 见文末 FAQ）。

## 5. 常见问题

- bridge 503 = 服务器上还没有登录会话 → 扫码一次。
- bridge 502 = 中心 Worker 不可达 → 查网络与 CF 状态。
- `storage_state` 404 = 容器刚重启 → 等约 1 分钟让采集器重建会话。
- `SESSION_EXPIRED` = 服务端注销 → 重扫即可，无需碰配置。
- 主动消息 401 = token 换了没重登记 → 设置页重存 + 即时对话触发凭据重登记。
- 浏览器会话 ≠ cookie 永久有效：服务端注销仍需重扫，方案省的是复制粘贴。

## 6. 安全审计基线（任务 13 通过标准）

- `ss` 显示 8836/9377/6080 仅 127.0.0.1；5900 未发布。
- `/var/lib/sullyos-xhs` 目录 700；`grep web_session=` 会话文件 0 命中；
  bridge 日志与 camofox 日志 0 命中 `a1=`。
- Caddy 不反代 9377/6080。
- `/opt/xhs-mcp` 已删除（含 `.env.cookie` 明文残留）。
- root 密码曾在对话中暴露：已提醒轮换 + 切 SSH key 登录（人工动作）。
