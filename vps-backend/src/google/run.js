// vps-backend/src/google/run.js
// systemd google-bridge.service 入口:读 GOOGLE_ 前缀配置,起 bridge。
import { readFileSync } from 'node:fs';
import { createGoogleStore } from './googleStore.js';
import { startGoogleBridge } from './googleBridge.js';

// 简易 .env 解析(只兜底;systemd 缺省不注入时也能跑)
const envFile = process.env.GOOGLE_ENV_FILE || '/opt/sullyos/.env';
try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch { /* env 由 systemd 注入时无需文件 */ }

if (!process.env.GOOGLE_SESSION_KEY) throw new Error('GOOGLE_SESSION_KEY is required');
if (!process.env.GOOGLE_BRIDGE_TOKEN) throw new Error('GOOGLE_BRIDGE_TOKEN is required');
if (!process.env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID is required');
if (!process.env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_SECRET is required');

const store = createGoogleStore({
    sessionKeyHex: process.env.GOOGLE_SESSION_KEY,
    filePath: process.env.GOOGLE_SESSION_FILE || '/var/lib/sullyos-google/session/session.json',
});
const bridge = startGoogleBridge({
    port: Number(process.env.GOOGLE_BRIDGE_PORT || 8839),
    host: '127.0.0.1',
    token: process.env.GOOGLE_BRIDGE_TOKEN,
    store,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
});
await bridge.ready;
console.log('[google-run] bridge started');

const shutdown = () => {
    bridge.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
