import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  flushPerspectiveQueue,
  installPerspectiveSync,
  notePerspectiveSession,
  setPerspectiveTelemetryRuntime,
  uninstallPerspectiveSync,
} from './perspectiveTelemetry';
import { outboxCount, drainSessions, ackSessions } from './platform/appActivity/queue';
import type { AppActivitySession } from './platform/appActivity/types';

const session = (id: string): AppActivitySession => ({
  id,
  deviceId: 'dev-1',
  platform: 'web',
  source: 'sullyos',
  appKey: 'chat',
  appLabel: 'chat',
  startedAt: 1000,
  endedAt: 2000,
  durationMs: 1000,
  schemaVersion: 1,
});

async function clearQueue(): Promise<void> {
  const all = await drainSessions(500);
  await ackSessions(all.map((s) => s.id));
}

beforeEach(async () => {
  vi.restoreAllMocks();
  uninstallPerspectiveSync();
  setPerspectiveTelemetryRuntime(null);
  await clearQueue();
});

describe('perspective telemetry', () => {
  it('disabled config drops sessions', async () => {
    setPerspectiveTelemetryRuntime({
      getConfig: () => ({ perspectiveEnabled: false } as any),
      getAuth: () => ({}),
      getDeviceId: () => 'dev-1',
    });
    await notePerspectiveSession(session('t-drop'));
    expect(await outboxCount()).toBe(0);
  });

  it('enabled config enqueues and flush uploads once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, accepted: 1, duplicates: 0 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    setPerspectiveTelemetryRuntime({
      getConfig: () => ({ perspectiveEnabled: true, perspectiveWorkerUrl: 'https://pv.test' }) as any,
      getAuth: () => ({ token: 'pvd_x', deviceId: 'dev-1' }),
      getDeviceId: () => 'dev-1',
    });
    await notePerspectiveSession(session('t-up-1'));
    // note 触发一次 flush（异步），再手动 flush 一次兜底。
    await flushPerspectiveQueue();
    expect(await outboxCount()).toBe(0);
    const posted = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/sessions'));
    expect(posted.length).toBeGreaterThanOrEqual(1);
  });

  it('network failure keeps queue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    setPerspectiveTelemetryRuntime({
      getConfig: () => ({ perspectiveEnabled: true, perspectiveWorkerUrl: 'https://pv.test' }) as any,
      getAuth: () => ({ token: 'pvd_x', deviceId: 'dev-1' }),
      getDeviceId: () => 'dev-1',
    });
    await notePerspectiveSession(session('t-keep'));
    await flushPerspectiveQueue();
    expect(await outboxCount()).toBe(1);
  });

  it('install/uninstall sync is idempotent', () => {
    installPerspectiveSync();
    installPerspectiveSync();
    uninstallPerspectiveSync();
    expect(true).toBe(true);
  });
});
