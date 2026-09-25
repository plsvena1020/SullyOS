# Google 日历 VPS 化与零维护连接 — 设计

- 状态：待评审，未提交（工作树 `feat/google-calendar`）
- 前置：只读接入（Tasks 1-9）与 char 主动创建（W1-W4）已完成并通过评审
- 目标：桥常驻 VPS，前端只填一次密码，设备自动登记，此后免重连

## 1. 目标与验收

| 目标 | 验收标准 |
|---|---|
| 桥常驻 | VPS 独立 systemd 进程 + Caddy `/google-api` 反代；前端不依赖本机 node 进程 |
| 前端极简 | 首次只填一个「配对码」；填完后所有环境（localhost 与线上网页）自动识别同一账号 |
| 免重连 | 换浏览器、重启前端、VPS 重启均无需重新授权或重填任何码 |
| 凭据不落前端 | client secret / refresh token 只在 VPS；前端只有设备 token |
| 7 天过期只花 10 秒 | 过期时前端弹「重新授权」，点一下 + Google 同意页点同意，自动回到设置页 |

明确不能消除的：Google 测试模式应用 refresh token 7 天到期，是 Google 平台规则，任何个人应用都一样。本设计把它压到「点两下」。

## 2. VPS 部署（照 xhs 模式）

- `vps-backend/deploy/google-bridge.service`：WorkingDirectory `/opt/sullyos/sullyos-repo/vps-backend/src/google`，ExecStart `/usr/bin/node run.js`，Restart=always，独立 systemd，不进 run-all。
- `vps-backend/deploy/caddy/SullyOS.Caddyfile` + 线上 `/etc/caddy/Caddyfile` 两处都加：`handle_path /google-api* { reverse_proxy 127.0.0.1:8841 }`（8838 mastodon-mcp、8839 voice-relay 已占，8841 起为空位）。
- `/opt/sullyos/.env` 新增变量（全部 secret，不入库）：

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://ethernet-vps.bot.cd/google-api/oauth/callback
GOOGLE_SESSION_KEY=<64 hex>
GOOGLE_BRIDGE_TOKEN=<配对主码，部署时生成>
GOOGLE_BRIDGE_PORT=8841
GOOGLE_SESSION_FILE=/var/lib/sullyos-google/session/session.json
GOOGLE_PAIRED_ORIGINS=http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173,<线上前端 origin>
```

## 3. 前端体验（最终形态）

设置页 Google 区块只剩：

1. 总开关（保留）
2. 「连接 Google」按钮：未配对时提示先填配对码；已配对时打开授权弹窗，弹窗内完成 Google 同意，桥回调后 `postMessage` 自动关窗并回填账号
3. 状态徽标 + 当前账号邮箱 + 日历勾选（保留）
4. 「重新授权」按钮：只在 REAUTH_REQUIRED 时出现
5. 「设备」区：显示已登记设备（浏览器/系统 UA 摘要 + 登记时间），可踢掉某台设备

删掉：Client ID 输入框、桥地址输入框（默认写死 `https://ethernet-vps.bot.cd/google-api`，localhost 开发时自动探测 `http://127.0.0.1:8841`）、桥 token 输入框、授权码粘贴框。

## 4. 配对与设备登记

**首次配对（每台设备一次）**

1. VPS 上执行 `node vps-backend/src/google/pair.js <新设备名>`，打印一次性配对码（60 秒有效、单次使用）
2. 前端设置页粘贴配对码 → `POST /api/pair { code, deviceName }` → 桥生成设备 token（AES-GCM 加密存 session 文件），返回 `{ deviceToken }` + 已配对信息
3. 前端存 `aetheros.google.deviceToken`（localStorage），永不显示

**之后**

- 所有请求带 `Authorization: Bearer <deviceToken>` 代替原 `X-Google-Bridge-Token`
- 桥把 OAuth start/callback 也纳入同一鉴权（callback 只校验 state）
- 桥支持多设备并存，每台独立可踢；踢掉后该设备下次请求 401 → 前端自动回落到「请填配对码」

**为什么不直接用主码当 token**：主码一泄露所有设备沦陷，且无法单独踢人。配对码一次性 + 设备 token 独立，是标准配对模型。

## 5. 自动 OAuth（弹窗回调，用户已选）

```
前端 → GET /api/oauth/start (Bearer deviceToken)
     ← { authUrl }                       // 含 client_id/redirect_uri/state/scope/access_type=offline
前端 window.open(authUrl)                // 新弹窗，用户在 Google 页点同意
Google → https://ethernet-vps.bot.cd/google-api/oauth/callback?code&state
     → 桥 POST oauth2.googleapis.com/token 换 refresh token → 加密落盘
     → 回 HTML：window.opener.postMessage({type:'google-connected', accountId}, 允许的 origin)
       window.close()
前端收到消息 → 刷新账号列表、显示邮箱、日历勾选
```

- state 一次性、5 分钟有效、带账号绑定，CSRF 防护
- callback 的 `postMessage` 目标 origin 只能取 `GOOGLE_PAIRED_ORIGINS` 白名单里的值（严禁 `*`）
- 无弹窗拦截（用户手动关掉弹窗）时，设置页显示「授权未完成，重新授权」按钮
- 删掉前端「授权码」粘贴框与 `window.opener` 之外的兜底流程

## 6. 组件与文件

| 文件 | 动作 | 职责 |
|---|---|---|
| `vps-backend/src/google/pair.js` + `.test.ts` | 新 | 一次性配对码生成/校验、设备表管理 |
| `vps-backend/src/google/googleStore.js` | 改 | 存储结构加 `devices` 表（设备名、token 密文、UA 摘要、时间）；账号表不动 |
| `vps-backend/src/google/googleBridge.js` | 改 | `Authorization: Bearer` 设备鉴权、`/api/pair`、oauth start/callback、`/api/devices`（列出+踢人） |
| `vps-backend/src/google/run.js` | 改 | 读 `GOOGLE_PAIRED_ORIGINS`；`GOOGLE_BRIDGE_TOKEN` 保留为配对主码 |
| `vps-backend/deploy/google-bridge.service` | 新 | systemd unit |
| `vps-backend/deploy/caddy/SullyOS.Caddyfile` | 改 | `/google-api` 反代 |
| `vps-backend/.env.example` | 改 | 补 `GOOGLE_PAIRED_ORIGINS` / `GOOGLE_SESSION_FILE` |
| `docs/google-vps-bridge.md` | 新 | 部署与运维手册（含 Caddy 两处都要改的提醒） |
| `utils/googleBridge.ts` | 改 | 设备 token 鉴权头、桥地址自动探测（localhost → 127.0.0.1:8841）、pair/devices 包装 |
| `apps/Settings.tsx` | 改 | Google 区块重做为上面的极简形态，删四个输入框 |

## 7. 数据流

配对（一次）→ 授权弹窗（每 7 天或 scope 变化时）→ 读链路（ScheduleApp/prompt/工具，零改动）→ 写链路（W1-W4，零改动）。

读链路与写链路都不感知鉴权方式变化，因为它们只经 `googleBridgeFetch` 单一出口。

## 8. 错误处理

| 情况 | 表现 |
|---|---|
| 未配对 / 设备被踢 | 401 → 设置页显示配对码输入框；读链路静默回落本地日历；char 感知为空 |
| refresh 过期 | 401 `REAUTH_REQUIRED` → 只显示「重新授权」按钮，其他输入框不出现 |
| 弹窗被拦截 | 设置页提示「授权未完成」+ 重试按钮 |
| state 校验失败 | 桥返回错误页，提示重新开始，不落盘 |
| VPS .env 改 client ID/secret | 重启 systemd 即生效，refresh token 保留（同一 Google 应用），无需重连 |
| 配对主码泄露 | `node pair.js --rotate` 轮换主码；已登记设备不受影响（设备 token 独立） |

## 9. 测试

- 桥契约：pair 码一次性、错误码拒绝、设备列表不含明文 token、踢人后 401、oauth callback postMessage target origin 来自白名单
- 前端：设备 token 头、桥地址探测（localhost vs 线上）、无 Client ID/secret 输入框
- 现有 42 条 Google 套件全绿不回归
- 含中文文件字节自查

## 10. 不做

多账号同时在 char 侧区分（已支持多账号，按现有口径）、Google Workspace 域目录、VPS 侧 WebAuthn/二次验证。
