import type { PlatformCapabilities, SullyRuntime } from './types';

/**
 * 唯一的运行时判定点。
 * 业务代码禁止直接读 Capacitor / __TAURI_INTERNALS__ / userAgent，
 * 必须经本函数或 getCapabilities()。
 */
export function detectRuntime(g: typeof globalThis = globalThis): SullyRuntime {
  const x = g as unknown as Record<string, any>;
  const cap = x?.['Capacitor'];
  if (cap?.isNativePlatform === true && typeof cap?.getPlatform === 'function') {
    try {
      if (cap.getPlatform() === 'android') return 'android';
    } catch {
      // getPlatform 抛错时按 web 处理，不让平台判定掀翻启动链。
    }
  }
  if (x?.['__TAURI_INTERNALS__'] != null) return 'windows';
  return 'web';
}

export function getCapabilities(g: typeof globalThis = globalThis): PlatformCapabilities {
  const runtime = detectRuntime(g);
  if (runtime === 'android') {
    return {
      runtime,
      isNative: true,
      push: 'fcm',
      appActivity: 'usage-stats',
      secureStore: true,
      osNotifications: true,
    };
  }
  if (runtime === 'windows') {
    return {
      runtime,
      isNative: true,
      push: 'none',
      appActivity: 'foreground-process',
      secureStore: true,
      osNotifications: true,
    };
  }
  return {
    runtime: 'web',
    isNative: false,
    push: 'webpush',
    appActivity: 'sullyos',
    secureStore: true,
    osNotifications: true,
  };
}
