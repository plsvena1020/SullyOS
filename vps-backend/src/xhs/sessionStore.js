// vps-backend/src/xhs/sessionStore.js
// XHS 会话存储:storage_state cookie → 域白名单过滤 → AES-256-GCM 加密落盘。
// 零依赖(Node 22 自带 webcrypto);磁盘上永远没有 cookie 明文。
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// endsWith 同时兼容 xiaohongshu.com / .xiaohongshu.com / edith.xiaohongshu.com(Playwright 两形态都会出现)
const ALLOWED_COOKIE_DOMAINS = ['xiaohongshu.com', 'rednote.com'];
const REQUIRED_COOKIE_NAMES = ['a1', 'web_session']; // 中心 worker /api 硬校验项

const subtle = webcrypto.subtle;

const importKey = (keyHex) =>
    subtle.importKey('raw', Buffer.from(keyHex, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);

const encrypt = async (key, plaintext) => {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const buf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    return Buffer.concat([iv, new Uint8Array(buf)]).toString('base64');
};

const decrypt = async (key, b64) => {
    const raw = Buffer.from(b64, 'base64');
    const iv = raw.subarray(0, 12);
    const out = await subtle.decrypt({ name: 'AES-GCM', iv }, key, raw.subarray(12));
    return new TextDecoder().decode(out);
};

const versionOf = async (cookieStr) => {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(cookieStr));
    return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
};

export function createSessionStore({ sessionKeyHex, filePath }) {
    if (!sessionKeyHex || sessionKeyHex.length !== 64) {
        throw new Error('XHS_SESSION_KEY must be 64 hex chars (32 bytes)');
    }
    const keyPromise = importKey(sessionKeyHex);
    // 内存态:最近一次写入的 version(版本单调的参照)。历史版本记录(最近 8 个)用于拒写回归。
    const seenVersions = [];

    const loadDisk = () => {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return null;
        }
    };

    return {
        async save(playwrightCookies) {
            const names = [];
            const parts = [];
            for (const c of playwrightCookies || []) {
                if (!ALLOWED_COOKIE_DOMAINS.some((d) => (c.domain || '').endsWith(d))) continue;
                if (names.includes(c.name)) continue; // 同名去重(取先到的)
                names.push(c.name);
                parts.push(`${c.name}=${c.value}`);
            }
            for (const required of REQUIRED_COOKIE_NAMES) {
                if (!names.includes(required)) throw new Error(`MISSING_REQUIRED_COOKIE:${required}`);
            }
            const cookieStr = parts.join('; ');
            const version = await versionOf(cookieStr);

            const disk = loadDisk();
            if (disk && disk.version === version) {
                return { version, skipped: true };
            }
            // 版本单调:该内容此前写过(是更早的一代) → 拒写,防回退覆盖。
            if (seenVersions.includes(version)) {
                return { version: disk?.version || version, skipped: true };
            }
            const updatedAt = Date.now();
            const encryptedCookie = await encrypt(await keyPromise, cookieStr);
            const payload = { version, updatedAt, cookieNames: names, encryptedCookie };
            const tmp = `${filePath}.tmp`;
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
            fs.renameSync(tmp, filePath);
            if (disk?.version && !seenVersions.includes(disk.version)) seenVersions.push(disk.version);
            seenVersions.push(version);
            if (seenVersions.length > 16) seenVersions.splice(0, seenVersions.length - 16);
            return { version };
        },

        async get() {
            const disk = loadDisk();
            if (!disk || !disk.encryptedCookie) throw new Error('STORE_EMPTY');
            try {
                const cookieStr = await decrypt(await keyPromise, disk.encryptedCookie);
                return { cookieStr, version: disk.version, updatedAt: disk.updatedAt };
            } catch {
                throw new Error('STORE_DECRYPT_FAILED');
            }
        },

        status() {
            const disk = loadDisk();
            if (!disk) return { configured: false, hasRequired: false };
            const fromDisk = disk.cookieNames || [];
            return {
                configured: true,
                version: disk.version,
                updatedAt: disk.updatedAt,
                cookieNames: fromDisk,
                hasRequired: REQUIRED_COOKIE_NAMES.every((n) => fromDisk.includes(n)),
                // 注意:永远不返回 cookieStr / encryptedCookie
            };
        },

        wipe() {
            try { fs.unlinkSync(filePath); } catch { /* 不存在即已清 */ }
            seenVersions.length = 0;
        },
    };
}
