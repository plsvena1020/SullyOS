import type { SullyRuntime } from '../types';

export type AppActivitySource = 'sullyos' | 'device';

export interface AppActivitySession {
  id: string;
  deviceId: string;
  platform: SullyRuntime;
  source: AppActivitySource;
  appKey: string;
  appLabel: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  schemaVersion: 1;
}

export type ActivityPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface AppActivityProvider {
  readonly kind: 'sullyos' | 'usage-stats' | 'foreground-process';
  isSupported(): boolean;
  getPermissionState(): Promise<ActivityPermissionState>;
  requestPermission(): Promise<ActivityPermissionState>;
  start(onSession: (session: AppActivitySession) => void): Promise<void>;
  stop(): Promise<void>;
  noteSullyosForeground(appKey: string | null, appLabel: string | null): void;
}
