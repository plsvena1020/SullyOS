# XHS VPS Session Bridge · 设计文档

> 日期:2026-09-15 · 分支:ethernet · 状态:已与用户确认,待实施
> 实施计划:`docs/superpowers/plans/2026-09-15-xhs-vps-session-bridge-plan.md`

## 1. 问题

XHS Lite(唯一业务真源,`worker/index.js` 的 `XHSLite` 段,经 CF Worker 暴露 `/api/*`)要求用户从浏览器 DevTools 手工复制 cookie 粘贴进设置页。cookie 数天到数周过期,每次失效都要完整重做「F12 → 找请求头 → 复制整串 → 粘贴 → 测试连接」。痛点:维护成本高、失效无感知、cookie 在前端 localStorage 明文存放并每次请求经自定义头出网。

## 2. 目标

- VPS 常驻浏览器(camofox-browser 容器,Camoufox/Firefox,内置 Xvfb+noVNC)持久维护小红书登录态。
- cookie 加密(AES-256-GCM)存 VPS 本地,永不出现在前端 localStorage、amsg tool_config、日志、响应中。
- 手机/电脑的前端与 amsg worker 只持随机 `X-Bridge-Token` 调 VPS bridge;bridge 在服务器内部解密注入 `X-Xhs-Cookie` 后转发中心 CF Worker。
- 失效时用户只需通过 SSH 隧道 + noVNC 在 VPS 浏览器里扫一次码。
- 顺带修复前端存量问题:cookie 内存/localStorage 分叉、请求无超时、失效无分类、并发失效无单飞。

## 3. 非目标

- 不做页面自动化(bridge 不驱动 DOM,只取 cookie)。
- 不迁移/复用 `/opt/xhs-mcp`(废弃 Python MCP,阶段四删除)。
- 不改中心 CF Worker 的业务实现(签名/命令仍是 `worker/index.js` XHSLite 唯一真源)。
- 不让 cookie 永久有效——服务端注销仍需重新登录,方案降低的是维护成本不是账号风险。
- 写操作(like/favorite/comment/reply/publish)永不自动重试。

## 4. 架构

```
camofox-browser 容器(Camoufox/Firefox,内置 Xvfb :99 + noVNC :6080,持久 profile)
    │ REST 127.0.0.1:9377,GET /sessions/:userId/storage_state
    ▼
camofoxCollector(域名白名单 xiaohongshu.com/rednote.com,404 自动重建会话)
    │ AES-256-GCM 加密(XHS_SESSION_KEY)
    ▼
sessionStore /var/lib/sullyos-xhs/session/(密文+版本单调)
    │ 解密注入 X-Xhs-Cookie
    ▼
sessionBridge 127.0.0.1:8836(X-Bridge-Token 鉴权)
    │ Caddy: ethernet-vps.bot.cd/xhs-api/* (handle_path 剥前缀)
    ▼
前端(mode:'vps') / amsg worker(stash.xhsBridgeToken)
    │ 转发
    ▼
中心 CF Worker sully-proxy /api/*(唯一业务真源,本方案零改动)
```

关键决策记录:

1. **bridge 上游转发中心 CF Worker,不在 VPS 自跑 worker/index.js**——签名唯一真源不分裂,CF Worker 的 `ALLOWED_ORIGINS` 白名单对无 Origin 的服务端调用本就放行(2026-09-12 origin-guard 契约),零部署面变化。用户 2026-09-15 拍板。
2. **bridge 是独立 systemd unit,不进 run-all/bundle-loader**——run-all 只托管 CF Worker bundle 形态;bridge 是碰本地加密文件的原生 Node 服务,与 /opt 上 kaleidoscope/theseus-brain 等既有原生服务同模式。
3. **浏览器用 camofox-browser 容器(Camoufox/Firefox),不用自建 Chrome+Xvfb+CDP**——camofox 自带 storage_state 导出/VNC 登录/持久化/代理,采集器只需轮询 REST;Chrome 方案保留为回退。用户 2026-09-16 拍板。
4. **前端 mode 三态 'local'|'lite'|'vps'**——复用既有 `XhsDeploymentMode` 显式模式设计;vps 模式下 `bridgePost` 的 `/api` REST 契约零改动(URL 经 `/xhs-api/api/...` 三层拼接走查已验证:`detectMode` 命中 bridge → `.replace(/\/api$/,'')` 剥尾 → 拼回 → Caddy `handle_path /xhs-api*` 剥前缀 → bridge 收 `/api/health`,与中心 worker health 免鉴权口径一致)。
5. **Spider v3 断路器键改双源**——vps 模式客户端拿不到 a1,bridge 在每个业务响应 merge 顶层 `xhs_session_tag = sha256(a1).slice(0,16)`(不可逆),客户端 cookie 空时改用它做断路器键,否则 vps 用户静默失去实验评论能力。
6. **版本单调**——sessionStore 以 cookie 内容 sha256 前 16 位作版本(内容寻址),旧版本不得覆盖新版本,防 Chrome 短暂清 cookie 时采集任务把好会话覆盖回空。

## 5. 生命周期与数据流

| 阶段 | 行为 |
|---|---|
| 首次部署 | 构建 camofox 镜像并启动容器,建常驻标签页,SSH 隧道+noVNC(`localhost:6080/vnc.html`)扫码登录一次 |
| 采集 | camofoxCollector 启动即采 + 每 10 分钟:GET storage_state → 域过滤 → store.save(密文落盘);404 自动建会话(持久化恢复) |
| 调用 | 前端/amsg → Caddy → bridge(验 token)→ store.get 解密 → 注入 x-xhs-cookie → 中心 worker → 透传响应 + merge xhs_session_tag |
| 失效 | 中心 worker 返回「两套后端都没有通过登录校验」(index.js:2364 既有文案)→ bridge 分类 SESSION_EXPIRED → 只读命令经单飞刷新重试一次,写命令不重试 → 用户扫码恢复 |
| 断开 | 设置页「断开会话」→ POST /api/session/invalidate → store.wipe |
| 备份 | backupSecrets 脱敏清单加 bridgeToken;vps 模式下前端根本没有 cookie 可导 |

## 6. 安全模型

- **端口**:camofox 9377 / noVNC 6080 / bridge 8836 全部仅监听 127.0.0.1(docker `-p 127.0.0.1:` 绑定;VNC 5900 不发布,容器内网可见);Caddy 只反代 bridge 的 /xhs-api 段。
- **鉴权**:bridge 除 /api/health 外全部要求 `X-Bridge-Token` 精确相等(401);token 为 24 字节随机 hex,存 `/opt/sullyos/.env`(0600),绝不进仓库,文档用 `<XHS_BRIDGE_TOKEN>` 占位。
- **密钥分立**:`XHS_BRIDGE_TOKEN`(bridge 鉴权)、`XHS_SESSION_KEY`(32 字节,AES-GCM)、`CAMOFOX_API_KEY`(storage_state 鉴权)、`XHS_CAMOFOX_VNC_PASSWORD`(noVNC 密码)四者互不复用,全存 `/opt/sullyos/.env`(0600)。
- **存储**:cookie 串密文落盘(iv||ciphertext||tag base64,JSON 外壳含 version/updatedAt/cookieNames),目录 700、文件 0600;磁盘文本 grep 不到 `web_session=` 原文。
- **脱敏**:bridge 日志只记 method/path/status/耗时/version;上游 error 转发前把 `a1=...`/`web_session=...` 正则替换为 `[REDACTED]`;所有响应 `Cache-Control: no-store`。
- **CORS**:预检照抄 2026-09-11 契约(净化回显请求头/方法 + 204 + 鉴权前),自定义头 `X-Bridge-Token`/`X-Xhs-Platform` 零配置放行。
- **浏览器加固**:camofox 容器 `--restart unless-stopped`,profile/volume 落盘持久化;idle 超时三项(SESSION/BROWSER_IDLE/TAB_INACTIVITY)必须为 0(否则采集 404);遥测 `CAMOFOX_CRASH_REPORT_ENABLED=false`;镜像钉版(Dockerfile.ci build-arg + git HEAD 记录)。
- **XSS 面**:vps 模式下前端 localStorage 不再有 cookie,只有随机 token(敏感度等同既有 apiKey 类字段)。

## 7. 分阶段交付(每批独立可终止/可回退)

1. **批次一(纯前端)**:会话错误模型、cookie 分叉修复、超时+单飞刷新、Settings 三态。即使后续全停,前端也有净收益。
2. **批次二(VPS 侧)**:camofox 容器 + 24h 可行性试验(数据中心 IP 与 Firefox 扫码兼容是最大未验证风险,止损线:被登出/持续验证/扫码页不可用)→ sessionStore → sessionBridge → camofoxCollector → docker 常驻/Caddy。阶段门:check 脚本(经中心 Worker)返回 logged_in:true。
3. **批次三(接线)**:前端 vps 模式传输、Settings 会话状态卡、amsg 上云改造(bundle 版本 2026-09-15,不再上传 cookie)。
4. **批次四(收口)**:安全审计(含删 /opt/xhs-mcp 明文 cookie 残留、root 密码轮换提醒)、六场景端到端验收、全量门禁、文档。

回退:Settings 切回「云端 Lite」即恢复现有手工 cookie 路径,代码零删除。

## 8. 已验证的环境事实(2026-09-15)

- VPS:Ubuntu 26.04,Node v22.23.2,Docker 已装,内存 7.7G(余 6.6G),磁盘余 35G,端口 8836/9377/6080 空闲,无浏览器无桌面。
- Caddy 线上配置:`ethernet-vps.bot.cd` 块已存在(域名 2026-09-15 正迁移中),追加 handle_path 即可零 DNS 变更;已有 `proxy.ethernet-vps.bot.cd` 反代 sully-proxy。
- `/opt/xhs-mcp`(disabled+inactive 的旧 Python MCP,SSE 8809,`.env.cookie` 含 928 字节明文 cookie)→ 批次四删除,已获用户确认。
- 中心 worker `/api` 路由(index.js:2471-2509)对 cookie 的既有口径:无 cookie 401、缺 a1 400、login/get-qrcode 为错误占位、`env.XHS_COOKIE` 兜底存在但仓库无配置点。
- 前端 `resolveLiteCookie`(xhsMcpClient.ts:47-54)内存优先 → 分叉风险已确认;`bridgePost`(194-241)无超时;`testConnection`(584-627)health 探测已有 10s AbortSignal 先例。

## 9. 未验证事项(实施中设实证点,不提前臆断)

- VPS 数据中心 IP 登录小红书的稳定性(任务 5 的 24h 三检,失败即止损)。
- 小红书登录页在 Camoufox(Firefox)下的扫码兼容性(任务 5 Step 5 实测,不行则回落 Chrome 方案)。
- 最小 cookie 集:从 `a1`+`web_session` 起步(中心 worker 硬校验项),首批只读调用实证后再扩。
- cookie 内容寻址版本的实际抖动频率(版本单调兜底)。
