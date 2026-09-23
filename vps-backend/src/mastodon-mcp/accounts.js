// vps-backend/src/mastodon-mcp/accounts.js
// 按身份选账号：env 种子 + 运行文件合并（文件优先），upsert 按 ownerId。
export function parseAccounts(jsonText) {
  let raw;
  try { raw = JSON.parse(jsonText || '[]'); } catch { throw new Error('MASTODON_ACCOUNTS 不是合法 JSON'); }
  if (!Array.isArray(raw)) throw new Error('MASTODON_ACCOUNTS 必须是数组');
  return raw.map((a, i) => {
    if (!a?.ownerId || !a?.instance || !a?.accessToken) throw new Error(`MASTODON_ACCOUNTS[${i}] 缺 ownerId/instance/accessToken`);
    return {
      ownerId: String(a.ownerId),
      instance: String(a.instance).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase(),
      handle: String(a.handle ?? ''),
      accessToken: String(a.accessToken),
    };
  });
}

export function resolveAccount(accounts, ownerId) {
  if (!ownerId) {
    if (!accounts.length) throw new Error('MASTODON_ACCOUNTS 为空，先绑账号');
    return accounts[0];
  }
  const hit = accounts.find((a) => a.ownerId === ownerId);
  if (!hit) throw new Error(`未知身份：${ownerId}（accounts 里没有，先在设置里绑定）`);
  return hit;
}

// 运行文件账号存储：env 种子 + 文件合并（文件优先），upsert 按 ownerId。
export async function loadAccounts({ seedJson = '', filePath, readFile, seed = [] } = {}) {
  const base = seed.length ? seed : parseAccounts(seedJson);
  let fromFile = [];
  try {
    const raw = await readFile(filePath, 'utf8');
    fromFile = parseAccounts(raw);
  } catch { /* 文件缺失=只有种子 */ }
  const byOwner = new Map(base.map((a) => [a.ownerId, a]));
  for (const a of fromFile) byOwner.set(a.ownerId, a);
  return [...byOwner.values()];
}

export async function saveAccount({ filePath, readFile, writeFile, mkdir, account }) {
  parseAccounts(JSON.stringify([account])); // 形状校验
  let current = [];
  try { current = parseAccounts(await readFile(filePath, 'utf8')); } catch { /* 新建 */ }
  const byOwner = new Map(current.map((a) => [a.ownerId, a]));
  byOwner.set(account.ownerId, account);
  const dir = filePath.split('/').slice(0, -1).join('/') || '.';
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify([...byOwner.values()], null, 2));
  return account;
}
