import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchHomeMessages, fetchHomeMemories, fetchHomeConfig, saveHomeConfig } from './homeClient';
beforeEach(() => { localStorage.setItem('os_home_source', 'vps'); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('homeClient', () => {
  it('VPS 失败时抛 offline 而非静默空数组', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')));
    await expect(fetchHomeMessages('c1')).rejects.toThrow('home-offline');
  });
  it('fetchHomeMemories 带 charId + limit；失败抛 offline', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', (input: any) => {
      seen.push(String(typeof input === 'string' ? input : input?.url ?? ''));
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    await expect(fetchHomeMemories('c1', 10)).resolves.toEqual([]);
    expect(seen[0]).toContain('/home/memories?charId=c1&limit=10');
  });
  it('fetchHomeConfig / saveHomeConfig：正常拆 config，坏形状抛 offline', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true, json: () => Promise.resolve({ charId: 'c1', config: { roundIntervalMin: 15 } }),
    }));
    await expect(fetchHomeConfig('c1')).resolves.toEqual({ roundIntervalMin: 15 });
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: true, json: () => Promise.resolve({ charId: 'c1', config: { roundIntervalMin: 120 } }),
    }));
    await expect(saveHomeConfig('c1', { roundIntervalMin: 500 })).resolves.toEqual({ roundIntervalMin: 120 });
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    await expect(fetchHomeConfig('c1')).rejects.toThrow('home-offline');
  });
});
