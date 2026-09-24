// scripts/watch-sync.mjs
import { watch, appendFileSync, writeFileSync, existsSync, rmSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldIgnore, createDebouncer, run } from './sync-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(ROOT, 'logs', 'watch-sync.log');
const LOCK = join(ROOT, 'logs', 'watch-sync.lock');
const DEBOUNCE_MS = Number(process.env.WATCH_SYNC_DEBOUNCE ?? 5000);
try { mkdirSync(join(ROOT, 'logs'), { recursive: true }); } catch {}

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
