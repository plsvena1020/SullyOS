// vps-backend/src/xhs/run.js
// systemd xhs-session.service 入口:读 /opt/sullyos/.env 的配置,起 bridge + collector。
import { readFileSync } from 'node:fs';
import { createSessionStore } from './sessionStore.js';
import { startSessionBridge } from './sessionBridge.js';
import { startCollector } from './camofoxCollector.js';

// 简易 .env 解析(只兜底;systemd 缺省不注入时也能跑)
const envFile = process.env.XHS_ENV_FILE || '/opt/sullyos/.env';
try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch { /* env 由 systemd 注入时无需文件 */ }

const store = createSessionStore({
    sessionKeyHex: process.env.XHS_SESSION_KEY,
    filePath: process.env.XHS_SESSION_FILE || '/var/lib/sullyos-xhs/session/session.json',
});
const collector = startCollector(store);
const bridge = startSessionBridge({
    port: Number(process.env.XHS_BRIDGE_PORT || 8836),
    host: '127.0.0.1',
    token: process.env.XHS_BRIDGE_TOKEN,
    store,
    upstream: process.env.XHS_LITE_UPSTREAM || 'https://sully-proxy.plasmavendorlia.workers.dev',
    collector,
});
await bridge.ready;
console.log('[xhs-run] session bridge + collector started');

const shutdown = () => {
    collector.stop();
    bridge.close().then(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
