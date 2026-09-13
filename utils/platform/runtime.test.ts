import { describe, expect, it } from 'vitest';
import { shouldRegisterServiceWorker } from './runtime';

describe('service worker split', () => {
  it('web registers', () => {
    expect(shouldRegisterServiceWorker({} as any)).toBe(true);
  });

  it('android does not register', () => {
    expect(
      shouldRegisterServiceWorker({
        Capacitor: { isNativePlatform: true, getPlatform: () => 'android' },
      } as any),
    ).toBe(false);
  });

  it('windows does not register', () => {
    expect(shouldRegisterServiceWorker({ __TAURI_INTERNALS__: {} } as any)).toBe(false);
  });
});
