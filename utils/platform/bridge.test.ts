import { beforeEach, describe, expect, it } from 'vitest';
import { __resetPlatformBridgeForTest, getPlatformBridge } from './bridge';

describe('platform bridge', () => {
  beforeEach(() => __resetPlatformBridgeForTest());

  it('plain globals give web bridge', () => {
    const b = getPlatformBridge({} as any);
    expect(b.runtime).toBe('web');
    expect(b.capabilities.appActivity).toBe('sullyos');
    expect(b.appActivity.kind).toBe('sullyos');
  });

  it('capacitor android globals give android capabilities', () => {
    const b = getPlatformBridge({
      Capacitor: { isNativePlatform: true, getPlatform: () => 'android' },
    } as any);
    expect(b.runtime).toBe('android');
    expect(b.capabilities.push).toBe('fcm');
    expect(b.appActivity.kind).toBe('usage-stats');
  });

  it('tauri globals give windows provider', () => {
    const b = getPlatformBridge({ __TAURI_INTERNALS__: {} } as any);
    expect(b.runtime).toBe('windows');
    expect(b.appActivity.kind).toBe('foreground-process');
  });
});
