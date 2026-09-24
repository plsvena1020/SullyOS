// scripts/sync-lib.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const IGNORED = [/(^|[\\/])dist[\\/]/, /(^|[\\/])node_modules[\\/]/, /(^|[\\/])\.git[\\/]/, /(^|[\\/])\.superpowers[\\/]/, /\.log$/, /\.tmp-/, /frontend-dist\.tgz$/];

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

export function newestMtimeMs(dir) {
  let max = 0;
  const skip = /[\\/]dist[\\/]|[\\/]node_modules[\\/]|[\\/]\.git[\\/]/;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else max = Math.max(max, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return max;
}

export function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
