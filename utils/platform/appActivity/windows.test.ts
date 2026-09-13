import { describe, expect, it, vi } from 'vitest';
import { createWindowsAppActivity } from './windows';

vi.mock('../native', () => ({
  loadCapacitorPlugin: vi.fn(),
  invokeTauri: vi.fn(),
  listenTauri: vi.fn(),
}));

import { listenTauri } from '../native';

const mockListen = listenTauri as unknown as ReturnType<typeof vi.fn>;

describe('windows activity provider', () => {
  it('subscribes activity-session and maps payload', async () => {
    const seen: string[] = [];
    const handlers: Array<(p: any) => void> = [];
    let active = true;
    mockListen.mockImplementation(async (_event: string, cb: (p: any) => void) => {
      handlers.push(cb);
      return () => {
        active = false;
      };
    });
    const p = createWindowsAppActivity();
    await p.start((s) => seen.push(`${s.appKey}:${s.durationMs}`));
    expect(mockListen).toHaveBeenCalledWith('activity-session', expect.any(Function));
    const emit = handlers[0];
    emit({ app_key: 'chrome.exe', app_label: 'chrome.exe', started_at: 1000, ended_at: 4000, duration_ms: 3000 });
    emit({ app_key: '', app_label: '', started_at: 0, ended_at: 0, duration_ms: 0 });
    expect(seen).toEqual(['chrome.exe:3000']);
    await p.stop();
    expect(active).toBe(false);
  });
});
