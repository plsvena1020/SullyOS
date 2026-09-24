# VPS 直出前端设计（方案 A：单入口同域）

> 创建：2026-09-24。状态：待用户 review。用户已决策：彻底去 Vercel，VPS 做唯一生产入口。
> 约束：先产出文档，不碰业务代码与线上配置；执行需用户明确说「执行」。

## 目标

- `ethernet.bot.cd` 从 Cloudflare Pages 切到 VPS，手机 / 电脑 / 平板共用同一 HTTPS 入口。
- origin 保持 `https://ethernet.bot.cd` 不变 → 本地数据零迁移，设备端后端设置零改动。
- Pages / Vercel 观察期后下线。

## 已核实的现状事实（2026-09-24 实测，非推断）

- 线上 `/etc/caddy/Caddyfile`：旧 `43451695.xyz` 块 + 4 个 `bot.cd` 块
  （`ethernet-vps` / `oc.ethernet-vps` / `proxy.ethernet-vps` / `ethernet-mcp`）；**无 `ethernet.bot.cd` 块**。
- `ethernet-vps.bot.cd` 块结构：`handle_path` 接后端（`/phone-gateway*`→8795、
  `/agent/*`→8830 flush、`/instant-push/*`→8831、`/amsg/*`→8832、
  `/proactive-push/*`→8833、`/wake-bridge/*`→8834、`/heartbeat/*`→8835、
  `/xhs-api*`→8836、`/oc-phone/*`→4096 flush），末尾 `handle { respond 404 }`。
- Caddy 版本 2.6.2；VPS 磁盘余 26G；`/opt/sullyos/sullyos-repo` 存在
  （`vps-backend` 为其软链）。
- 仓库 canonical 模板 `vps-backend/deploy/caddy/SullyOS.Caddyfile` 只有旧单站点块，
  与线上已漂移——改线上前以线上文件为准，事后回写模板（另行任务，不在本 spec）。
- 前端：`outDir dist`、默认 `base '/'`（`vite.config.ts:144-145,84`）、完整构建
  `pnpm build = build:workers && vite build`（`package.json:8,10`，禁裸 `vite`、
  禁 `GITHUB_PAGES` 相对 base）；`dist` 约 67MB；仓库全仓无 `file_server` /
  `try_files`（需新增）。
- `ethernet.bot.cd` 当前 DNS：CNAME → `sullyos-15n.pages.dev`。
- Vercel `sully-os` 生产分支仍为 `master`（用户手动改 `ethernet`，改后用
  `GET /v9/projects/{id}` 看 `link.productionBranch` 验证；与本 spec 并行，不阻塞）。

## 设计

### D1 域名与流量

- `ethernet.bot.cd`：CNAME（pages.dev）改为 A 记录 → VPS IP。
  IP 以 DNSHE 上 `ethernet-vps.bot.cd` 现有 A 值为准（实施时当场抄，不写死）。
- 其余记录（`ethernet-vps` / `oc.*` / `proxy.*` / `ethernet-mcp`）一概不动。
- 端口无新增（复用 80/443）；`ethernet.bot.cd` 为新主机名，Caddy 自动签发 LE
  证书一张。

### D2 Caddy 改动（只加不改）

- 新增站点块 `ethernet.bot.cd`：
  1. `handle_path` 逐字复制 `ethernet-vps.bot.cd` 块的全部后端路径（含
     `flush_interval -1` 等参数，一字不差）。
  2. 末尾 `handle` 不写 404，写静态：
     `root * /opt/sullyos/frontend-dist` +
     `try_files {path} /index.html` + `file_server`。
- 现有 6 个块一字不动。改前备份 `/etc/caddy/Caddyfile`；
  改后 `caddy validate` → `systemctl reload caddy`。
- 无路径冲突依据：`handle_path /agent/*` 等比末尾 `handle` 更具体，优先匹配；
  静态只接住 API 路径之外的请求。

### D3 构建同步

- 本地 `pnpm build`（全量，禁裸 `vite`），`dist/` 同步到 VPS
  `/opt/sullyos/frontend-dist/`（新建目录；首次全量 67MB，之后增量）。
- 落盘权限：root 可读即可（Caddy 以 root 运行，沿用线上惯例）。

### D4 设备端

- 零改动：origin 不变，本地数据、推送订阅、四类设置地址全部沿用。
- 可选优化（不强制）：前端同域 `/agent` 直连已就绪（D2 已代理），以后再切。

### D5 验证（按序，任一红即停）

1. `caddy validate` 通过；`systemctl reload` 无报错。
2. `https://ethernet.bot.cd/` 200，标题 SullyOS（DNS 生效后）。
3. `https://ethernet.bot.cd/agent/health` 200（同域后端）。
4. SPA 深链（如任意前端路由）200 回 `index.html`。
5. 证书：`ethernet.bot.cd` LE 有效。
6. 手机 / 平板 / 电脑三端各打开一次，进聊天发一条消息。
7. 旧入口回归：`ethernet-vps.bot.cd/agent/health` 仍 200。

### D6 回滚

- DNS 把 `ethernet.bot.cd` 改回 CNAME `sullyos-15n.pages.dev`（分钟级）。
- Caddy 新块保留（注释或保留均可，不影响回滚）。

### D7 下线（观察期后，需用户二次确认）

- 观察期建议 ≥7 天，期间 Pages / Vercel 保留不动。
- 下线内容：Pages 项目自定义域、`sully-os` 备用部署、线上旧 `43451695.xyz` 块。
- 不删：DNSHE 注册名、VPS `.env`、推送凭据。

## 待 plan 阶段闭环的风险项

- R1 `/api/*`（minimax / fishaudio / elevenlabs 系 Vercel serverless）：
  前端是否调用、调用量多大；VPS 无 serverless 运行时，替代方案
  （转 VPS 端口 / 保留 Vercel 仅供 `/api/*` / 下线对应功能）由 plan 阶段实测定。
- R2 `VITE_PROXY_WORKER_URL` 保持 `https://proxy.ethernet-vps.bot.cd` 不变；
  构建期注入，换值需重构建重同步。
- R3 SW（`sw-keep-alive.js`）跨版本缓存：切后首访若命中旧 SW，以 plan 阶段
  实测为准，必要时加版本探针。

## 非目标

- 不改仓库 canonical Caddy 模板（漂移回写另行任务）。
- 不改前端代码、环境变量、推送配置。
- 不动 DNSHE 除 `ethernet.bot.cd` 外的任何记录。
