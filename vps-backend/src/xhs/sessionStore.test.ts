// vps-backend/src/xhs/sessionStore.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionStore } from './sessionStore.js';

const KEY = '0'.repeat(64); // 32 bytes hex
const mkCookies = (a1 = 'a'.repeat(52), session = 'sess-1') => [
    { name: 'a1', value: a1, domain: '.xiaohongshu.com' },
    { name: 'web_session', value: session, domain: '.xiaohongshu.com' },
    { name: 'tracker', value: 'evil', domain: '.evil.com' }, // 域白名单外,必须被过滤
];

const mk = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'xhs-store-'));
    return { dir, store: createSessionStore({ sessionKeyHex: KEY, filePath: path.join(dir, 'session.json') }) };
};

describe('xhs sessionStore', () => {
    it('round-trips allowed cookies and never writes plaintext to disk', async () => {
        const { dir, store } = mk();
        const saved = await store.save(mkCookies());
        expect(saved.version).toBeTruthy();
        const got = await store.get();
        expect(got.cookieStr).toContain('a1=');
        expect(got.cookieStr).toContain('web_session=');
        expect(got.cookieStr).not.toContain('tracker');
        const raw = readFileSync(path.join(dir, 'session.json'), 'utf8');
        expect(raw).not.toContain('web_session=');
        expect(raw).not.toContain('sess-1');
        rmSync(dir, { recursive: true, force: true });
    });

    it('rejects cookie sets missing required names', async () => {
        const { dir, store } = mk();
        await expect(store.save([{ name: 'a1', value: 'x', domain: '.xiaohongshu.com' }]))
            .rejects.toThrow('MISSING_REQUIRED_COOKIE');
        rmSync(dir, { recursive: true, force: true });
    });

    it('is idempotent for identical content and refuses stale overwrite', async () => {
        const { dir, store } = mk();
        await store.save(mkCookies('a'.repeat(52), 'v1'));
        expect((await store.save(mkCookies('a'.repeat(52), 'v1'))).skipped).toBe(true);
        await store.save(mkCookies('b'.repeat(52), 'v2'));
        expect((await store.get()).cookieStr).toContain('b'.repeat(52));
        // 旧版本回归 → 拒写(防采集任务把好会话覆盖回空/旧)
        expect((await store.save(mkCookies('a'.repeat(52), 'v1'))).skipped).toBe(true);
        expect((await store.get()).cookieStr).toContain('b'.repeat(52));
        rmSync(dir, { recursive: true, force: true });
    });

    it('fails deterministically on tampered ciphertext or wrong key', async () => {
        const { dir, store } = mk();
        await store.save(mkCookies());
        const file = path.join(dir, 'session.json');
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        parsed.encryptedCookie = parsed.encryptedCookie.slice(0, -4) + 'AAAA';
        writeFileSync(file, JSON.stringify(parsed));
        await expect(store.get()).rejects.toThrow('STORE_DECRYPT_FAILED');
        const wrongKey = createSessionStore({ sessionKeyHex: 'f'.repeat(64), filePath: file });
        await expect(wrongKey.get()).rejects.toThrow('STORE_DECRYPT_FAILED');
        rmSync(dir, { recursive: true, force: true });
    });

    it('status() never exposes the cookie string', async () => {
        const { dir, store } = mk();
        await store.save(mkCookies());
        const st = store.status();
        expect(st).toHaveProperty('version');
        expect(st).toHaveProperty('cookieNames');
        expect((st as any).cookieStr).toBeUndefined();
        expect(JSON.stringify(st)).not.toContain('sess-1');
        rmSync(dir, { recursive: true, force: true });
    });
});
