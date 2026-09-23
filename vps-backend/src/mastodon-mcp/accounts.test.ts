import { describe, it, expect } from 'vitest';
import { parseAccounts, resolveAccount } from './accounts.js';

describe('accounts', () => {
  it('解析并归一化 instance', () => {
    const list = parseAccounts(JSON.stringify([{ ownerId: 'user', instance: 'https://Mstdn.social/', handle: '@me', accessToken: 't' }]));
    expect(list[0].instance).toBe('mstdn.social');
  });
  it('未知身份抛错', () => {
    expect(() => resolveAccount([], 'ghost')).toThrow('未知身份');
  });
  it('空 ownerId 取默认第 0 个', () => {
    const list = parseAccounts(JSON.stringify([{ ownerId: 'user', instance: 'a.social', handle: '@u', accessToken: 't' }]));
    expect(resolveAccount(list, '').ownerId).toBe('user');
  });
  it('文件账号覆盖同 ownerId 种子', async () => {
    const seed = parseAccounts(JSON.stringify([{ ownerId: 'user', instance: 'a.social', handle: '@u', accessToken: 'old' }]));
    const files: Record<string, string> = { '/run/acc.json': JSON.stringify([{ ownerId: 'user', instance: 'b.social', handle: '@u2', accessToken: 'new' }]) };
    const { loadAccounts, saveAccount } = await import('./accounts.js');
    const merged = await loadAccounts({ seedJson: '', filePath: '/run/acc.json', readFile: (async (p: string) => files[p]) as never, seed });
    expect(merged.find((a) => a.ownerId === 'user')!.accessToken).toBe('new');
    const out: Record<string, string> = {};
    await saveAccount({ filePath: '/run/acc.json', readFile: (async () => '[]') as never, writeFile: (async (p: string, s: string) => { out[p] = s; }) as never, mkdir: (async () => {}) as never, account: { ownerId: 'c1', instance: 'c.social', handle: '@c', accessToken: 't' } });
    expect(JSON.parse(out['/run/acc.json'])[0].ownerId).toBe('c1');
  });
});
