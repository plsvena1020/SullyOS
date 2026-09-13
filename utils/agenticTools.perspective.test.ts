import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPerspectiveInterval } from './perspective';
import { runPerspectiveQuery, runPerspectiveSummary, type AgenticToolCtx } from './agenticTools';

const baseCtx: AgenticToolCtx = {
  char: { name: 't', perspectiveEnabled: true },
  userProfile: {} as any,
  realtimeConfig: { perspectiveEnabled: true } as any,
};

beforeEach(() => {
  resetPerspectiveInterval();
  vi.restoreAllMocks();
});

describe('perspective tool gating', () => {
  it('no ctx.perspective -> not_configured without fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await runPerspectiveQuery({ days: 1 }, baseCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('char switch off -> not_enabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await runPerspectiveQuery(
      { days: 1 },
      {
        ...baseCtx,
        char: { name: 't', perspectiveEnabled: false },
        perspective: { endpoint: { baseUrl: 'https://pv.test', token: 'pvc_x' }, days: 7, minIntervalSec: 0, summaryEnabled: false, summaryThreshold: 500 },
      },
    );
    expect(r).toMatchObject({ ok: false, reason: 'not_enabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cooldown enforced', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx: AgenticToolCtx = {
      ...baseCtx,
      perspective: { endpoint: { baseUrl: 'https://pv.test', token: 'pvc_x' }, days: 7, minIntervalSec: 60, summaryEnabled: false, summaryThreshold: 500 },
    };
    await runPerspectiveQuery({ days: 1 }, ctx);
    const r2 = await runPerspectiveQuery({ days: 1 }, ctx);
    expect(r2).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('summary without credential -> not_configured', async () => {
    const r = await runPerspectiveSummary({ days: 1 }, baseCtx);
    expect(r).toMatchObject({ ok: false, reason: 'not_configured' });
  });
});
