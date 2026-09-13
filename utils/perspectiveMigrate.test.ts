import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_MIGRATED_KEY,
  needsPerspectiveMigration,
  purgeLegacyDefaultEvents,
  runPerspectiveLegacyMigration,
} from './perspectiveMigrate';

beforeEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.removeItem(LEGACY_MIGRATED_KEY);
  } catch {
    /* ignore */
  }
});

describe('perspective legacy migration', () => {
  it('needs migration only when old endpoint set and new empty', () => {
    expect(needsPerspectiveMigration(undefined)).toBe(false);
    expect(
      needsPerspectiveMigration({ perspectiveSupabaseUrl: 'https://x.supabase.co', perspectiveSupabaseAnonKey: 'k' }),
    ).toBe(true);
    expect(
      needsPerspectiveMigration({
        perspectiveSupabaseUrl: 'https://x.supabase.co',
        perspectiveSupabaseAnonKey: 'k',
        perspectiveWorkerUrl: 'https://pv.test',
      }),
    ).toBe(false);
    expect(needsPerspectiveMigration({ perspectiveSupabaseUrl: 'https://x.supabase.co' })).toBe(false);
  });

  it('purge deletes both tables with legacy auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await purgeLegacyDefaultEvents({ url: 'https://x.supabase.co/', key: 'k' });
    expect(r).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/rest/v1/perspective_events?device_id=eq.default');
    expect((init.headers as Record<string, string>).apikey).toBe('k');
  });

  it('purge failure does not throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(await purgeLegacyDefaultEvents({ url: 'https://x', key: 'k' })).toMatchObject({ ok: false });
  });

  it('run clears local fields once and marks done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const onCleared = vi.fn();
    const rc: any = { perspectiveSupabaseUrl: 'https://x.supabase.co', perspectiveSupabaseAnonKey: 'k' };
    const r1 = await runPerspectiveLegacyMigration(rc, onCleared);
    expect(r1).toEqual({ clearedLegacyConfig: true, purgedRemote: true });
    expect(onCleared).toHaveBeenCalledTimes(1);
    const r2 = await runPerspectiveLegacyMigration(rc, onCleared);
    expect(r2.clearedLegacyConfig).toBe(false);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });
});
