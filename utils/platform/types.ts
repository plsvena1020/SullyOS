export type SullyRuntime = 'web' | 'android' | 'windows';

export interface PlatformCapabilities {
  runtime: SullyRuntime;
  isNative: boolean;
  push: 'webpush' | 'fcm' | 'none';
  appActivity: 'sullyos' | 'usage-stats' | 'foreground-process';
  secureStore: boolean;
  osNotifications: boolean;
}
