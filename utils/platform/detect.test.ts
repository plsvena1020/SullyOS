import { describe, expect, it } from 'vitest';
import { detectRuntime, getCapabilities } from './detect';

describe('detectRuntime', () => {
  it('plain browser is web', () => {
    expect(detectRuntime({} as any)).toBe('web');
  });

  it('capacitor android is android', () => {
    const g: any = {
      Capacitor: { isNativePlatform: true, getPlatform: () => 'android' },
    };
    expect(detectRuntime(g)).toBe('android');
  });

  it('capacitor non-android stays web', () => {
    const g: any = {
      Capacitor: { isNativePlatform: true, getPlatform: () => 'web' },
    };
    expect(detectRuntime(g)).toBe('web');
  });

  it('tauri internals is windows', () => {
    expect(detectRuntime({ __TAURI_INTERNALS__: {} } as any)).toBe('windows');
  });

  it('capabilities match runtime', () => {
    expect(
      getCapabilities({ Capacitor: { isNativePlatform: true, getPlatform: () => 'android' } } as any).push,
    ).toBe('fcm');
    expect(getCapabilities({ __TAURI_INTERNALS__: {} } as any).push).toBe('none');
    expect(getCapabilities({} as any).push).toBe('webpush');
  });
});
