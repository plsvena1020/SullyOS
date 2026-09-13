import { getCapabilities } from './detect';
import { createWebSecureStore } from './secureStore';
import { createWebAppActivity } from './appActivity/web';
import type { AppActivityProvider } from './appActivity/types';
import type { SecureStore } from './secureStore/types';
import type { PlatformCapabilities, SullyRuntime } from './types';

export interface NotificationsBridge {
  supported(): boolean;
  show(title: string, body: string, data?: Record<string, string>): Promise<void>;
}

export interface SullyPlatformBridge {
  runtime: SullyRuntime;
  capabilities: PlatformCapabilities;
  secureStore: SecureStore;
  appActivity: AppActivityProvider;
  notifications: NotificationsBridge;
}

function createWebNotifications(): NotificationsBridge {
  return {
    supported: () => typeof Notification !== 'undefined',
    async show(title, body) {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return;
      new Notification(title, { body });
    },
  };
}

let cached: SullyPlatformBridge | null = null;

/**
 * 平台桥唯一入口。业务代码只允许调用本函数。
 * Android / Windows 的 provider 在壳任务中按 runtime 替换，
 * 在此之前全部回落到 Web 实现，保证纯 Web 行为不变。
 */
export function getPlatformBridge(g: typeof globalThis = globalThis): SullyPlatformBridge {
  if (cached) return cached;
  const capabilities = getCapabilities(g);
  cached = {
    runtime: capabilities.runtime,
    capabilities,
    secureStore: createWebSecureStore(),
    appActivity: createWebAppActivity(),
    notifications: createWebNotifications(),
  };
  return cached;
}

/** 仅测试使用：清除桥缓存。 */
export function __resetPlatformBridgeForTest(): void {
  cached = null;
}
