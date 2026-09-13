import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  __resetPerspectiveTokensForTest,
  __seedPerspectiveTokensForTest,
  ensurePerspectiveDevice,
  ensurePerspectiveRoleToken,
  getPerspectiveRuntimeAuth,
  hasPerspectiveDeviceTokenSync,
  resolvePerspectiveToolConfig,
  revokePerspectiveRoleToken,
} from './perspectiveTokens';
import { __resetPlatformBridgeForTest } from './platform/bridge';

beforeEach(() => {
  vi.restoreAllMocks();
  __resetPerspectiveTokensForTest();
  __resetPlatformBridgeForTest();
});

describe('perspective tokens', () => {
  it('unpaired device returns null without fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensurePerspectiveRoleToken('https://pv.test', 'c1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hasPerspectiveDeviceTokenSync()).toBe(false);
    expect(getPerspectiveRuntimeAuth()).toEqual({});
  });

  it('pair registers device and caches token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, deviceId: 'dev-1', deviceToken: 'pvd_abc' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await ensurePerspectiveDevice('https://pv.test', { pairingCode: 'pair-1' });
    expect(r).toEqual({ deviceId: 'dev-1', deviceToken: 'pvd_abc' });
    expect(hasPerspectiveDeviceTokenSync()).toBe(true);
    expect(getPerspectiveRuntimeAuth()).toEqual({ token: 'pvd_abc', deviceId: 'dev-1' });
  });

  it('pair failure does not cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    expect(await ensurePerspectiveDevice('https://pv.test', { pairingCode: 'bad' })).toBeNull();
    expect(hasPerspectiveDeviceTokenSync()).toBe(false);
  });

  it('role token cached after first issue; revoke clears', async () => {
    __seedPerspectiveTokensForTest({ deviceId: 'dev-1', deviceToken: 'pvd_abc' });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, roleToken: 'pvc_xyz' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensurePerspectiveRoleToken('https://pv.test', 'c1')).toBe('pvc_xyz');
    expect(await ensurePerspectiveRoleToken('https://pv.test', 'c1')).toBe('pvc_xyz');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await revokePerspectiveRoleToken('https://pv.test', 'c1');
    expect(fetchMock).toHaveBeenCalledTimes(2); // 第二次是 DELETE 吊销
  });

  it('resolvePerspectiveToolConfig gates on switches and pairing', async () => {
    const rc: any = {
      perspectiveEnabled: true,
      perspectiveWorkerUrl: 'https://pv.test',
      perspectiveDays: 7,
      perspectiveMinIntervalSec: 60,
    };
    // 全局关
    expect(await resolvePerspectiveToolConfig({ id: 'c1', perspectiveEnabled: true }, { ...rc, perspectiveEnabled: false })).toBeUndefined();
    // 角色关
    expect(await resolvePerspectiveToolConfig({ id: 'c1', perspectiveEnabled: false }, rc)).toBeUndefined();
    // 未配对
    vi.stubGlobal('fetch', vi.fn());
    expect(await resolvePerspectiveToolConfig({ id: 'c1', perspectiveEnabled: true }, rc)).toBeUndefined();
    // 已配对 + 签发成功
    __seedPerspectiveTokensForTest({ deviceId: 'dev-1', deviceToken: 'pvd_abc' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, roleToken: 'pvc_1' }), { status: 200 })),
    );
    const cfg = await resolvePerspectiveToolConfig({ id: 'c1', perspectiveEnabled: true }, rc);
    expect(cfg?.endpoint).toEqual({ baseUrl: 'https://pv.test', token: 'pvc_1' });
  });
});
