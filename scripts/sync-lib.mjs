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
