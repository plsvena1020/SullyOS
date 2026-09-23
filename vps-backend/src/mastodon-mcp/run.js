// vps-backend/src/mastodon-mcp/run.js
// systemd 入口：读 /opt/sullyos/.env，起 MCP server（127.0.0.1:8837）。
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createMastodonClient } from './mastodonApi.js';
import { loadAccounts } from './accounts.js';
import { createGuard } from './guard.js';
import { startMastodonMcpServer } from './server.js';

const envFile = process.env.MASTODON_ENV_FILE || '/opt/sullyos/.env';
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* systemd 注入时无需文件 */ }

const accountsFile = process.env.MASTODON_ACCOUNTS_FILE || '/var/lib/sullyos-mastodon/accounts.json';
const accounts = await loadAccounts({ seedJson: process.env.MASTODON_ACCOUNTS || '[]', filePath: accountsFile, readFile });
const guard = createGuard({
  readOnly: process.env.MASTODON_READ_ONLY === '1',
  auditLogPath: process.env.MASTODON_AUDIT_LOG || '/var/lib/sullyos-mastodon/audit.jsonl',
});
const { ready } = startMastodonMcpServer({
  port: Number(process.env.MASTODON_MCP_PORT || 8838),
  host: '127.0.0.1',
  mcpToken: process.env.MASTODON_MCP_TOKEN,
  accounts,
  api: createMastodonClient(),
  guard,
  accountStore: { filePath: accountsFile },
});
const { close } = await ready;
console.log('[mastodon-mcp] listening on 127.0.0.1:8838');
const shutdown = () => close().then(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
