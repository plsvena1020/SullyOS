# VPS 单入口前端切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `ethernet.bot.cd` 从 Cloudflare Pages 切换到 VPS，VPS 成为唯一生产入口。

**Architecture:** Caddy 新增 `ethernet.bot.cd` 站点块（后端 `handle_path` 逐字复制 + 静态 `file_server` + SPA 回退）；`dist` 同步到 VPS 落盘；DNS 由 CNAME 改 A；origin 不变，零数据迁移。

**Tech Stack:** Caddy 2.6.2、Vite 5 静态 `dist`（约 67MB）、DNSHE 控制台、VPS（Ubuntu，`/opt/sullyos`）。

**Spec:** `docs/superpowers/specs/2026-09-24-vps-frontend-design.md`

## Global Constraints

- 构建必须完整 `pnpm build`（`build:workers && vite build`）；禁裸 `vite`；`$env:GITHUB_PAGES` 必须为空（保证 `base '/'`）。
- 动 `/etc/caddy/Caddyfile` 前必须备份；`reload` 前必须 `validate` 通过。
- 除 `ethernet.bot.cd` 外不动 DNSHE 任何记录；不动仓库业务代码。
- 任一步骤红灯即停，不强行继续；回滚路径见 Task 6。
- 观察期 ≥7 天后才下线 Pages/Vercel，且需用户二次确认（Task 7 不自动执行）。
- Vercel 生产分支改 `ethernet` 是用户手动并行项，不在本计划内；改后通知 orchestrator 做 API 验证。

## Review Focus

1. `/api/*`（minimax/fishaudio/elevenlabs 系 Vercel serverless）若被前端调用，切后会坏 → Task 1 探针 + Task 4 变体钉住。
2. SW（`sw-keep-alive.js`）跨版本缓存导致首访旧版 → Task 6 用 `dist` 资源哈希比对钉住。
3. 手机 DNS 缓存旧 CNAME → Task 6 要求移动数据 + TTL 等待后验证。
4. 新主机名 LE 签发有时滞（切流后按需签发）→ Task 4 先 reload、Task 6 设 10 分钟重试窗。
5. 以后每次发版都要手动同步 67MB（无流水线）→ Task 3 把重复流程写死，本计划不搭流水线。

## File Structure

本次无仓库代码改动。触碰面：

- 本地构建产物（gitignored，不提交）：`D:\sullyos\dist\` → 打包为临时 `frontend-dist.tgz`（放 `C:\Users\杜昱莹\AppData\Local\Temp\opencode\`，事后删除）。
- VPS 新增目录：`/opt/sullyos/frontend-dist/`（静态根）。
- VPS 修改文件：`/etc/caddy/Caddyfile`（只追加，不改现有 6 个块；先备份）。
- DNSHE 控制台：`ethernet.bot.cd` 一条记录（CNAME→A）。
- 仓库新增：无（本计划文档本身已存在）。

---

### Task 1: R1 `/api/*` 调用调查（只读，无任何改动）

**Files:** 只读 `apps/` `utils/` `components/` `features/` `api/`

**Interfaces:**
- Consumes: 无
- Produces: 调用清单 → 决定 Task 4 用标准块还是含 `/api/*` 变体块（下游任务二选一，不猜）。

- [ ] **Step 1: 搜前端对 `/api/` 的调用**

Run: `rg -n "['\"\`]/api/" -g "*.{ts,tsx,js}" apps utils components features`
Expected: 输出调用点清单（含 `api/minimax`、`api/fishaudio`、`api/elevenlabs` 字样为命中；零输出为无调用）。

- [ ] **Step 2: 搜后端代理命名空间之外的服务端路由引用**

Run: `rg -n "api/(minimax|fishaudio|elevenlabs)" -g "*.{ts,tsx}" apps utils components | head -40`
Expected: 输出引用清单或空。

- [ ] **Step 3: 判定并记录（写进本任务结果，不改代码）**

  - 若 Step 1/2 零命中 → Task 4 用标准块。
  - 若有命中 → Task 4 用含 `/api/*` 变体块（把 `/api/*` 反代到 `https://sully-os-plsvena.vercel.app`，Vercel 项目保留为隐形上游，不下线）。
  - 把判定结论（一句话 + 命中数）贴到任务输出。

---

### Task 2: 本地完整构建

**Files:** 读仓库，写 `D:\sullyos\dist\`（gitignored，不提交）。

**Interfaces:**
- Consumes: 无
- Produces: `dist/`（`index.html` + `assets/` + `amsg-worker.bundle.js` + `sw-keep-alive.js`）→ Task 3 打包同步。

- [ ] **Step 1: 确认构建环境干净**

Run: `echo "GITHUB_PAGES=[$env:GITHUB_PAGES]"; echo "VITE_PROXY_WORKER_URL=[$env:VITE_PROXY_WORKER_URL]"; git status --short | head -20`
Expected: `GITHUB_PAGES=[]`；`VITE_PROXY_WORKER_URL` 为空（走代码默认值）
或等于 `https://proxy.ethernet-vps.bot.cd`（钉住 Spec R2；其他值先停下问）；
工作区改动均为已知项（未知改动先停下问）。

- [ ] **Step 2: 完整构建**

Run: `pnpm build`
Expected: exit 0。

- [ ] **Step 3: 验证产物齐全**

Run: `ls dist/index.html dist/amsg-worker.bundle.js dist/sw-keep-alive.js; (Get-ChildItem dist/assets | Measure-Object).Count`
Expected: 三个文件均存在；`assets` 计数 > 0。记下 `index.html` 字节数（给 Task 6 比对用）。

---

### Task 3: `dist` 同步到 VPS（可重复流程）

**Files:** 本地 `dist/` → VPS `/opt/sullyos/frontend-dist/`（新建）。

**Interfaces:**
- Consumes: Task 2 的 `dist/`
- Produces: VPS 静态根就绪 → Task 4 的 `root` 指向它；回滚用备份目录名（本任务输出中写明）。

- [ ] **Step 1: 打包**

Run: `tar -czf C:\Users\杜昱莹\AppData\Local\Temp\opencode\frontend-dist.tgz -C D:\sullyos dist`
Expected: exit 0；`frontend-dist.tgz` 约 20-30MB（压缩后）。

- [ ] **Step 2: 上传到 VPS**

调用 vps.upload：localPath `C:\Users\杜昱莹\AppData\Local\Temp\opencode\frontend-dist.tgz` → remotePath `/tmp/frontend-dist.tgz`。
Expected: 返回成功。

- [ ] **Step 3: 落盘（保留旧版可回滚）**

调用 vps.execute-command：
`TS=$(date +%Y%m%d-%H%M%S); if [ -d /opt/sullyos/frontend-dist ]; then mv /opt/sullyos/frontend-dist /opt/sullyos/frontend-dist.bak-$TS; echo "backup: frontend-dist.bak-$TS"; fi; mkdir -p /opt/sullyos/frontend-dist; tar -xzf /tmp/frontend-dist.tgz -C /opt/sullyos/frontend-dist --strip-components=1; ls /opt/sullyos/frontend-dist | head; du -sh /opt/sullyos/frontend-dist`
Expected: 输出含 `index.html`、`assets`；体积约 67M；若有旧版则打印出备份目录名（抄下来，是回滚凭证）。

- [ ] **Step 4: 清理临时包**

本地删 `frontend-dist.tgz`；VPS 删 `/tmp/frontend-dist.tgz`。
Expected: 两边均无残留。

---

### Task 4: Caddy 新增 `ethernet.bot.cd` 站点块

**Files:** 改 VPS `/etc/caddy/Caddyfile`（只追加）。

**Interfaces:**
- Consumes: Task 1 判定（标准块 vs 变体块）；Task 3 的 `/opt/sullyos/frontend-dist/`
- Produces: Caddy 生效（含新块）→ Task 5 切 DNS；备份文件名（输出中写明）。

- [ ] **Step 1: 备份线上 Caddyfile**

调用 vps.execute-command：`cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-20260924-frontend && ls -la /etc/caddy/Caddyfile.bak-20260924-frontend`
Expected: 备份文件存在（回滚凭证）。

- [ ] **Step 2: 追加站点块**

把下面整块原样追加到 `/etc/caddy/Caddyfile` 末尾（tabs 缩进原样保留；`try_files`/`file_server` 为 Caddy 2.6.2 原生指令，无需插件）：

```caddy
ethernet.bot.cd {
	# phone-chat-gateway
	handle_path /phone-gateway* {
		reverse_proxy 127.0.0.1:8795
	}

	# SullyOS VPS backend (8830-8835)
	handle_path /agent/* {
		reverse_proxy 127.0.0.1:8830 {
			flush_interval -1
		}
	}
	handle_path /instant-push/* {
		reverse_proxy 127.0.0.1:8831
	}
	handle_path /amsg/* {
		reverse_proxy 127.0.0.1:8832
	}
	handle_path /proactive-push/* {
		reverse_proxy 127.0.0.1:8833
	}
	handle_path /wake-bridge/* {
		reverse_proxy 127.0.0.1:8834
	}
	handle_path /heartbeat/* {
		reverse_proxy 127.0.0.1:8835
	}
	# xhs session bridge (token-gated, cookie stays on VPS)
	handle_path /xhs-api* {
		reverse_proxy 127.0.0.1:8836
	}

	# phone terminal -> home PC opencode via ssh -R tunnel
	handle_path /oc-phone/* {
		reverse_proxy 127.0.0.1:4096 {
			flush_interval -1
		}
	}

	# frontend static (SullyOS dist) + SPA fallback
	handle {
		root * /opt/sullyos/frontend-dist
		try_files {path} /index.html
		file_server
	}
}
```

Task 1 若判出 `/api/*` 有调用，在 `# frontend static` 块之前插入下面一段（否则不加）：

```caddy
	# legacy Vercel serverless (kept invisible until ported)
	handle_path /api/* {
		reverse_proxy https://sully-os-plsvena.vercel.app {
			flush_interval -1
		}
	}
```

- [ ] **Step 3: 校验并重载**

调用 vps.execute-command：`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`
Expected: 输出 `Valid configuration`；reload 无报错。任一失败 → 用 Step 1 备份恢复后停下（`cp` 回去 + `reload`），不进入 Task 5。

- [ ] **Step 4: 确认旧站无损**

调用 vps.execute-command：`curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8830/ https://ethernet-vps.bot.cd/agent/health https://ethernet-mcp.bot.cd/ruota/mcp || true`
Expected: 后两个外网地址 logic 不变（本机 curl 走回环仅作进程存活参考，`8830/` 非 200 属正常，只要 Caddy reload 成功即过）。

---

### Task 5: DNS 切换（DNSHE 控制台手动）

**Files:** DNSHE 上 `ethernet.bot.cd` 一条记录。

**Interfaces:**
- Consumes: Task 4 已 reload 成功
- Produces: 公网 `ethernet.bot.cd` → VPS → Task 6 验证。

- [ ] **Step 1: 抄下 VPS 现行 IP**

Run: `nslookup ethernet-vps.bot.cd 1.1.1.1`
Expected: 记下返回的 A 记录 IP（实施时当场抄，不写死、不假设）。

- [ ] **Step 2: 控制台改记录**

DNSHE → 域名管理 → `ethernet.bot.cd` → 把 CNAME（`sullyos-15n.pages.dev`）改为 A 记录 → Step 1 的 IP。保存。
Expected: 控制台显示 A 记录生效中。

- [ ] **Step 3: 等待并验证传播**

Run（改后每 2 分钟一次，最多 10 分钟）：
`nslookup ethernet.bot.cd 1.1.1.1` 与 `nslookup ethernet.bot.cd 8.8.8.8`
Expected: 两处都返回 Step 1 的 IP（未生效前停下等，不进 Task 6）。

---

### Task 6: 端到端验证探针（任一红即停，按序）

**Files:** 无改动，只读探针。

**Interfaces:**
- Consumes: Task 5 传播完成
- Produces: 全绿 → 进入观察期；任一红 → 回滚（见 Step 7）。

- [ ] **Step 1: 首页 200**

Run: `curl.exe -s -o NUL -w "%{http_code}" https://ethernet.bot.cd/`
Expected: `200`。

- [ ] **Step 2: 同域后端 200**

Run: `curl.exe -s -o NUL -w "%{http_code}" https://ethernet.bot.cd/agent/health`
Expected: `200`。

- [ ] **Step 3: SPA 深链回退 200 且为 HTML**

Run: `curl.exe -s -o NUL -w "%{http_code} %{content_type}" https://ethernet.bot.cd/settings`
Expected: `200 text/html`（任意非文件路径都应回 `index.html`）。

- [ ] **Step 4: 发版新鲜度（钉住 Review Focus 第 2 条）**

Run: 对比 Task 2 Step 3 记下的 `index.html` 字节数与
`curl.exe -s https://ethernet.bot.cd/ | Measure-Object -Character` 的字符数是否同量级；
另在浏览器无痕窗口打开确认版本号与本地构建一致。
Expected: 一致（差 HTML 压缩换行属正常，量级差 10 倍即红灯）。

- [ ] **Step 5: 三端真机**

手机（移动数据，钉住 Review Focus 第 3 条）/ 平板 / 电脑各打开
`https://ethernet.bot.cd/`，进聊天发一条消息。
Expected: 三端 200 打开 + 消息收发正常。

- [ ] **Step 6: 旧链路回归**

Run: `curl.exe -s -o NUL -w "%{http_code}" https://ethernet-vps.bot.cd/agent/health`
Expected: `200`（后端旧域名不受影响）。

- [ ] **Step 7: 回滚（仅任一步骤红灯时执行）**

1. DNSHE 把 `ethernet.bot.cd` 改回 CNAME → `sullyos-15n.pages.dev`。
2. 待传播后复测 Task 6 Step 1 为 200 即恢复。
3. Caddy 新块保留不动（不影响回滚后的流量）。
4. 停下并上报红灯步骤的完整输出，不继续。

---

### Task 7: 观察与下线（Task 6 全绿 ≥7 天后，需用户二次确认才执行）

**Files:** Pages / Vercel / 线上旧 Caddy 块。

- [ ] **Step 1: 观察期值守（自动项为空，纯等待）**

条件：Task 6 全绿满 7 天。期间 Pages / Vercel 保留不动。
Expected: 用户明确回复「下线」才可继续，否则本任务永远 pending。

- [ ] **Step 2: 下线（仅收到「下线」指令后）**

1. Cloudflare Pages 项目 `sullyos` 移除自定义域 `ethernet.bot.cd`。
2. Vercel 项目 `sully-os` 保持（隐形 `/api/*` 上游或彻底删除，由届时状态定，先停下问）。
3. 线上 Caddy 旧 `43451695.xyz` 相关块清理（先停下问，逐块确认）。
