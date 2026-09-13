import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAndroidAppActivity } from './android';

vi.mock('../native', () => ({
  loadCapacitorPlugin: vi.fn(),
  invokeTauri: vi.fn(),
  listenTauri: vi.fn(),
}));

import { loadCapacitorPlugin } from '../native';

const mockPlugin = loadCapacitorPlugin as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).Capacitor = { isNativePlatform: true, getPlatform: () => 'android' };
});

describe('android activity provider', () => {
  it('unsupported outside android shell', async () => {
    (globalThis as any).Capacitor = undefined;
    const p = createAndroidAppActivity();
    expect(p.isSupported()).toBe(false);
    expect(await p.getPermissionState()).toBe('unsupported');
  });

  it('pulls sessions, skips own package', async () => {
    const seen: string[] = [];
    mockPlugin.mockResolvedValue({
      drainSessions: async () => ({
        sessions: [
          { appKey: 'com.tencent.mm', appLabel: 'wechat', startedAt: 1000, endedAt: 2000 },
          { appKey: 'com.aetheros.simulator', appLabel: 'sully', startedAt: 2000, endedAt: 3000 },
        ],
      }),
    });
    const p = createAndroidAppActivity();
    await p.start((s) => seen.push(`${s.appKey}:${s.durationMs}`));
    expect(seen).toEqual(['com.tencent.mm:1000']);
    await p.stop();
  });

  it('denied permission when plugin throws', async () => {
    mockPlugin.mockRejectedValue(new Error('no plugin'));
    const p = createAndroidAppActivity();
    expect(await p.getPermissionState()).toBe('denied');
  });
});
