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
