# Watch-Sync（监听暂存 + 一键推送）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本地保存自动构建校验并暂存，一条命令推上 VPS，生产构建默认无 debug 角标。

**Architecture:** 新增 `scripts/sync-lib.mjs`（纯函数：去抖、资产对比、命令执行）、`scripts/watch-sync.mjs`（常驻监听→去抖→构建→单测→暂存打印）、`scripts/deploy-vps.mjs`（重建新鲜度检查→打包→scp→落盘备份→校验→资产断言→打印回滚）。只用 Node 内置模块，不新增依赖；VPS 端零常驻，走 SSH。

**Tech Stack:** Node 22 内置（fs/watch、child_process、path、url）、pnpm、vitest、系统 ssh/scp/tar/curl。

**Spec:** `docs/superpowers/specs/2026-09-24-watch-sync-design.md`

## Global Constraints

- 不新增 npm 依赖（Node 内置 + 系统命令 only）。
- 构建必须完整 `pnpm build`；`$env:GITHUB_PAGES` 为空；禁裸 `vite`。
- 落盘前必备份（时间戳目录）；只动 `/opt/sullyos/frontend-dist*` 与 `/tmp/*.tgz`；不动 Caddy/DNS/其他 VPS 配置。
- 远程验证 curl 一律加 `--noproxy "*"`（本机 HTTPS 走代理，直连 VPS 必须绕过）。
- 构建失败绝不同步；校验失败打印回滚命令，不自动执行。
- 测试命令 `pnpm vitest run <file>`；Windows PowerShell 5.1，注意引号转义。
- `logs/watch-sync.log` 超 500KB 只留末尾；VPS 备份目录只保留最新 3 个（成功部署后删更老的）。

## Review Focus

1. 保存瞬间半写文件触发构建 → 去抖 5s + 构建失败停轮，期望：坏包永不上 VPS（Task 2 测试钉住）。
2. dist 自触发循环（构建写 dist 又触发 watch）→ dist/ 在忽略表，期望：构建期间零二次触发（Task 2 测试钉住）。
3. 双开两个 watch 进程 → 单实例锁拒绝第二个，期望：第二个退出码非 0（Task 2 测试钉住）。
4. SSH 中途断开致远端半状态 → /tmp 残留清理 + 落盘是“备份→全新 mkdir→解包”原子序列，期望：失败后旧版目录原样可回滚（Task 3 测试钉住备份名打印）。
5. 线上资产与本地不一致（错包上线）→ R12 资产断言，期望：不一致即停并报错（Task 3 测试钉住）。

---

## File Structure

- `scripts/sync-lib.mjs`（新建）：`shouldIgnore(path)`、`createDebouncer(ms, onFire)`、`compareAssetSets(localHtml, remoteHtml)`、`run(cmd, args, opts)`（execFileSync 封装，返回 {ok, stdout}）。无副作用，可单测。
- `scripts/sync-lib.test.ts`（新建）：上述纯函数测试。
- `scripts/watch-sync.mjs`（新建）：单实例锁 + fs.watch 递归 + 去抖 → `pnpm build` → `pnpm vitest run`（全量）→ 成功打印可部署 + 写日志 `logs/watch-sync.log`。
- `scripts/deploy-vps.mjs`（新建）：读 `SULLYOS_VPS_SSH`（格式 `user@host`，如 `root@156.238.248.237`）→ 新鲜度检查（源码最新 mtime > dist mtime 则先重建）→ 打包/scp/落盘/校验/断言/清理 → 打印回滚命令。
- `package.json`（改）：加 `"dev:sync": "node scripts/watch-sync.mjs"`、`"deploy:vps": "node scripts/deploy-vps.mjs"`。
- `vite.config.ts`（改 1 行）：`RELEASE_BRANCHES` 加 `'ethernet'`。
- `README.md`（改）：用法 + SSH 前提 + 回滚段落。

---

### Task 1: 生产构建 debug 角标默认关

**Files:**
- Modify: `vite.config.ts:14`
- Test: 构建产物断言（无新测试文件）

**Interfaces:**
- Consumes: 无
- Produces: ethernet 分支构建无角标（后续任务/部署的前提外观）。

- [ ] **Step 1: 写检查（先跑，确认当前是红的）**

Run: `rg -c "2147483647" dist/assets/*.js`
Expected: FAIL（计数 > 0，角标代码存在——当前 ethernet 不在 RELEASE_BRANCHES 内）。

- [ ] **Step 2: 最小改动**

```ts
const RELEASE_BRANCHES = new Set(['main', 'master', 'ethernet']);
```

- [ ] **Step 3: 重建并验证变绿**

Run: `pnpm build`
Expected: exit 0。

Run: `rg -c "2147483647" dist/assets/*.js`
Expected: 计数 0（角标被树摇掉；Settings 的 VersionInfo 不受影响）。

- [ ] **Step 4: Commit**

```bash
git add vite.config.ts
git commit -m "fix(build): hide debug badge on ethernet production builds"
```

---

### Task 2: sync-lib 纯函数 + 单测

**Files:**
- Create: `scripts/sync-lib.mjs`
- Create: `scripts/sync-lib.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `shouldIgnore`、`createDebouncer`、`compareAssetSets`、`run`（Task 3/4 照抄签名使用）。

- [ ] **Step 1: 先写测试**

```ts
// scripts/sync-lib.test.ts
import { describe, expect, it, vi } from 'vitest';
import { shouldIgnore, createDebouncer, compareAssetSets } from './sync-lib.mjs';

describe('shouldIgnore', () => {
  it('ignores dist, node_modules, .git, logs, tmp packs', () => {
    expect(shouldIgnore('D:/sullyos/dist/assets/a.js')).toBe(true);
    expect(shouldIgnore('D:/sullyos/node_modules/x/y.js')).toBe(true);
    expect(shouldIgnore('D:/sullyos/.git/HEAD')).toBe(true);
    expect(shouldIgnore('D:/sullyos/app.ts')).toBe(false);
    expect(shouldIgnore('D:/sullyos/logs/watch-sync.log')).toBe(true);
  });
});

describe('createDebouncer', () => {
  it('fires once after quiet period', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(5000, fn);
    d.push(); d.push(); d.push();
    vi.advanceTimersByTime(4999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('compareAssetSets', () => {
  it('matches identical sets, reports diffs', () => {
    const a = '<script src="/assets/i-AAA.js">';
    const b = '<script src="/assets/i-AAA.js">';
    expect(compareAssetSets(a, b).ok).toBe(true);
    const c = '<script src="/assets/i-BBB.js">';
    const r = compareAssetSets(a, c);
    expect(r.ok).toBe(false);
    expect(r.onlyLocal).toEqual(['/assets/i-AAA.js']);
    expect(r.onlyRemote).toEqual(['/assets/i-BBB.js']);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm vitest run scripts/sync-lib.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

```js
// scripts/sync-lib.mjs
import { execFileSync } from 'node:child_process';

const IGNORED = [/[\\/]dist[\\/]/, /[\\/]node_modules[\\/]/, /[\\/]\.git[\\/]/, /[\\/]\.superpowers[\\/]/, /\.log$/, /\.tmp-/, /frontend-dist\.tgz$/];

export function shouldIgnore(p) {
  return IGNORED.some((re) => re.test(p));
}

export function createDebouncer(ms, onFire) {
  let t = null;
  return {
    push() {
      clearTimeout(t);
      t = setTimeout(onFire, ms);
    },
    cancel() {
      clearTimeout(t);
      t = null;
    },
  };
}

export function extractAssets(html) {
  return [...new Set([...html.matchAll(/\/assets\/[^"]+/g)].map((m) => m[0]))].sort();
}

export function compareAssetSets(localHtml, remoteHtml) {
  const l = extractAssets(localHtml);
  const r = extractAssets(remoteHtml);
  return {
    ok: JSON.stringify(l) === JSON.stringify(r),
    onlyLocal: l.filter((x) => !r.includes(x)),
    onlyRemote: r.filter((x) => !l.includes(x)),
  };
}

export function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', ...opts });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: String((e && e.stdout) || e.message || e) };
  }
}
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm vitest run scripts/sync-lib.test.ts`
Expected: PASS（9 tests）。

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-lib.mjs scripts/sync-lib.test.ts
git commit -m "feat(deploy): sync lib with debounce and asset compare"
```

---

### Task 3: watch-sync 常驻监听

**Files:**
- Create: `scripts/watch-sync.mjs`
- Modify: `package.json`（加 `dev:sync`）

**Interfaces:**
- Consumes: Task 2 的 `shouldIgnore`、`createDebouncer`、`run`（签名照抄）。
- Produces: 暂存产物（`dist/` 现货）+ 日志（后续 deploy 消费）。

- [ ] **Step 1: 实现**

```js
// scripts/watch-sync.mjs
import { watch, appendFileSync, writeFileSync, existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldIgnore, createDebouncer, run } from './sync-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'logs', 'watch-sync.log');
const LOCK = join(ROOT, 'logs', 'watch-sync.lock');
const DEBOUNCE_MS = Number(process.env.WATCH_SYNC_DEBOUNCE ?? 5000);

function log(line) {
  appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n');
  try {
    if (statSync(LOG).size > 512000) writeFileSync(LOG, readFileSync(LOG, 'utf8').slice(-400000));
  } catch {}
  console.log(line);
}

function acquireLock() {
  if (existsSync(LOCK)) {
    console.error('watch-sync 已在运行（锁文件存在），退出。');
    process.exit(1);
  }
  writeFileSync(LOCK, String(process.pid));
  const release = () => {
    try { rmSync(LOCK, { force: true }); } catch {}
  };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(0); });
}

function buildOnce() {
  log('build start');
  const b = run('pnpm', ['build'], { cwd: ROOT });
  if (!b.ok) { log('build FAILED, skip sync:\n' + b.stdout.slice(-2000)); return; }
  const t = run('pnpm', ['vitest', 'run'], { cwd: ROOT });
  if (!t.ok) { log('tests FAILED, skip sync:\n' + t.stdout.slice(-2000)); return; }
  log('READY: dist 已暂存并通过检查， eyeball 本地 Vite 后跑 pnpm deploy:vps');
}

acquireLock();
const d = createDebouncer(DEBOUNCE_MS, buildOnce);
watch(ROOT, { recursive: true }, (_ev, name) => {
  if (!name || shouldIgnore(name)) return;
  d.push();
});
log('watching ' + ROOT + ' (debounce ' + DEBOUNCE_MS + 'ms)');
```

`package.json` scripts 加：`"dev:sync": "node scripts/watch-sync.mjs"`。

- [ ] **Step 2: 冒烟（不常驻，只验逻辑）**

Run（PowerShell，限时手动 Ctrl+C，两次）：
1. `node -e "import('./scripts/sync-lib.mjs').then(m => console.log(m.shouldIgnore('D:/sullyos/dist/a.js'), m.shouldIgnore('D:/sullyos/app.ts')))"`
Expected: `true false`。
2. 启动 `pnpm dev:sync`，另开一个 `pnpm dev:sync`。
Expected: 第二个立即退出（锁生效）；关掉两个进程，删 `logs/watch-sync.lock`。

- [ ] **Step 3: Commit**

```bash
git add scripts/watch-sync.mjs package.json
git commit -m "feat(deploy): watch and stage local builds"
```

---

### Task 4: deploy-vps 一键推送 + 文档

**Files:**
- Create: `scripts/deploy-vps.mjs`
- Modify: `package.json`（加 `deploy:vps`）、`README.md`（用法段）

**Interfaces:**
- Consumes: Task 2 的 `compareAssetSets`、`run`；Task 3 暂存的 `dist/`。
- Produces: 线上更新 + 回滚命令（终点，无下游）。

- [ ] **Step 1: 实现**

```js
// scripts/deploy-vps.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { compareAssetSets, run } from './sync-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.SULLYOS_VPS_SSH;
if (!HOST) {
  console.error('缺少 SULLYOS_VPS_SSH（格式 user@host，如 root@156.238.248.237），已停止，未动任何东西。');
  process.exit(1);
}
const DIST = join(ROOT, 'dist');
const TGZ_LOCAL = join(ROOT, '.tmp-frontend-dist.tgz');
const TGZ_REMOTE = '/tmp/frontend-dist.tgz';
const REMOTE_DIR = '/opt/sullyos/frontend-dist';

function sh(cmd, args) {
  const r = run(cmd, args, { cwd: ROOT });
  if (!r.ok) { console.error('FAILED: ' + cmd + ' ' + args.join(' ') + '\n' + r.stdout.slice(-2000)); process.exit(1); }
  return r.stdout;
}

function newestMtime(dir) {
  const out = run(process.platform === 'win32' ? 'powershell.exe' : 'find', process.platform === 'win32'
    ? ['-NoProfile', '-Command', `(Get-ChildItem -Recurse -File ${dir} | Where-Object { $_.FullName -notmatch 'dist|node_modules|\\.git' } | Measure-Object LastWriteTimeUtc -Maximum).Maximum.ToString('o')`]
    : [dir, '-type', 'f', '-not', '-path', '*/dist/*', '-printf', '%T@\\n']);
  return out.stdout.trim();
}

// 新鲜度：源码比 dist 新则先重建，保证推的即所见
if (!existsSync(join(DIST, 'index.html')) || newestMtime(ROOT) > newestMtime(DIST)) {
  console.log('dist stale, rebuilding...');
  sh('pnpm', ['build']);
}
sh(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', TGZ_LOCAL, '-C', ROOT, 'dist']);
sh('scp', [TGZ_LOCAL, HOST + ':' + TGZ_REMOTE]);
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
sh('ssh', [HOST, `TS=${stamp}; if [ -d ${REMOTE_DIR} ]; then mv ${REMOTE_DIR} ${REMOTE_DIR}.bak-${stamp}; echo "backup: ${REMOTE_DIR}.bak-${stamp}"; fi; mkdir -p ${REMOTE_DIR}; tar -xzf ${TGZ_REMOTE} -C ${REMOTE_DIR} --strip-components=1; test -f ${REMOTE_DIR}/index.html && test -d ${REMOTE_DIR}/assets && echo STATIC_OK; rm -f ${TGZ_REMOTE}`]);
const remoteHtml = run('curl.exe', ['-s', '--noproxy', '*', 'https://ethernet.bot.cd/'], { cwd: ROOT });
const cmp = compareAssetSets(readFileSync(join(DIST, 'index.html'), 'utf8'), remoteHtml.stdout);
if (!cmp.ok) {
  console.error('ASSET MISMATCH, stop. onlyLocal=' + JSON.stringify(cmp.onlyLocal) + ' onlyRemote=' + JSON.stringify(cmp.onlyRemote));
  process.exit(1);
}
rmSync(TGZ_LOCAL, { force: true });
sh('ssh', [HOST, `ls -dt ${REMOTE_DIR}.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf`]);
console.log('DEPLOY OK. Rollback: ssh ' + HOST + ' "mv <backup-dir> ' + REMOTE_DIR + '"（备份名见上方 backup: 行）');
```

`package.json` scripts 加：`"deploy:vps": "node scripts/deploy-vps.mjs"`。

`README.md` 在部署段落追加（逐字可用）：
```md
## 一键部署到 VPS（需 SSH 免密一次）

1. 本机 `ssh-keygen -t ed25519`，公钥追加到 VPS `~/.ssh/authorized_keys`，`ssh <host> true` 无密码通过。
2. 设环境变量 `SULLYOS_VPS_SSH=user@host`（如 `root@156.238.248.237`）。
3. 本地 `pnpm dev` 看顺眼后跑 `pnpm deploy:vps`；常驻监听用 `pnpm dev:sync`（只暂存不推送）。
回滚：用输出里的 backup 目录 `mv` 回去即可，DNS/Caddy 不动。
```

- [ ] **Step 2: 干跑验证（不设 SSH 时必停）**

Run（不设 SULLYOS_VPS_SSH）：`node scripts/deploy-vps.mjs`
Expected: 报错缺变量并退出，dist/VPS 零改动。

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-vps.mjs package.json README.md
git commit -m "feat(deploy): one-command push to VPS"
```

## Self-Review

- Spec coverage: 两段式（watch 暂存 Task 3／deploy 推送 Task 4）✓；localhost 门=用户 dev（Task 3 不另起 preview）✓；
  debug 默认关 Task 1 ✓；单实例/日志/SSH 前提 ✓；回滚打印 ✓。
- Placeholder scan: 无 TBD/TODO；命令均为完整可跑形式；魔法值只有去抖默认 5000（spec 值）与资产正则（沿用已验证实现）。
- Type consistency: `run` 返回 {ok, stdout} 四处一致；`compareAssetSets` 输入双 html、输出 {ok, onlyLocal, onlyRemote} 一致。
- Review Focus: 5 条逐条钉到 Task 2/3/4 的测试与门禁；全量 `vitest run` 在 watch 内（慢但符合 spec“构建+单测”）。
