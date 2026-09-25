import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
// @ts-expect-error VPS 纯 JS 服务无类型声明（同 worker/*/worker.test.ts 惯例）
import { createGoogleStore } from './googleStore.js';

const KEY = 'ab'.repeat(32);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gstore-')), 'session.json');

describe('googleStore', () => {
  it('save 后 loadRefresh 拿回原文，listAccounts 不带 refresh', async () => {
    const store = createGoogleStore({ sessionKeyHex: KEY, filePath: tmpFile() });
    await store.save({ accountId: 'a1', email: 'u@x.com', refreshToken: 'REF', scope: 's' });
    expect(await store.loadRefresh('a1')).toBe('REF');
    const list = await store.listAccounts();
    expect(list[0]).toMatchObject({ accountId: 'a1', email: 'u@x.com' });
    expect((list[0] as any).refreshToken).toBeUndefined();
  });
  it('磁盘无明文', async () => {
    const f = tmpFile();
    const store = createGoogleStore({ sessionKeyHex: KEY, filePath: f });
    await store.save({ accountId: 'a1', email: 'u@x.com', refreshToken: 'REF-SECRET', scope: 's' });
    expect(fs.readFileSync(f, 'utf8')).not.toContain('REF-SECRET');
  });
  it('非法 key 直接 throw', () => {
    expect(() => createGoogleStore({ sessionKeyHex: 'zz', filePath: tmpFile() })).toThrow();
  });
});
