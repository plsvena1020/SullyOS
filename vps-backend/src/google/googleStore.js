// vps-backend/src/google/googleStore.js
// Google refresh token 存储:多账号 refresh → AES-256-GCM 加密落盘。
// 零依赖(Node 22 自带 webcrypto);磁盘上永远没有 refresh 明文。
// 形状照抄 vps-backend/src/xhs/sessionStore.js:importKey/encrypt/decrypt 原样搬。
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

export function createGoogleStore({ sessionKeyHex, filePath }) {
    if (!sessionKeyHex || sessionKeyHex.length !== 64) {
        throw new Error('GOOGLE_SESSION_KEY must be 64 hex chars (32 bytes)');
    }
    const keyPromise = importKey(sessionKeyHex);

    const loadAccounts = async () => {
        let disk;
        try {
            disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return {};
        }
        if (!disk || !disk.encrypted) return {};
        let plaintext;
        try {
            plaintext = await decrypt(await keyPromise, disk.encrypted);
        } catch {
            throw new Error('STORE_DECRYPT_FAILED');
        }
        try {
            const parsed = JSON.parse(plaintext);
            return parsed.accounts || {};
        } catch {
            throw new Error('STORE_DECRYPT_FAILED');
        }
    };

    const writeAccounts = async (accounts) => {
        const encrypted = await encrypt(await keyPromise, JSON.stringify({ accounts }));
        const tmp = `${filePath}.tmp`;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ encrypted }), { mode: 0o600 });
        fs.renameSync(tmp, filePath);
    };

    return {
        async save(account) {
            const accounts = await loadAccounts();
            const updatedAt = Date.now();
            accounts[account.accountId] = {
                accountId: account.accountId,
                email: account.email,
                refreshToken: account.refreshToken,
                scope: account.scope,
                updatedAt,
            };
            await writeAccounts(accounts);
            return { accountId: account.accountId };
        },

        async loadRefresh(accountId) {
            const accounts = await loadAccounts();
            return accounts[accountId]?.refreshToken ?? null;
        },

        async listAccounts() {
            const accounts = await loadAccounts();
            return Object.values(accounts).map(({ accountId, email, scope, updatedAt }) => ({
                accountId,
                email,
                scope,
                updatedAt,
            }));
        },

        async remove(accountId) {
            const accounts = await loadAccounts();
            if (!(accountId in accounts)) return;
            delete accounts[accountId];
            await writeAccounts(accounts);
        },
    };
}
