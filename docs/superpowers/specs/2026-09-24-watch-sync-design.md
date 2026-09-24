# 本地→VPS 监听自动同步设计（watch-sync）

> 创建：2026-09-24。状态：待用户 review。用户已决策：监听自动同步（秒级 HMR 否决，生产入口不跑 dev）。

## 目标

本地改完保存 → 静默 5 秒 → 自动构建 → 构建通过才同步到 VPS → 校验通过算上线。
构建挂了绝不同步坏包。分两段：`pnpm dev:sync` 只构建+校验+暂存（不上 VPS），
你本地 `pnpm dev` 热更新看顺眼后跑 `pnpm deploy:vps` 推一把。全程手动确认点只有这一次回车。

## 非目标

- 不是秒级热更新；不跑 dev 服务器；VPS 端零常驻。
- 不自动回滚 DNS（回滚命令由脚本打印，人工执行）。
- 不处理多人并发编辑（单用户前提）；不同步时不碰 Caddy/DNS/任何线上配置。

## 架构

```
文件变动 → 去抖（静默 5s）→ pnpm build → [挂了：停+报错，不同步]
                                    → [过了：打包→scp→落盘(备份旧版)→校验→资产断言]
                                    → [校验挂：停+打印回滚命令] → 日志
```

- 常驻形态：前台进程 `pnpm dev:sync`，Ctrl+C 停；单实例锁（锁文件，未释放则拒绝二开）。
  每轮产物暂存本地 `dist/`（覆盖即暂存），通过后打印“可部署，回车 `pnpm deploy:vps`”；
  热更新检查以你本机跑的 Vite dev 为准手动看；管线不再另起 preview 服务器，
  机器判据为构建+单测（dev 与生产包分包不同，生产问题仍以构建产物抽查为准）。
- 推送形态：`pnpm deploy:vps` 一次性推暂存产物（打包→scp→落盘备份→校验→资产断言），即 Task 3 已验证流程。
- 监听范围：仓库全量，排除 `dist/`、`node_modules/`、`.git/`、`.superpowers/`、`*.log`；
  监听命中自身日志/临时包不触发（防自激）。
- 实现只用 Node 内置（`node:fs.watch` 递归 + `child_process` 调 ssh/scp/curl），不新增依赖。
- SSH：一次手动免密（本机 `ssh-keygen` + 公钥进 VPS `authorized_keys`），之后全自动。

## 组件

1. `scripts/watch-sync.mjs`（唯一新增源码）：watch → debounce → build → sync → verify → log。
   纯函数抽出 `settleDecision(events)`（去抖判定）与 `compareAssetSets(local, remote)`（R12 断言），
   供单测。
2. `package.json`：加 `dev:sync` 与 `deploy:vps` 两行。README 加一段（用法 + SSH 前提 + 回滚）。
3. 日志：`logs/watch-sync.log`（append，含每次构建/同步结果与备份名）。

## 数据流与错误处理

- 构建失败：打印失败摘要，停止本轮，不上传，VPS 零改动；继续监听下一次保存。
- 上传/落盘失败：VPS 侧只有 `/tmp` 残留可能，脚本自动清理后报错停轮。
- 校验失败（STATIC_OK 缺失 / 资产集合不一致）：停轮，打印回滚命令
  （`mv` 回备份目录 + 重新校验），不自动执行。
- 构建期间的新改动：合并进下一轮（队列折叠，不并行构建）。

## 测试

- `scripts/watch-sync.test.ts`（vitest，fake timers）：去抖 5s 语义（抖动合并、静默后触发一次）；
  `compareAssetSets` 一致/不一致两例。
- 真机验证（人工一次）：touch 一个无关文件 → 观察上线；故意写坏一行 → 观察停轮且 VPS 不变；
  恢复后下一次保存正常同步。由执行人操作， orchestrator 用线上 console 复核。

## 生产构建 debug 默认关

- `vite.config.ts` 的 `RELEASE_BRANCHES` 加 `ethernet`（现只有 main/master，本分支构建全带角标）。
  ethernet 即生产分支（用户已定），加完后 VPS 构建默认无 BuildBadge，Settings 照常显示版本。
- 例外保留：`VITE_SHOW_BUILD_BADGE=1` 仍可强制显示（本地调试用）。

## 前置（用户手动，一次）

1. 本机 `ssh-keygen -t ed25519`（一路回车）。
2. 公钥内容追加到 VPS `~/.ssh/authorized_keys`。
3. 本机 `ssh <vps> true` 无密码通过。
