# CF Worker 重新部署任务卡（2026-09-11 · CORS 契约统一）

> 背景：CORS 统一改动（提交 `f346179`）已 push、VPS 已部署并验证。CF 侧还有 4 个 worker
> 需要更新到含契约的新代码。本任务卡给「拥有 Cloudflare MCP 工具的会话」执行。
> 全程**只更新代码**，不动 secrets / bindings / routes / cron。

## 目标与文件

| worker（账号内实际名字，先 list 对号入座） | 上传的文件 | 说明 |
|---|---|---|
| amsg | `worker/amsg/worker.bundle.js` | 已是可部署 ESM 产物；`worker/amsg/wrangler.toml` 里 `main` 指向它 |
| instant-push | `worker/instant-push/worker.bundle.js` | CF 面板粘贴版（Deno 版 `worker.deno.bundle.js` 本次不动） |
| post-office | `worker/post-office/worker.bundle.js` | 纯后端（彼方邮局） |
| 中心 worker（自建实例，形如 `sully-proxy.*.workers.dev`） | `worker/index.js` | 单文件 Dashboard 粘贴部署的那份 |

**先列 worker 再动手**：不确定哪个名字对哪个文件时，向用户报告后等确认，不要猜。

## 操作要求

1. 只更新脚本代码；**绝不触碰**：环境变量 / Secrets、D1 绑定、KV 绑定、Cron Triggers、Routes / 自定义域。
2. 经验（2026-09-08）：用 CF API 上传时 metadata 里不写 secret 即保留；写了空 secret 会被 10021 拒。
   MCP 部署工具若要求打包，直接上传上表 `.bundle.js`（已打包）；中心 worker 上传单文件 `worker/index.js`。
3. 不删除再重建 worker（会丢绑定/secrets）。

## 部署后验证（逐项）

- amsg：`GET {workerUrl}/config-check` → 有 `workerVersion` 与 `backgroundJobs:true`
- instant-push：`GET {workerUrl}/version` → 版本 `2026-09-08`
- post-office：`GET {workerUrl}/health` → `{ ok: true }`
- 中心 worker：`OPTIONS /` 带 `Access-Control-Request-Headers: x-future-feature` → 204 且
  `Access-Control-Allow-Headers` 回显 `x-future-feature`（这是契约判据；旧版为固定名单）

验证 URL 用用户设置里存的地址（问用户），不要用仓库默认公共域名。

## 禁止事项

- 不跑 `wrangler deploy`（本机无登录态）、不改 `wrangler.toml`
- 不动 Deno 门面（用户自己贴 Playground 的产物；仓库 `public/amsg-deno-proxy.ts` 已同步，用户需要时自取）
- 不部署 `worker/mcp-proxy`、`worker/opencode-proxy`（属于用户自部署可选件；用户重新贴上即可，代码已更新）

## 执行记录（2026-09-12 完成）

> 执行会话：opencode（无 CF MCP，用用户提供的 API token 走 CF API，token 未落盘）。
> 上传方式：`PUT /accounts/{id}/workers/scripts/{name}?bindings_inherit=strict`，metadata 的
> bindings 全部写 `{"type":"inherit","name":...}`——secrets 不需要读出明文即可原样保留，
> 解析失败会整体拒绝而不是静默丢弃。

- ✅ **sullyos-amsg** ← `worker/amsg/worker.bundle.js`：上传 200。8 条 bindings（6 条 secret +
  D1 `DB` + DO `INSTANT_TICK`）与 cron `* * * * *` 原样保留；`GET /config-check` →
  `backgroundJobs:true`、`workerVersion 2026-09-08`；OPTIONS 任意头回显 204。
- ✅ **instant-push** ← `worker/instant-push/worker.bundle.js`：上传 200；`GET /version` →
  `2026-09-08`；OPTIONS 任意头回显 204。
- ✅ **sully-proxy**（中心 worker）← `worker/index.js`：上传 200；OPTIONS 任意头回显 204 +
  `Max-Age 86400` + `Expose: Mcp-Session-Id`。
- ⏭️ **post-office**：账号内不存在（12 个脚本逐一核对，均无邮局/诗歌代码）；用户确认跳过——
  客户端连的是作者共享实例 `noir2.cc.cd/po`，不归本账号管。
- compatibility_date / flags / observability 上传前后逐项一致；routes / secrets / bindings /
  cron 未动。验证入口为各脚本的 `*.workers.dev` 地址（真实子域不进仓库）。

## 执行记录 · 第二轮（2026-09-12 · 主动消息发图）

> 范围：`gen_image` directive 改动落在 amsg 与 instant-push 两个 bundle；中心 worker /
> post-office 无代码变化，未动。执行会话仍是 opencode，token 取自本机会话存档（未落盘、
> 未打印）。
>
> **重要操作经验（第一轮记录漏了）**：`PUT /workers/scripts/{name}` 上传脚本时，metadata
> 里不写 `compatibility_date` / `compatibility_flags` / `observability` 的话，这三项会被
> **重置为空**。第一轮"上传前后一致"其实是因为当时上传后还走了一次 settings 恢复（或
> 上传 metadata 里带了），只按 metadata `inherit` 传 bindings 是不够的。本轮踩到后已用
> `PATCH /workers/scripts/{name}/settings`（multipart、`settings` JSON 字段）恢复。

- ✅ **sullyos-amsg** ← `worker/amsg/worker.bundle.js`：上传 200；8 条 bindings（inherit）
  原样保留；随后 PATCH settings 恢复 `compatibility_date 2026-01-01` +
  `global_fetch_strictly_public` + 完整 observability；`GET /config-check` →
  `workerVersion 2026-09-12`、`instantChat:true`、`backgroundJobs:true`。
- ✅ **instant-push** ← `worker/instant-push/worker.bundle.js`：上传 200；PATCH settings
  恢复 `compatibility_date 2026-08-08` + observability；`GET /version` → `2026-09-12`。
- ⏭️ sully-proxy / post-office：本轮无代码变化，跳过。

