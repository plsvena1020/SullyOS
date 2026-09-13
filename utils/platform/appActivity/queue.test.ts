import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { ackSessions, drainSessions, enqueueSession, outboxCount } from './queue';
import type { AppActivitySession } from './types';

const s = (id: string, startedAt: number): AppActivitySession => ({
  id,
  deviceId: 'd1',
  platform: 'web',
  source: 'sullyos',
  appKey: 'chat',
  appLabel: 'chat',
  startedAt,
  endedAt: startedAt + 1000,
  durationMs: 1000,
  schemaVersion: 1,
});

describe('session queue', () => {
  it('drains in startedAt order and acks', async () => {
    await enqueueSession(s('q-b', 2000));
    await enqueueSession(s('q-a', 1000));
    // 同一 id 重复入队不产生重复项。
    await enqueueSession(s('q-a', 1000));
    const got = await drainSessions(10);
    const ids = got.filter((x) => x.id.startsWith('q-')).map((x) => x.id);
    expect(ids).toEqual(['q-a', 'q-b']);
    await ackSessions(['q-a', 'q-b']);
    expect(await outboxCount()).toBe(0);
  });
});
