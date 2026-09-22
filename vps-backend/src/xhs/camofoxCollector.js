// vps-backend/src/xhs/camofoxCollector.js
// camofox storage_state 采集:GET /sessions/:userId/storage_state → 域过滤 → sessionStore.save。
// 404(无活动会话,如容器重启后)→ 自动建会话(持久化插件会恢复 storageState)→ 重试一次。
// 失败只 warn,永不 crash 常驻进程;对外接口(startCollector → {collect, stop})与 bridge 的 collector.collect() 契约不变。
const CAMOFOX_BASE = process.env.CAMOFOX_BASE || 'http://127.0.0.1:9377';
const CAMOFOX_API_KEY = process.env.CAMOFOX_API_KEY || '';
const USER_ID = process.env.XHS_CAMOFOX_USER || 'sullyos-xhs';
const SESSION_KEY = process.env.XHS_CAMOFOX_SESSION || 'main';
const START_URL = 'https://www.xiaohongshu.com';
const POLL_MS = Number(process.env.XHS_COLLECT_INTERVAL_MS || 10 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createSession() {
    const resp = await fetch(`${CAMOFOX_BASE}/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: USER_ID, sessionKey: SESSION_KEY, url: START_URL }),
    });
    if (!resp.ok) throw new Error(`create tab http ${resp.status}`);
    await sleep(3000); // 等页面加载(持久化恢复发生在上下文创建时)
}

async function exportStorageState() {
    const resp = await fetch(`${CAMOFOX_BASE}/sessions/${USER_ID}/storage_state`, {
        headers: { authorization: `Bearer ${CAMOFOX_API_KEY}` },
    });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`storage_state http ${resp.status}`);
    return resp.json();
}

async function collectOnce(store) {
    let state = await exportStorageState();
    if (!state) {
        await createSession();
        state = await exportStorageState();
        if (!state) throw new Error('no storage state after session create');
    }
    const cookies = state.cookies || [];
    const saved = await store.save(cookies);
    console.log(`[xhs-collector] collected ${cookies.length} cookies -> version ${saved.version}${saved.skipped ? ' (unchanged)' : ''}`);
}

export function startCollector(store) {
    let running = false;
    const loop = async () => {
        if (running) return;
        running = true;
        try {
            await collectOnce(store);
        } catch (e) {
            const msg = String(e?.message ?? e);
            if (msg.startsWith('MISSING_REQUIRED_COOKIE')) {
                console.warn('[xhs-collector] camofox session logged out (required cookie missing) — keeping last good session');
            } else {
                console.warn(`[xhs-collector] collect failed: ${msg}`);
            }
        } finally {
            running = false;
        }
    };
    loop(); // 启动即采
    const timer = setInterval(loop, POLL_MS);
    return { collect: loop, stop: () => clearInterval(timer) };
}
