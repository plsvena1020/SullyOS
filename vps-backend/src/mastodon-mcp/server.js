// vps-backend/src/mastodon-mcp/server.js
// McpServer 组装 + node:http：Bearer 鉴权 / CORS 预检 / health / 一键绑定 / stateless MCP。
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TOOL_DEFS } from './tools.js';
import { saveAccount } from './accounts.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const CORS_ALLOW = 'Content-Type, Authorization, Mcp-Session-Id';

export function buildMcpServer(ctx) {
  const server = new McpServer({ name: 'sullyos-mastodon', version: '0.1.0' });
  for (const t of TOOL_DEFS) {
    server.registerTool(t.name, {
      description: t.description, inputSchema: t.inputSchema.shape,
      annotations: t.annotations,
    }, async (args) => t.run(ctx, args));
  }
  return server;
}

const normInstance = (s) => String(s).replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

export function startMastodonMcpServer({ port, host = '127.0.0.1', mcpToken, accounts, api, guard, accountStore }) {
  if (!mcpToken) throw new Error('MASTODON_MCP_TOKEN is required');
  const ctx = { api, accounts, guard };
  const mcp = buildMcpServer(ctx);
  const fileFns = accountStore?.readFile
    ? { readFile: accountStore.readFile, writeFile: accountStore.writeFile, mkdir: accountStore.mkdir }
    : { readFile, writeFile, mkdir };
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();
    const finish = (status, body, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
      res.end(body === null ? '' : JSON.stringify(body));
    };
    if (method === 'OPTIONS') {
      const requested = String(req.headers['access-control-request-headers'] || CORS_ALLOW)
        .split(',').map((s) => s.trim()).filter((h) => /^[\w-]+$/.test(h));
      return finish(204, null, {
        'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': requested.length ? requested.join(', ') : CORS_ALLOW,
        'access-control-max-age': '86400',
      });
    }
    if (path === '/api/health' && method === 'GET') {
      return finish(200, { status: 'ok', backend: 'mastodon-mcp', tools: TOOL_DEFS.length });
    }
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const authed = bearer && bearer === mcpToken;
    if (path === '/api/accounts/bind' && method === 'POST') {
      if (!authed) return finish(401, { error: 'unauthorized' });
      if (!accountStore?.filePath) return finish(503, { error: '账号存储未配置' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return finish(400, { error: 'body 不是合法 JSON' }); }
      const { ownerId, instance, accessToken } = body;
      if (!ownerId || !instance || !accessToken) return finish(400, { error: '缺 ownerId/instance/accessToken' });
      try {
        const who = await api.verifyCredentials({ instance: normInstance(instance), accessToken });
        await saveAccount({
          filePath: accountStore.filePath, ...fileFns,
          account: { ownerId: String(ownerId), instance: normInstance(instance), handle: who.acct, accessToken: String(accessToken) },
        });
        return finish(200, { ownerId: String(ownerId), username: who.username, acct: who.acct });
      } catch (e) { return finish(502, { error: `绑定失败：${String(e?.message ?? e).slice(0, 200)}` }); }
    }
    if (path !== '/mcp') return finish(404, { error: 'unknown route' });
    if (!authed) return finish(401, { error: 'unauthorized' });
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8') || '{}';
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(raw));
    } catch (e) { if (!res.headersSent) finish(500, { error: 'mcp internal error' }); }
  });
  const ready = new Promise((resolve) => httpServer.listen(port, host, () => resolve({ close: () => new Promise((r) => httpServer.close(r)) })));
  return { server: httpServer, ready };
}
